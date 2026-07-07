// LaTeX — thin app shell. The module tree is declared in mobius.json's
// source_files; the multi-file installer fetches each path and esbuild bundles
// from this entry, resolving the relative imports below at compile time.
//
//   constants.js      — shared scalar constants for projects, storage, chat, and polling
//   theme.js          — the single app stylesheet (CSS)
//   domain.js         — pure + DOM-level path, project, tree, PDF, chat, and log helpers
//   storage.js        — storage shim, project wrapper, online signal, and local snapshots
//   pdf/zoom.js       — pure PDF zoom math helpers
//   build/useBuild.js — source-to-PDF compile state machine and poll loop
//   ui/*.jsx          — one React component per file
//
// Only App lives here: it owns top-level project/file/editor/build/chat state,
// persistence wiring, and mounts the source/PDF/file/chat UI.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CHAT_PANE_MIN_PX,
  DEFAULT_PROJECT_ID,
  FILE_CONTENT_CACHE_LIMIT,
  PROJECT_SYNC_MS,
  PROJECTS_KEY,
  SOURCE_AUTOSAVE_MS,
  SOURCE_SYNC_MS,
} from './constants.js'
import { CSS } from './theme.js'
import {
  clampChatRatio,
  cleanIndexPaths,
  extensionFor,
  isBinaryProjectPath,
  isManagedJsonPath,
  isSafeRelPath,
  isSafeStoragePath,
  isTextProjectPath,
  normalizeProjects,
  parseBuildErrorChips,
  pdfFromBuildStatusForDoc,
  pdfPathForTexDoc,
  projectPrefix,
  uniqueProjectId,
} from './domain.js'
import {
  chatOpenKey,
  chatRatioKey,
  makeProjectStorage,
  makeStorage,
  readActiveProject,
  readChatOpen,
  readChatRatio,
  readFileCache,
  removeFileCache,
  useOnline,
  writeActiveProject,
  writeFileCache,
} from './storage.js'
import { useBuild } from './build/useBuild.js'
import { CodeEditor } from './ui/CodeEditor.jsx'
import { ImagePreview } from './ui/ImagePreview.jsx'
import { PdfPreview } from './ui/PdfPreview.jsx'
import { FileNavPanel } from './ui/FileNavPanel.jsx'
import { ChatPanel } from './ui/ChatPanel.jsx'
import { useModal } from './ui/useModal.jsx'
import { SyncPill } from './ui/SyncPill.jsx'
import { ToolIcon } from './ui/ToolIcon.jsx'
import { ChatBubbleIcon } from './ui/ChatBubbleIcon.jsx'
import { PlayIcon } from './ui/PlayIcon.jsx'
import { BuildingIndicator } from './ui/BuildingIndicator.jsx'

export {
  isSafeRelPath,
  isSafeStoragePath,
  isManagedJsonPath,
  isUserJsonProjectPath,
  normalizeFileCacheSnapshot,
  pdfFromBuildStatusForDoc,
  pdfPathForTexDoc,
} from './domain.js'
export { ZOOM_MAX, ZOOM_MIN, anchoredZoomScroll, clampScale, pinchScale } from './pdf/zoom.js'
export { clampChatRatio, parseBuildErrorChips } from './domain.js'

function signal(name, payload = {}) {
  try { window.mobius?.signal?.(name, payload) } catch {}
}

export function buildErrorKind(log) {
  // Classify a FAILED build for the Reflection signal. buildLog is either one of
  // the app's OWN generated messages (offline / could-not-start / timeout /
  // empty-source) or, for a genuine compile failure, the raw tectonic output.
  // Anchor on the app's own message PREFIXES instead of open substrings: a real
  // compiler log can legitimately contain the words "offline" or "empty" (a
  // package name, a bib entry), and an open `includes('empty')` would then
  // mislabel a real compile error. Anything we don't recognize is 'compile'.
  const text = String(log || '').trim().toLowerCase()
  if (text.startsWith('build timed out')) return 'timeout'
  if (text.startsWith('you are offline')) return 'offline'
  if (text.startsWith('could not start the build') || text.startsWith('build failed to start')) return 'start'
  if (text.startsWith('nothing to compile')) return 'empty'
  return 'compile'
}

// ----------------------------------------------------------------------
// Top-level app.
// ----------------------------------------------------------------------
export default function App({ appId, token }) {
  const rawStorage = useMemo(() => makeStorage(appId, token), [appId, token])
  const [projects, setProjects] = useState([])
  const [projectsReady, setProjectsReady] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const [activeProjectId, setActiveProjectId] = useState(() => readActiveProject(appId))
  const storage = useMemo(() => makeProjectStorage(rawStorage, activeProjectId), [rawStorage, activeProjectId])
  const storagePrefix = storage.prefix
  const online = useOnline()
  const rawModal = useModal()
  const bodyRef = useRef(null)
  // Hydrate files + recent contents from the localStorage snapshot
  // synchronously on first render so an offline reload has SOMETHING
  // to paint before any storage.get() resolves (or returns null
  // offline). The server still gets fetched on mount and overwrites
  // this with the canonical state when online.
  const cached = useMemo(() => readFileCache(appId, activeProjectId), [appId, activeProjectId])
  const [files, setFiles] = useState(() => cached?.index || [])
  // Mirror of `files` for reads inside long-lived async callbacks (the build
  // poll can resolve up to 120s after it captured its closure). Kept in sync
  // below so the closure-stale snapshot never drives an index write.
  const filesRef = useRef(files)
  const [fileCache, setFileCache] = useState(() => cached?.contents || {})
  // True once `files` reflects the server's index this session — either
  // refreshFiles read it back or seeded it online. Until then `files` is
  // only the localStorage snapshot (or empty), which may be stale or
  // missing entries. We refuse to PERSIST files-index.json while this is
  // false: an offline write derived from an unconfirmed list would queue
  // a short/empty index that drains over the server's real one on
  // reconnect (last-write-wins per path) and destroys files. Gating the
  // write — not just guarding after — makes that bad state unreachable.
  const [indexLoaded, setIndexLoaded] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const navHandleRef = useRef(null)
  const navOpenRef = useRef(false)
  useEffect(() => { navOpenRef.current = navOpen }, [navOpen])
  const openNavRef = useRef(null)
  // Modals ride the shell's single-surface nav, which closes the drawer when a
  // modal opens. Wrap the modal API once so any prompt/confirm/alert re-opens
  // the drawer afterward if it was open — e.g. cancelling a rename returns to
  // the drawer instead of leaving it closed.
  const modal = useMemo(() => {
    const wrap = (name) => (...args) => {
      const wasOpen = navOpenRef.current
      return Promise.resolve(rawModal[name](...args)).finally(() => {
        if (wasOpen && openNavRef.current) openNavRef.current()
      })
    }
    return { node: rawModal.node, alert: wrap('alert'), confirm: wrap('confirm'), prompt: wrap('prompt') }
  }, [rawModal])
  const navToggleRef = useRef(null)
  // Restore the file the user was viewing last session so an offline
  // reload opens straight into their work-in-progress (assuming we
  // have its body cached — handled by the cache-first load below).
  const [selectedPath, setSelectedPath] = useState(() => cached?.lastPath || null)
  const [fileContent, setFileContent] = useState('')
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState(null)
  const [fileDirty, setFileDirty] = useState(false)
  const [fileSaving, setFileSaving] = useState(false)
  const fileContentRef = useRef(fileContent)
  const fileDirtyRef = useRef(fileDirty)
  const fileSavingRef = useRef(fileSaving)
  // The in-flight autosave write, so flushDirtyEdits can AWAIT it (not poll a flag).
  const savePromiseRef = useRef(null)
  useEffect(() => { fileContentRef.current = fileContent }, [fileContent])
  useEffect(() => { fileDirtyRef.current = fileDirty }, [fileDirty])
  useEffect(() => { fileSavingRef.current = fileSaving }, [fileSaving])
  // Outbox depth — surfaced by the SyncPill in the header. Refreshed
  // on every storage write (handled inline at each call site below)
  // and on a 10s background poll.
  const [pending, setPending] = useState(0)
  const [chatOpen, setChatOpen] = useState(() => readChatOpen(appId))
  const [chatRatio, setChatRatio] = useState(() => readChatRatio(appId))
  // viewMode: 'source' = CodeMirror editor, 'pdf' = compiled PDF viewer.
  const [viewMode, setViewMode] = useState('source') // 'source' | 'pdf'
  // Desktop split: at >=860px the editor and PDF sit side-by-side (Overleaf's
  // two-pane layout) and the file tree is a persistent rail, so the [Source|PDF]
  // toggle is unnecessary. Below that we stay single-pane + toggle (phone/tablet).
  // Drives only the .tex branch; everything else renders identically at any width.
  const [isWide, setIsWide] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 860px)').matches
      : false
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(min-width: 860px)')
    const onChange = (e) => setIsWide(e.matches)
    setIsWide(mq.matches)
    // addEventListener is the modern API; older Safari only has addListener.
    if (mq.addEventListener) mq.addEventListener('change', onChange)
    else mq.addListener(onChange)
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange)
      else mq.removeListener(onChange)
    }
  }, [])
  // The designated MAIN document — the single root .tex that Build
  // compiles and the PDF view renders. Persisted in main.json and
  // defaulted (below) to the first .tex (preferring files/welcome.tex).
  // null until the index loads + a default is resolved.
  const [mainPath, setMainPath] = useState(null)
  const mainPathRef = useRef(null)
  useEffect(() => { mainPathRef.current = mainPath }, [mainPath])
  const build = useBuild({ appId, token, storage, online, activeProjectId })
  // Derived main-document state. Declared here, right after `build`, because
  // `onFilesMaybeChanged` (further down) reads `mainBuildError` in its dep
  // array; leaving these below that callback put the read in the temporal dead
  // zone and threw on the first render. They only depend on `mainPath` (state,
  // above) and `build.*` (just declared), so this is their earliest valid home.
  //
  // Whether there is a compilable main document. The [Source | PDF] toggle
  // and the Build button are meaningful exactly when one exists — Build
  // always compiles the MAIN file and the PDF view shows its output, so both
  // controls track the main doc, not the currently-open file (Overleaf model).
  const hasMain = !!mainPath
  // The PDF compiled from the MAIN document this session, if any: a
  // { pdf, ver } record (ver is the build token, see useBuild). The PDF view
  // is gated on this so a never-built doc can't show a blank canvas.
  const pdfForMain = (mainPath && build.pdfByDoc[mainPath]) || null
  // Is the main doc currently building / did its last build fail? (build is
  // single-flight in the hook, keyed by buildDoc.)
  const mainBuilding = build.buildStatus === 'building' && build.buildDoc === mainPath
  const mainBuildError = build.buildStatus === 'error' && build.buildDoc === mainPath
  const clearBuildPoll = build.clearPoll
  const seenBuildStatusRef = useRef('')
  const signalReadySentRef = useRef(false)
  const buildStartedAtRef = useRef(0)
  // Bumped on signals that the open file's bytes may have changed underneath us
  // (a chat turn finished — the agent likely rewrote files — or the window
  // regained focus after another device edited them). Binary previews
  // (image / tree-opened PDF) read this so a same-path REWRITE re-fetches fresh
  // bytes; the text editor already revalidates via its own subscription + poll.
  // Deliberately NOT bumped on the 5s timer, so a static preview doesn't flicker.
  const [previewReloadKey, setPreviewReloadKey] = useState(0)
  const bumpPreviewReload = useCallback(() => { setPreviewReloadKey((n) => n + 1) }, [])

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try { localStorage.setItem(chatOpenKey(appId), String(chatOpen)) } catch {}
  }, [appId, chatOpen])

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try { localStorage.setItem(chatRatioKey(appId), String(chatRatio)) } catch {}
  }, [appId, chatRatio])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let next = []
      try {
        next = normalizeProjects(await rawStorage.getFresh(PROJECTS_KEY))
      } catch {
        try { next = normalizeProjects(await rawStorage.get(PROJECTS_KEY)) } catch { next = [] }
      }
      if (next.length === 0) {
        next = [{ id: DEFAULT_PROJECT_ID, name: 'Project 1', createdAt: Date.now() }]
        rawStorage.setJSON(PROJECTS_KEY, next).catch(() => {})
      }
      if (cancelled) return
      setProjects(next)
      setProjectsReady(true)
      setActiveProjectId((current) => {
        const valid = next.some((project) => project.id === current) ? current : DEFAULT_PROJECT_ID
        writeActiveProject(appId, valid)
        return valid
      })
    })()
    return () => { cancelled = true }
  }, [appId, rawStorage])

  const toggleChat = useCallback(() => {
    setChatOpen((open) => {
      // Turning on always spawns a 50/50 split — the divider in the middle —
      // regardless of where a previous drag left it (owner spec).
      if (!open) setChatRatio(0.5)
      return !open
    })
  }, [])

  const beginChatResize = useCallback((event) => {
    event.preventDefault()
    const body = bodyRef.current
    if (!body) return
    const total = body.getBoundingClientRect().height
    if (!total) return
    const startY = event.clientY
    const startRatioPx = total * chatRatio
    const divider = event.currentTarget
    const pointerId = event.pointerId
    divider.setPointerCapture?.(pointerId)
    const onMove = (moveEvent) => {
      // Px-bounded, not fractional: dragging all the way down collapses the
      // chat to exactly the composer pill (CHAT_PANE_MIN_PX) and no smaller;
      // dragging all the way up leaves at least one pill of editor visible.
      const desiredPx = startRatioPx + startY - moveEvent.clientY
      setChatRatio(clampChatRatio(desiredPx, total, CHAT_PANE_MIN_PX))
    }
    // One teardown for every way the drag can end. pointerup is the normal
    // case, but an interrupted drag (incoming notification, system gesture
    // cancel, focus steal) fires pointercancel / lostpointercapture INSTEAD —
    // without handling those the move listener and the pointer capture leak,
    // leaving the divider stuck "grabbing" the pointer. releasePointerCapture
    // throws if the id is no longer captured (e.g. lostpointercapture already
    // released it), so it's guarded.
    const endDrag = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      divider.removeEventListener('lostpointercapture', endDrag)
      try { divider.releasePointerCapture?.(pointerId) } catch {}
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    divider.addEventListener('lostpointercapture', endDrag)
  }, [chatRatio])

  const handleResizeKey = useCallback((event) => {
    const total = bodyRef.current?.getBoundingClientRect().height || 0
    if (!total) return
    // Same px floor as the drag path: Home collapses the chat to exactly the
    // composer pill, End leaves one pill of editor; Arrows step by ~6% but can
    // never cross either floor (clampChatRatio enforces both ends).
    const step = total * 0.06
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setChatRatio((r) => clampChatRatio(r * total + step, total, CHAT_PANE_MIN_PX))
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setChatRatio((r) => clampChatRatio(r * total - step, total, CHAT_PANE_MIN_PX))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setChatRatio(clampChatRatio(0, total, CHAT_PANE_MIN_PX))
    } else if (event.key === 'End') {
      event.preventDefault()
      setChatRatio(clampChatRatio(total, total, CHAT_PANE_MIN_PX))
    }
  }, [])

  // Persist the file-cache snapshot whenever the index, contents, or
  // last-selected path change. Bounded above by FILE_CONTENT_CACHE_LIMIT
  // inside writeFileCache. The path field lets an offline reload land
  // on the file the user was last editing instead of bouncing to the
  // first tree entry.
  useEffect(() => {
    writeFileCache(appId, activeProjectId, files, fileCache, selectedPath)
  }, [appId, activeProjectId, files, fileCache, selectedPath])

  // Keep the ref in lock-step with `files` so async callbacks read the latest.
  useEffect(() => { filesRef.current = files }, [files])
  // Same for selectedPath — the build callback (resolves up to 120s later)
  // must check the CURRENT selection before auto-flipping the viewer.
  const selectedPathRef = useRef(selectedPath)
  useEffect(() => { selectedPathRef.current = selectedPath }, [selectedPath])

  const refreshPending = useCallback(async () => {
    try {
      const n = await storage.pendingCount()
      setPending(n)
    } catch {
      // Leave the previous count alone on transient errors.
    }
  }, [storage])

  // 10s background poll for outbox depth — catches drains the runtime
  // did on its own (online/focus/pageshow events) that we didn't
  // observe directly. Also rerun on online/offline transitions so the
  // pill updates immediately when connectivity flips.
  useEffect(() => {
    refreshPending()
    const id = setInterval(refreshPending, 10000)
    return () => clearInterval(id)
  }, [refreshPending])
  useEffect(() => {
    refreshPending()
  }, [online, refreshPending])

  const closeNav = useCallback(() => {
    try { navHandleRef.current?.close?.() } catch {}
    navHandleRef.current = null
    setNavOpen(false)
  }, [])

  const openNav = useCallback(async () => {
    if (navOpenRef.current) return
    navOpenRef.current = true
    if (window.mobius?.nav?.open) {
      const handle = window.mobius.nav.open('latex-drawer', () => {
        navHandleRef.current = null
        setNavOpen(false)
      })
      navHandleRef.current = handle
      await handle.ready?.catch(() => false)
      if (navHandleRef.current !== handle) return
    }
    setNavOpen(true)
  }, [])
  useEffect(() => { openNavRef.current = openNav }, [openNav])

  const toggleNav = useCallback(() => {
    if (navOpen) closeNav()
    else openNav()
  }, [closeNav, navOpen, openNav])

  useEffect(() => () => {
    try { navHandleRef.current?.close?.() } catch {}
    navHandleRef.current = null
  }, [])

  // Pull the canonical file list out of files-index.json. Falls back
  // to ["files/welcome.tex"] when the index doesn't exist (older
  // install, or the seed didn't apply for some reason). When the
  // runtime is offline, storage.get returns null — we keep whatever
  // we hydrated from the localStorage snapshot rather than blanking
  // the tree.
  const refreshFiles = useCallback(async () => {
    try {
      const idx = await (online ? storage.getFresh('files-index.json') : storage.get('files-index.json'))
      if (Array.isArray(idx)) {
        // De-dup + sort for stable rendering.
        const cleaned = cleanIndexPaths(idx)
        filesRef.current = cleaned
        setFiles(cleaned)
        // The list now reflects the server — UI writes to the index are
        // safe (they'll extend/trim a known-good list, not clobber it).
        setIndexLoaded(true)
        // If the currently-selected file vanished from the index,
        // unselect so the preview pane shows the empty state rather
        // than a stale buffer. Also drop its cache entry so we
        // don't keep a body for a path that's been deleted.
        //
        // BUT never yank the file out from under an active edit: if the user
        // has unsaved changes (dirty) or a save is in flight, a 5s index sync
        // that observes an agent/other-device rename or delete would otherwise
        // blank their buffer (setFileContent('')) and unselect mid-keystroke,
        // silently losing the draft. We leave the selection + buffer intact in
        // that case (the autosave will re-create the file at the path on its
        // next write), matching the selected-file loader's own dirty guard.
        const editingSelected = fileDirtyRef.current || fileSavingRef.current
        if (selectedPath && !cleaned.includes(selectedPath) && !editingSelected) {
          setSelectedPath(null)
          setFileContent('')
          setFileCache((prev) => {
            if (!(selectedPath in prev)) return prev
            const next = { ...prev }
            delete next[selectedPath]
            return next
          })
        }
      } else if (idx === null && !online) {
        // Offline + nothing in storage — keep the hydrated snapshot.
        // The next online refresh reconciles with the server.
        return
      } else {
        // Index missing or malformed — seed it from the welcome file
        // if that exists, otherwise leave empty. Only attempt to
        // re-seed when online; offline we'd just queue a write that
        // collides with whatever lands first when we reconnect.
        if (!online) return
        const probe = await (online ? storage.getFresh('files/welcome.tex') : storage.get('files/welcome.tex'))
        const seed = probe ? ['files/welcome.tex'] : []
        await storage.setJSON('files-index.json', seed)
        filesRef.current = seed
        setFiles(seed)
        // We just wrote the index to the server online, so `files` is
        // now authoritative — UI writes are safe from here.
        setIndexLoaded(true)
      }
    } catch (e) {
      // Don't blank the UI on a transient read failure — just keep
      // the previous list and let the next poll retry.
    }
  }, [storage, selectedPath, online])

  useEffect(() => {
    if (!projectsReady) return
    refreshFiles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsReady, activeProjectId])

  // Auto-select the first file once we have one, so the preview pane
  // isn't blank on first open. Skip `.keep` placeholders — those are
  // folder-existence markers, not real files, and selecting one would
  // show an empty preview pane on first open if the user's only files
  // happen to live inside folders.
  useEffect(() => {
    if (!selectedPath && files.length > 0) {
      const firstReal = files.find((p) => p.endsWith('.tex'))
        || files.find((p) => isTextProjectPath(p))
        || files.find((p) => !p.endsWith('/.keep'))
      if (firstReal) setSelectedPath(firstReal)
    }
  }, [files, selectedPath])

  // Pick a sensible default main document from the current file list:
  // files/welcome.tex if it's present (the canonical seed root), else the
  // first .tex alphabetically, else null.
  const defaultMain = useCallback((list) => {
    if (list.includes('files/welcome.tex')) return 'files/welcome.tex'
    return list.find((p) => p.endsWith('.tex')) || null
  }, [])

  // Resolve the main document once the index is confirmed. Read main.json;
  // honor it if it still points at an existing .tex, otherwise fall back to
  // the default and persist that choice so a future open is stable. Only
  // writes when online + indexLoaded — same gate as every other UI write,
  // so an unconfirmed/offline list never clobbers the server.
  // mainResolvedRef gates the one-shot initial read; mainReady flips true
  // only AFTER that read has decided, so the maintenance effect below
  // can't race the in-flight resolve (which would double-write the same
  // default). The two are separate on purpose: the ref prevents a re-run,
  // the state unblocks the maintenance pass.
  const mainResolvedRef = useRef(false)
  const [mainReady, setMainReady] = useState(false)
  const hydratedProjectRef = useRef(activeProjectId)

  useEffect(() => {
    clearBuildPoll()
    const switchingProject = hydratedProjectRef.current !== activeProjectId
    hydratedProjectRef.current = activeProjectId
    const snapshot = switchingProject ? null : readFileCache(appId, activeProjectId)
    const nextFiles = snapshot?.index || []
    filesRef.current = nextFiles
    selectedPathRef.current = snapshot?.lastPath || null
    fileContentRef.current = ''
    fileDirtyRef.current = false
    fileSavingRef.current = false
    mainPathRef.current = null
    mainResolvedRef.current = false
    seenBuildStatusRef.current = ''
    signalReadySentRef.current = false
    setFiles(nextFiles)
    setFileCache(snapshot?.contents || {})
    setIndexLoaded(false)
    setSelectedPath(snapshot?.lastPath || null)
    setFileContent('')
    setFileLoading(false)
    setFileError(null)
    setFileDirty(false)
    setFileSaving(false)
    setMainPath(null)
    setMainReady(false)
    setPreviewReloadKey((n) => n + 1)
  }, [appId, activeProjectId, clearBuildPoll])

  useEffect(() => {
    if (!indexLoaded || mainResolvedRef.current) return
    mainResolvedRef.current = true
    let cancelled = false
    ;(async () => {
      let stored = null
      try {
        const m = await (online ? storage.getFresh('main.json') : storage.get('main.json'))
        if (m && typeof m === 'object' && typeof m.path === 'string') stored = m.path
      } catch { /* offline / transient — fall through to default */ }
      if (cancelled) return
      const list = filesRef.current
      if (stored && list.includes(stored)) {
        setMainPath(stored)
      } else {
        // No valid stored main — default and persist (best-effort).
        const fallback = defaultMain(list)
        setMainPath(fallback)
        if (fallback && online) {
          storage.setJSON('main.json', { path: fallback }).catch(() => {})
        }
      }
      setMainReady(true)
    })()
    return () => { cancelled = true }
  }, [indexLoaded, storage, online, defaultMain])

  // Keep the main document valid as the file list changes: re-point it at a
  // default if it was deleted/renamed away, or adopt one when a .tex first
  // appears and none is set, so Build + the PDF view never target a vanished
  // (or missing) file. Runs only after the initial resolve has settled.
  useEffect(() => {
    if (!mainReady) return
    if (mainPath && !files.includes(mainPath)) {
      const fallback = defaultMain(files)
      setMainPath(fallback)
      // Persist a valid { path } object, or CLEAR the pointer when no .tex
      // remains — never write the literal `null` (main.json's contract is an
      // object-or-absent, and this mirrors the fallback-guarded write below).
      if (online) {
        if (fallback) storage.setJSON('main.json', { path: fallback }).catch(() => {})
        else storage.remove('main.json').catch(() => {})
      }
    } else if (!mainPath && files.some((p) => p.endsWith('.tex'))) {
      const fallback = defaultMain(files)
      setMainPath(fallback)
      if (fallback && online) storage.setJSON('main.json', { path: fallback }).catch(() => {})
    }
  }, [files, mainPath, mainReady, online, storage, defaultMain])

  // Restore the previous successful build on app entry. A compiled PDF is
  // durable storage, but pdfByDoc is React state and starts empty on every
  // mount; without this hydration the PDF tab says "No PDF yet" until the user
  // rebuilds. Prefer the last build verdict, then fall back to the deterministic
  // files/<stem>.pdf path if it is indexed or directly readable.
  useEffect(() => {
    if (!mainReady || !indexLoaded || !mainPath) return undefined
    if (build.buildStatus === 'building' || build.pdfByDoc[mainPath]) return undefined
    let cancelled = false
    ;(async () => {
      let pdfPath = null
      try {
        const status = await (online ? storage.getFresh('build/status.json') : storage.get('build/status.json'))
        if (cancelled) return
        pdfPath = pdfFromBuildStatusForDoc(status, mainPath)
      } catch {
        // Fall through to probing the deterministic PDF path.
      }

      if (!pdfPath) {
        const candidate = pdfPathForTexDoc(mainPath)
        if (candidate) {
          if (filesRef.current.includes(candidate)) {
            pdfPath = candidate
          } else {
            try {
              const blob = await storage.getBlob(candidate)
              if (cancelled) return
              if (blob) pdfPath = candidate
            } catch {
              // Missing or wrong-kind PDF: leave the view in "No PDF yet".
            }
          }
        }
      }

      if (!cancelled && pdfPath) build.rememberPdf(mainPath, pdfPath)
    })()
    return () => { cancelled = true }
  }, [
    mainReady,
    indexLoaded,
    mainPath,
    files,
    storage,
    build.buildStatus,
    build.pdfByDoc,
    build.rememberPdf,
    online,
  ])

  const syncProjectFromStorage = useCallback(async () => {
    if (!online) return
    await refreshFiles()
    const list = filesRef.current

    try {
      const stored = await storage.getFresh('main.json')
      if (stored && typeof stored === 'object' && typeof stored.path === 'string') {
        if (stored.path !== mainPathRef.current && list.includes(stored.path)) {
          setMainPath(stored.path)
        }
      }
    } catch {
      // Best-effort convergence; the next loop/focus retries.
    }

    try {
      const status = await storage.getFresh('build/status.json')
      const doc = (status && typeof status.target === 'string')
        ? status.target
        : mainPathRef.current
      const pdf = pdfFromBuildStatusForDoc(status, doc)
      if (doc && pdf) {
        const buildKey = `${doc}|${pdf}|${status?.built_at || status?.log || ''}`
        if (seenBuildStatusRef.current !== buildKey) {
          seenBuildStatusRef.current = buildKey
          build.rememberPdf(doc, pdf)
        }
        if (indexLoaded && !filesRef.current.includes(pdf)) {
          const next = cleanIndexPaths([...filesRef.current, pdf])
          filesRef.current = next
          await storage.setJSON('files-index.json', next)
          setFiles(next)
          refreshPending()
        }
      }
    } catch {
      // Best-effort; a missing status file just means no successful build yet.
    }
  }, [
    online,
    refreshFiles,
    storage,
    build.rememberPdf,
    indexLoaded,
    refreshPending,
  ])

  useEffect(() => {
    if (!online) return undefined
    syncProjectFromStorage()
    // The interval syncs project metadata only — it must NOT bump the preview
    // reload, or an open image/PDF would flicker-refetch every 5s. A binary
    // preview only re-fetches on the discrete signals below (focus / tab
    // return), where another device may have rewritten the file.
    const interval = setInterval(syncProjectFromStorage, PROJECT_SYNC_MS)
    const onFocus = () => { syncProjectFromStorage(); bumpPreviewReload() }
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        syncProjectFromStorage()
        bumpPreviewReload()
      }
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [online, syncProjectFromStorage, bumpPreviewReload])

  // Load the selected file's content. Cache-first for first paint, then
  // stale-while-revalidate while online: the editor starts from the
  // local mirror/localStorage snapshot, subscribes to runtime revalidation
  // updates, and periodically asks storage to revalidate the active path.
  // Direct user edits autosave below, so the editor buffer and storage file
  // converge from both directions without a page reload.
  //
  // For binary previews (images, PDF) the dedicated component does
  // its own blob fetch; we just clear textual state and let it render.
  useEffect(() => {
    if (!selectedPath) {
      setFileContent('')
      setFileError(null)
      setFileLoading(false)
      setFileDirty(false)
      return
    }
    if (isBinaryProjectPath(selectedPath)) {
      setFileContent('')
      setFileLoading(false)
      setFileError(null)
      setFileDirty(false)
      return
    }
    let cancelled = false
    const path = selectedPath

    const applyBody = (body) => {
      if (cancelled || selectedPathRef.current !== path) return
      // The user is actively editing this file. Keep their draft; the
      // debounced autosave below owns the next write to storage.
      if (fileDirtyRef.current || fileSavingRef.current) return
      setFileContent(body)
      setFileError(null)
      setFileDirty(false)
      setFileCache((prev) => (prev[path] === body ? prev : { ...prev, [path]: body }))
    }

    const applyMissing = () => {
      if (cancelled || selectedPathRef.current !== path) return
      if (fileDirtyRef.current || fileSavingRef.current) return
      setFileContent('')
      setFileError('File not found — was it deleted?')
      setFileDirty(false)
      setFileCache((prev) => {
        if (!(path in prev)) return prev
        const next = { ...prev }
        delete next[path]
        return next
      })
    }

    const unsubscribe = storage.subscribeText(path, (body) => {
      if (typeof body === 'string') applyBody(body)
      else if (body == null) applyMissing()
    })

    // Cache hit — paint synchronously, then revalidate while online.
    const cachedBody = fileCache[selectedPath]
    let painted = typeof cachedBody === 'string'
    if (typeof cachedBody === 'string') {
      setFileContent(cachedBody)
      setFileError(null)
      setFileLoading(false)
      setFileDirty(false)
    }

    // Cache miss. Offline → show a friendly note rather than the
    // "File not found" misnomer the old code used when storage.get
    // returned null offline. Online → fetch + memoise.
    if (!online && typeof cachedBody !== 'string') {
      setFileContent('')
      setFileError('Not available offline. Open this file once online to cache it.')
      setFileLoading(false)
      setFileDirty(false)
    }

    const readLatest = () => {
      if (!online) return
      if (fileDirtyRef.current || fileSavingRef.current) return
      if (!painted) setFileLoading(true)
      setFileError(null)
      storage.get(path).then((data) => {
        if (cancelled) return
        if (data == null) applyMissing()
        else if (typeof data === 'string') applyBody(data)
        else applyBody(JSON.stringify(data, null, 2))
        painted = true
        setFileLoading(false)
      }).catch((e) => {
        if (!cancelled) {
          setFileError(e.message || 'Could not load file.')
          setFileLoading(false)
          setFileDirty(false)
        }
      })
    }

    readLatest()
    const interval = online
      ? setInterval(() => { readLatest() }, SOURCE_SYNC_MS)
      : null
    const onVisible = () => {
      if (document.visibilityState === 'visible') readLatest()
    }
    window.addEventListener('focus', readLatest)
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      if (interval) clearInterval(interval)
      window.removeEventListener('focus', readLatest)
      document.removeEventListener('visibilitychange', onVisible)
      unsubscribe()
    }
    // fileCache is intentionally omitted: we read it inside the
    // effect, but reacting to its mutations would refire on every
    // memoise and double-fetch. Selection + connectivity are the
    // only triggers we want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, storage, online])

  // Periodically refresh the file index so externally-written changes
  // (the agent in another chat, a sibling tool) show up. Also runs
  // a one-shot refresh whenever the user opens the drawer.
  useEffect(() => {
    if (!navOpen) return
    refreshFiles()
  }, [navOpen, refreshFiles])

  // After-turn refresh + re-fetch of selected file. The chat panel
  // pings this via onFilesMaybeChanged. The app no longer relies on
  // this event for correctness (the source pane and project metadata
  // sync independently while online), but it is a useful immediate nudge
  // after a known server-side edit.
  const onFilesMaybeChanged = useCallback(async () => {
    await syncProjectFromStorage()
    const path = selectedPathRef.current
    if (path && online && isTextProjectPath(path)) {
      // Cache-first read schedules the runtime's online revalidation; the
      // selected-file subscription applies the fresh value when it arrives.
      storage.get(path).catch(() => {})
    }
    // A binary preview (image / tree-opened PDF) doesn't subscribe to storage,
    // so nudge it to re-fetch fresh bytes — the agent may have regenerated a
    // figure or the compiled PDF at the same path during this turn.
    if (online) bumpPreviewReload()
    signal('agent_turn_applied', {
      file_count: filesRef.current.filter((p) => !p.endsWith('/.keep')).length,
      build_error: Boolean(mainBuildError),
    })
  }, [syncProjectFromStorage, storage, online, bumpPreviewReload, mainBuildError])

  // Gate every UI write to files-index.json. Until we've confirmed the
  // index against the server (indexLoaded), `files` may be a stale or
  // empty snapshot; writing a list derived from it would queue an index
  // that drains over the server's real one on reconnect and lose files.
  // Returns true when writing is safe; otherwise tells the user why and
  // returns false so the caller bails before touching storage.
  const ensureIndexWritable = useCallback(async () => {
    if (indexLoaded) return true
    await modal.alert(
      "Your file list hasn't loaded yet. Reconnect (or wait for it to "
        + "sync) before adding or deleting files, so this doesn't "
        + "overwrite work that's already saved.",
      { title: 'File list not ready' },
    )
    return false
  }, [indexLoaded, modal])

  // Set a .tex as the build target (from the drawer's target button or its
  // "…" menu). Routed through the SAME index-confirmed gate as every other
  // storage mutation: until the index has synced from the server, `mainPath`
  // and the file list are only the (possibly stale/empty) localStorage
  // snapshot, so persisting main.json from that state could queue a write that
  // drains over the server's real main pointer on reconnect. We still flip the
  // local selection optimistically once the gate passes; the write then queues
  // through the runtime outbox (offline-safe, last-write-wins per path) exactly
  // like handleCreateFile's index write does.
  const handleSetMain = useCallback(async (path) => {
    if (!isSafeStoragePath(path) || !path.endsWith('.tex')) return
    if (!(await ensureIndexWritable())) return
    setMainPath(path)
    try {
      await storage.setJSON('main.json', { path })
      refreshPending()
    } catch (e) {
      await modal.alert(e.message || String(e), { title: 'Could not set main document' })
    }
  }, [storage, refreshPending, modal, ensureIndexWritable])

  const handleCreateFile = useCallback(async () => {
    if (!(await ensureIndexWritable())) return
    const name = await modal.prompt(
      'File path — e.g. chapter1.tex or notes/draft.md',
      { title: 'New file', placeholder: 'chapter1.tex' },
    )
    if (!name) return
    const clean = name.replace(/^\/+/, '').trim()
    if (!isSafeRelPath(clean)) {
      await modal.alert('Use letters, digits, . - _ / only.', { title: 'Invalid name' })
      return
    }
    const path = `files/${clean}`
    // Derive the new index from the freshest list (filesRef), not the
    // render-time `files` closure: a chat turn or build can have committed an
    // entry since this callback was created, and a whole-array PUT from the
    // stale closure would silently drop it. Same pattern in every index writer.
    if (filesRef.current.includes(path)) {
      await modal.alert(`“${path}” already exists.`, { title: 'Name taken' })
      return
    }
    if (filesRef.current.some((p) => p.startsWith(`${path}/`))) {
      await modal.alert(`A folder named "${clean.split('/').pop()}" already exists here — a file and a folder can't share a name.`, { title: 'Name taken' })
      return
    }
    // Reject when an INTERMEDIATE segment is itself an existing FILE: with a file
    // at "files/css", creating "css/icons.tex" would write it BEHIND the file
    // node (orphaned). Walk every ancestor prefix (excluding the leaf, already
    // checked above) and refuse if it's an exact file entry.
    const segs = path.split('/')
    const fileSet = new Set(filesRef.current)
    for (let i = 2; i < segs.length; i++) {
      const ancestor = segs.slice(0, i).join('/')
      if (fileSet.has(ancestor)) {
        await modal.alert(`A file named "${segs[i - 1]}" already exists here — a file and a folder can't share a name.`, { title: 'Name taken' })
        return
      }
    }
    try {
      await storage.setText(path, '')
      // Merge into the SERVER's current index, not the in-memory snapshot: a
      // concurrent create/delete (another device, or this app's own rapid
      // second mutation before filesRef syncs) could otherwise be clobbered by
      // a whole-array PUT derived from a stale list.
      const fresh = await storage.getFresh('files-index.json')
      const base = Array.isArray(fresh) ? fresh : filesRef.current
      const next = [...new Set([...base, path])].sort()
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      // Seed the cache with the empty body so a subsequent offline
      // reload doesn't show "Not available offline" for a file we
      // just created.
      setFileCache((prev) => ({ ...prev, [path]: '' }))
      setSelectedPath(path)
      closeNav()
      refreshPending()
      signal('item_created', { type: 'file' })
    } catch (e) {
      signal('error', { message: e.message || String(e), source: 'create-file' })
      await modal.alert(e.message || String(e), { title: 'Could not create file' })
    }
  }, [storage, modal, closeNav, refreshPending, ensureIndexWritable])

  const handleCreateFolder = useCallback(async () => {
    if (!(await ensureIndexWritable())) return
    // Folders don't exist on the storage backend until a file lives
    // inside one (no mkdir endpoint). We approximate by creating a
    // placeholder .keep file inside the new folder — it shows in the
    // tree and ensures the path exists.
    const name = await modal.prompt(
      'Folder name — e.g. chapter1 or notes/2026',
      { title: 'New folder', placeholder: 'chapter1' },
    )
    if (!name) return
    const clean = name.replace(/^\/+/, '').replace(/\/+$/, '').trim()
    if (!isSafeRelPath(clean)) {
      await modal.alert('Use letters, digits, . - _ / only.', { title: 'Invalid name' })
      return
    }
    const dir = `files/${clean}`
    // A path can't be both a file and a folder. Mirror handleCreateFile's guard:
    // if a file already uses this name, refuse instead of letting the backend
    // reject the .keep write with an opaque error.
    if (filesRef.current.includes(dir)) {
      await modal.alert(`A file named "${clean.split('/').pop()}" already exists here — a file and a folder can't share a name.`, { title: 'Name taken' })
      return
    }
    // If the folder already exists (its .keep, or any file under it), say so.
    if (filesRef.current.some((p) => p === `${dir}/.keep` || p.startsWith(`${dir}/`))) {
      await modal.alert(`A folder named "${clean.split('/').pop()}" already exists here.`, { title: 'Name taken' })
      return
    }
    // Reject when an INTERMEDIATE segment is itself an existing FILE: with a file
    // at "files/css", creating folder "css/icons" would write "files/css/icons/
    // .keep" BEHIND the file node (orphaned). Walk every ancestor prefix
    // (excluding `dir` itself, already checked) and refuse if it's a file entry.
    const dirSegs = dir.split('/')
    const dirFileSet = new Set(filesRef.current)
    for (let i = 2; i < dirSegs.length; i++) {
      const ancestor = dirSegs.slice(0, i).join('/')
      if (dirFileSet.has(ancestor)) {
        await modal.alert(`A file named "${dirSegs[i - 1]}" already exists here — a file and a folder can't share a name.`, { title: 'Name taken' })
        return
      }
    }
    const path = `${dir}/.keep`
    try {
      await storage.setText(path, '')
      // Merge into the server's current index, not the stale in-memory list.
      const fresh = await storage.getFresh('files-index.json')
      const base = Array.isArray(fresh) ? fresh : filesRef.current
      const next = [...new Set([...base, path])].sort()
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      refreshPending()
      signal('item_created', { type: 'folder' })
    } catch (e) {
      signal('error', { message: e.message || String(e), source: 'create-folder' })
      await modal.alert(e.message || String(e), { title: 'Could not create folder' })
    }
  }, [storage, modal, refreshPending, ensureIndexWritable])

  const handleDeleteFile = useCallback(async (path) => {
    if (!(await ensureIndexWritable())) return
    if (!isSafeStoragePath(path)) {
      await modal.alert('That file path is not valid.', { title: 'Invalid path' })
      return
    }
    const ok = await modal.confirm(
      `Delete “${path}”? This cannot be undone.`,
      { title: 'Delete file', danger: true },
    )
    if (!ok) return
    try {
      await storage.remove(path)
      // Remove from the server's current index, not the stale in-memory list, so
      // a concurrent mutation isn't clobbered by a whole-array PUT.
      const fresh = await storage.getFresh('files-index.json')
      const base = Array.isArray(fresh) ? fresh : filesRef.current
      const next = base.filter((p) => p !== path)
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      // Drop the cached body so a future offline reload doesn't
      // resurrect a deleted file.
      setFileCache((prev) => {
        if (!(path in prev)) return prev
        const ncache = { ...prev }
        delete ncache[path]
        return ncache
      })
      build.forgetDoc(path)
      if (selectedPath === path) {
        // Prefer a real file over a `.keep` placeholder for the
        // post-delete selection — landing on .keep would show a
        // blank preview pane.
        const nextReal = next.find((p) => !p.endsWith('/.keep'))
        setSelectedPath(nextReal || null)
      }
      refreshPending()
      signal('item_deleted', { type: 'file' })
    } catch (e) {
      signal('error', { message: e.message || String(e), source: 'delete-file' })
      await modal.alert(e.message || String(e), { title: 'Could not delete' })
    }
  }, [selectedPath, storage, modal, refreshPending, ensureIndexWritable, build])

  // ---- Upload (files + whole folders) ------------------------------------
  // The browser hands us a FileList; each entry has either a plain `name`
  // (file picker) or a `webkitRelativePath` like "thesis/ch1/intro.tex"
  // (folder picker). We PUT each under files/<that path> — the storage PUT
  // creates parent dirs — then update files-index.json ONCE (merge + sort)
  // after all writes land, rather than per-file, so a 50-file folder upload
  // doesn't queue 50 index writes that race each other.
  const uploadFiles = useCallback(async (fileList, { asFolder } = {}) => {
    if (!(await ensureIndexWritable())) return
    const items = Array.from(fileList || [])
    if (items.length === 0) return
    const added = []
    const failed = []
    let textCount = 0
    let binaryCount = 0
    for (const f of items) {
      // Folder picker preserves the relative path; file picker gives just a
      // name. Normalise leading slashes and validate against the server's
      // own _SAFE_RE so a PUT can't 4xx on a stray character.
      const rel = ((asFolder && f.webkitRelativePath) || f.name || '')
        .replace(/^\/+/, '')
        .trim()
      if (!isSafeRelPath(rel)) {
        failed.push(f.name || rel || '(unnamed)')
        continue
      }
      const path = `files/${rel}`
      try {
        // Read as text when it looks textual, else as a data-bearing blob.
        // The storage PUT helper sends text/plain; binary round-trips fine
        // as the raw bytes (images/PDFs the user drags in).
        const isText = /\.(tex|md|txt|bib|cls|sty|json|csv|log|markdown)$/i.test(rel)
        if (isText) {
          const text = await f.text()
          await storage.setText(path, text)
          setFileCache((prev) => ({ ...prev, [path]: text }))
          textCount += 1
        } else {
          // Non-text: PUT the raw blob. We deliberately don't cache the body
          // (binary previews fetch on demand) — same policy as the existing
          // image/pdf path.
          await storage.setBlob(path, f, { contentType: f.type || 'application/octet-stream' })
          binaryCount += 1
        }
        added.push(path)
      } catch (e) {
        failed.push(rel)
      }
    }
    if (added.length) {
      try {
        // Merge the uploaded paths into the server's current index, not the
        // stale in-memory list, so a concurrent mutation isn't clobbered.
        const fresh = await storage.getFresh('files-index.json')
        const base = Array.isArray(fresh) ? fresh : filesRef.current
        const next = [...new Set([...base, ...added])].sort()
        await storage.setJSON('files-index.json', next)
        setFiles(next)
      } catch (e) {
        signal('error', { message: e.message || String(e), source: 'upload-index' })
        await modal.alert(e.message || String(e), { title: 'Upload saved but index update failed' })
      }
      refreshPending()
    }
    signal('file_uploaded', { count: added.length, text_count: textCount, binary_count: binaryCount })
    if (failed.length) {
      await modal.alert(
        `Couldn't upload ${failed.length} item(s): ${failed.slice(0, 6).join(', ')}`
          + (failed.length > 6 ? '…' : ''),
        { title: 'Some uploads failed' },
      )
    }
  }, [storage, modal, refreshPending, ensureIndexWritable])

  // ---- Move / rename (drag-to-move + context-menu rename) ----------------
  // Both go through POST /storage/apps/{id}/move {from, to}. The index is a
  // flat list of FILE paths; a move of a file replaces its one entry, a move
  // of a folder replaces every entry whose path is under it. We re-derive the
  // index by string-prefix rewrite, then persist once.
  const movePath = useCallback(async (from, to) => {
    if (from === to) return
    if (!(await ensureIndexWritable())) return
    if (!isSafeStoragePath(from) || !isSafeStoragePath(to)) {
      await modal.alert('Use letters, digits, . - _ / only.', { title: 'Invalid name' })
      return
    }
    // Reject a no-op or a move of a folder into itself/its own subtree.
    if (to === from || to.startsWith(`${from}/`)) {
      await modal.alert('Cannot move an item into itself.', { title: 'Invalid move' })
      return
    }
    try {
      const r = await fetch(`/api/storage/apps/${appId}/move`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: storage.key(from), to: storage.key(to) }),
      })
      if (!r.ok) {
        let detail = ''
        try { detail = (await r.json()).detail || '' } catch { /* non-JSON */ }
        if (r.status === 409) {
          await modal.alert('Something already exists at the destination.', { title: 'Move failed' })
        } else {
          await modal.alert(`Move failed (${r.status}${detail ? `: ${detail}` : ''}).`, { title: 'Move failed' })
        }
        return
      }
      // Rewrite every index entry under `from` (covers both a single file and
      // a whole folder subtree) to its new prefix.
      const rewrite = (p) => {
        if (p === from) return to
        if (p.startsWith(`${from}/`)) return to + p.slice(from.length)
        return p
      }
      // Apply the rename to the server's current index, not the stale in-memory
      // list, so a concurrent mutation isn't clobbered by a whole-array PUT.
      const fresh = await storage.getFresh('files-index.json')
      const base = Array.isArray(fresh) ? fresh : filesRef.current
      const next = [...new Set(base.map(rewrite))].sort()
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      // Carry the cached body + selection + pdf mapping across the rename.
      setFileCache((prev) => {
        const out = {}
        for (const [p, v] of Object.entries(prev)) out[rewrite(p)] = v
        return out
      })
      setSelectedPath((cur) => (cur ? rewrite(cur) : cur))
      // Re-key the built-PDF map through the SAME rewrite so a folder rename
      // keeps the compiled PDFs for files inside it (the move route relocated
      // them with the folder). forgetDoc(from) only dropped an exact-key match,
      // so a folder rename (keys are children, not `from`) silently lost them.
      build.rewriteDocs(rewrite)
      // The main document follows a rename/move of itself or its parent
      // folder, and is re-persisted so Build keeps targeting the right file.
      if (mainPathRef.current) {
        const nextMain = rewrite(mainPathRef.current)
        if (nextMain !== mainPathRef.current) {
          setMainPath(nextMain)
          storage.setJSON('main.json', { path: nextMain }).catch(() => {})
        }
      }
      refreshPending()
    } catch (e) {
      signal('error', { message: e.message || String(e), source: 'move-path' })
      await modal.alert(e.message || String(e), { title: 'Move failed' })
    }
  }, [appId, token, storage, modal, refreshPending, ensureIndexWritable, build])

  // Rename = move to a sibling path with a new leaf. We prompt for the new
  // leaf name and keep the same parent dir.
  const handleRename = useCallback(async (path) => {
    const parts = path.split('/')
    const leaf = parts[parts.length - 1]
    const parent = parts.slice(0, -1).join('/')
    const nextLeaf = await modal.prompt(
      'New name',
      { title: 'Rename', placeholder: leaf, defaultValue: leaf },
    )
    if (!nextLeaf) return
    const clean = nextLeaf.replace(/^\/+/, '').replace(/\/+$/, '').trim()
    if (!clean || clean === leaf) return
    // Rename is an in-place LEAF change, not a move. An embedded slash would
    // re-parent the item (or a whole folder subtree) into a different
    // directory — surprising from a "New name" prompt. Re-parenting is the
    // job of explicit drag-to-move; reject slashes here.
    if (clean.includes('/')) {
      await modal.alert('A name can\'t contain “/”. Drag the item to move it.', { title: 'Invalid name' })
      return
    }
    const to = parent ? `${parent}/${clean}` : clean
    await movePath(path, to)
  }, [modal, movePath])

  // ---- Folder delete (recursive) -----------------------------------------
  const handleDeleteFolder = useCallback(async (folderPath) => {
    if (!(await ensureIndexWritable())) return
    if (!isSafeStoragePath(folderPath)) {
      await modal.alert('That folder path is not valid.', { title: 'Invalid path' })
      return
    }
    const ok = await modal.confirm(
      `Delete the folder “${folderPath}” and everything inside it? This cannot be undone.`,
      { title: 'Delete folder', danger: true },
    )
    if (!ok) return
    // folderPath is "files/<sub...>"; the recursive route wants the path
    // relative to the app root, which is exactly that string.
    try {
      const r = await fetch(`/api/storage/apps/${appId}/folder/${storage.key(folderPath)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok && r.status !== 404) {
        let detail = ''
        try { detail = (await r.json()).detail || '' } catch { /* non-JSON */ }
        await modal.alert(`Could not delete folder (${r.status}${detail ? `: ${detail}` : ''}).`, { title: 'Delete failed' })
        return
      }
      // Drop every index entry under the folder, plus the cache + selection.
      const under = (p) => p === folderPath || p.startsWith(`${folderPath}/`)
      // Remove from the server's current index, not the stale in-memory list, so
      // a concurrent mutation isn't clobbered by a whole-array PUT.
      const fresh = await storage.getFresh('files-index.json')
      const base = Array.isArray(fresh) ? fresh : filesRef.current
      const next = base.filter((p) => !under(p))
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      setFileCache((prev) => {
        const out = {}
        for (const [p, v] of Object.entries(prev)) if (!under(p)) out[p] = v
        return out
      })
      setSelectedPath((cur) => {
        if (cur && under(cur)) return next.find((p) => !p.endsWith('/.keep')) || null
        return cur
      })
      // Drop the built-PDF mappings for the .tex files inside the deleted
      // folder (forgetDoc only matched a single exact key).
      build.forgetUnder(folderPath)
      refreshPending()
      signal('item_deleted', { type: 'folder' })
    } catch (e) {
      signal('error', { message: e.message || String(e), source: 'delete-folder' })
      await modal.alert(e.message || String(e), { title: 'Delete failed' })
    }
  }, [appId, token, storage, modal, refreshPending, ensureIndexWritable, build])

  const selectedExt = selectedPath ? extensionFor(selectedPath) : ''
  const selectedIsBinary = selectedPath ? isBinaryProjectPath(selectedPath) : false
  const canEditSelected = !!selectedPath && !selectedIsBinary && !fileLoading && !fileError
  const selectedIsTex = selectedExt === 'tex'

  // Dismissible error chips: parsed from buildLog '! ' lines when build failed.
  const [dismissedChips, setDismissedChips] = useState([])
  const errorChips = useMemo(() => {
    if (!mainBuildError) return []
    return parseBuildErrorChips(build.buildLog).filter((c) => !dismissedChips.includes(c))
  }, [mainBuildError, build.buildLog, dismissedChips])
  const dismissChip = useCallback((chip) => {
    setDismissedChips((prev) => [...prev, chip])
  }, [])
  // Reset dismissed chips whenever a new build starts so stale dismissals
  // don't carry over into the next error set.
  useEffect(() => {
    if (build.buildStatus === 'building') setDismissedChips([])
  }, [build.buildStatus])

  // quickActions passed to window.mobius.chat: context-aware chips that appear
  // in the embedded chat's empty state. Only "Fix compilation errors" when in
  // error state; the other two are always present.
  const quickActions = useMemo(() => {
    const actions = []
    if (mainBuildError) {
      actions.push({ label: 'Fix compilation errors', prompt: 'Fix the compilation errors in the build log.' })
    }
    actions.push({ label: 'Continue my document', prompt: 'Continue writing the document where it left off.' })
    actions.push({ label: 'Add a section', prompt: 'Add a new section to the document.' })
    return actions
  }, [mainBuildError])

  // getContext: supplies the agent with current app state so it can act without
  // asking clarifying questions. Passed to both the split and fallback chat paths.
  const getContext = useCallback(() => {
    const buildError = mainBuildError && build.buildLog
      ? build.buildLog.slice(0, 500)
      : null
    return Promise.resolve({
      openFile: selectedPath || null,
      viewMode,
      buildStatus: build.buildStatus,
      buildError,
      mainFile: mainPath || null,
    })
  }, [selectedPath, viewMode, build.buildStatus, build.buildLog, mainBuildError, mainPath])

  // ── Signals ──────────────────────────────────────────────────────────────
  // Fire app_ready once the file index has loaded. item_count = file count.
  useEffect(() => {
    if (!indexLoaded || signalReadySentRef.current) return
    signalReadySentRef.current = true
    try {
      if (window.mobius?.signal) {
        window.mobius.signal('app_ready', { item_count: files.length })
      }
    } catch (e) {}
  }, [indexLoaded, files.length])

  // Fire build_succeeded / build_failed when the build status transitions.
  const prevBuildStatusRef = useRef(build.buildStatus)
  useEffect(() => {
    const prev = prevBuildStatusRef.current
    const cur = build.buildStatus
    prevBuildStatusRef.current = cur
    if (prev === 'building' && cur === 'done') {
      signal('build_succeeded', { duration_ms: Math.max(0, Date.now() - buildStartedAtRef.current) })
    } else if (prev === 'building' && cur === 'error') {
      signal('build_failed', {
        duration_ms: Math.max(0, Date.now() - buildStartedAtRef.current),
        error_kind: buildErrorKind(build.buildLog),
      })
    }
  }, [build.buildStatus, build.buildLog])
  // ── /Signals ─────────────────────────────────────────────────────────────

  // Reset the viewer to source whenever the user switches files, so opening a
  // file always lands on its editable source rather than the (whole-document)
  // PDF. The toggle stays available so they can flip back to the PDF.
  useEffect(() => {
    setViewMode('source')
  }, [selectedPath])

  // When the MAIN doc's build finishes, flip the viewer to PDF and make the
  // new .pdf visible in the tree by adding it to files-index.json if missing.
  // Only writes the index when it's safe to (indexLoaded) — same gate as every
  // other UI index write, so an unconfirmed list never clobbers the server's.
  const onBuildDone = useCallback(async (doc, pdfPath) => {
    // Show the freshly-built PDF if it's the main doc we just compiled.
    if (doc === mainPathRef.current) setViewMode('pdf')
    if (!pdfPath || !indexLoaded || !isSafeStoragePath(pdfPath)) return
    // The build can finish up to 120s after it started, so `files` captured
    // in this callback's closure may be stale (a chat turn or upload added an
    // entry meanwhile). Read the freshest list from the ref, merge the new
    // PDF, and persist once.
    const cur = filesRef.current
    if (cur.includes(pdfPath)) return
    const next = [...cur, pdfPath].sort()
    try {
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      refreshPending()
    } catch (e) {
      // Non-fatal: the PDF still renders from its known path; it just won't
      // appear as a tree entry until the next index refresh.
    }
  }, [indexLoaded, storage, refreshPending])

  const handleEditorChange = useCallback((value) => {
    setFileContent(value)
    setFileDirty(true)
    if (selectedPath) {
      setFileCache((prev) => ({ ...prev, [selectedPath]: value }))
    }
  }, [selectedPath])

  useEffect(() => {
    // Never autosave an app-owned JSON record as text/plain — that corrupts it
    // for typed-JSON readers. User project files under files/ remain editable.
    if (!selectedPath || selectedIsBinary || isManagedJsonPath(selectedPath) || !fileDirty) return undefined
    const path = selectedPath
    const body = fileContent
    const timer = setTimeout(() => {
      if (selectedPathRef.current !== path) return
      setFileSaving(true)
      // Publish the in-flight write so flushDirtyEdits can await it before a
      // project switch/create resets the buffer — otherwise keystrokes typed
      // during this 700ms-debounced write are lost (the flush would resolve
      // against a stale snapshot).
      const p = storage.setText(path, body).then(() => {
        if (selectedPathRef.current !== path) return
        setFileCache((prev) => ({ ...prev, [path]: body }))
        if (fileContentRef.current === body) setFileDirty(false)
        refreshPending()
      }).catch((e) => {
        if (selectedPathRef.current === path) {
          setFileError(e.message || 'Could not save file.')
        }
      }).finally(() => {
        if (selectedPathRef.current === path) setFileSaving(false)
        if (savePromiseRef.current === p) savePromiseRef.current = null
      })
      savePromiseRef.current = p
    }, SOURCE_AUTOSAVE_MS)
    return () => clearTimeout(timer)
  }, [
    selectedPath,
    selectedIsBinary,
    fileDirty,
    fileContent,
    storage,
    refreshPending,
  ])

  const handleSaveFile = useCallback(async () => {
    // App-owned JSON records are read-only in the editor — skip the text/plain
    // write that would corrupt them for typed-JSON readers.
    if (!selectedPath || selectedIsBinary || isManagedJsonPath(selectedPath) || fileSaving) {
      return savePromiseRef.current
    }
    setFileSaving(true)
    setFileError(null)
    const p = (async () => {
      try {
        await storage.setText(selectedPath, fileContent)
        setFileDirty(false)
        setFileCache((prev) => ({ ...prev, [selectedPath]: fileContent }))
        refreshPending()
      } catch (e) {
        setFileError(e.message || 'Could not save file.')
      } finally {
        setFileSaving(false)
        savePromiseRef.current = null
      }
    })()
    savePromiseRef.current = p
    return p
  }, [selectedPath, selectedIsBinary, fileSaving, storage, fileContent, refreshPending])

  // Persist the editor's LATEST text before a reset (project switch/create)
  // throws away the dirty buffer. A debounced autosave may have a write in
  // flight; BOTH it and handleSaveFile publish their write to savePromiseRef,
  // so we await that, THEN write fileContentRef.current DIRECTLY. We do not
  // route through handleSaveFile here: it no-ops while fileSaving and captures a
  // possibly-stale fileContent closure, whereas the in-flight autosave only
  // persisted its 700ms-old snapshot — anything typed since lives in
  // fileContentRef.current and must be saved before resetFileUi wipes it.
  const flushDirtyEdits = useCallback(async () => {
    if (!canEditSelected) return
    const path = selectedPathRef.current
    if (!path || selectedIsBinary || isManagedJsonPath(path)) return
    if (savePromiseRef.current) { try { await savePromiseRef.current } catch { /* error surfaced by the in-flight write */ } }
    if (fileDirtyRef.current) {
      await storage.setText(path, fileContentRef.current)
      setFileCache((prev) => ({ ...prev, [path]: fileContentRef.current }))
      setFileDirty(false)
    }
  }, [canEditSelected, selectedIsBinary, storage])

  const resetFileUi = useCallback(() => {
    clearBuildPoll()
    filesRef.current = []
    selectedPathRef.current = null
    fileContentRef.current = ''
    fileDirtyRef.current = false
    fileSavingRef.current = false
    mainPathRef.current = null
    mainResolvedRef.current = false
    seenBuildStatusRef.current = ''
    signalReadySentRef.current = false
    setFiles([])
    setFileCache({})
    setIndexLoaded(false)
    setSelectedPath(null)
    setFileContent('')
    setFileLoading(false)
    setFileError(null)
    setFileDirty(false)
    setFileSaving(false)
    setMainPath(null)
    setMainReady(false)
    setPreviewReloadKey((n) => n + 1)
  }, [clearBuildPoll])

  const switchProject = useCallback(async (projectId) => {
    const next = projects.some((project) => project.id === projectId) ? projectId : DEFAULT_PROJECT_ID
    if (next === activeProjectId) return
    // Flush dirty edits (awaiting any in-flight autosave) before resetFileUi
    // discards the buffer — otherwise unsaved keystrokes are lost on switch.
    await flushDirtyEdits()
    resetFileUi()
    writeActiveProject(appId, next)
    closeNav()
    setActiveProjectId(next)
  }, [activeProjectId, appId, closeNav, flushDirtyEdits, projects, resetFileUi])

  const saveProjects = useCallback(async (next) => {
    setProjects(next)
    await rawStorage.setJSON(PROJECTS_KEY, next)
  }, [rawStorage])

  const readFreshProjects = useCallback(async () => {
    let fetched = null
    try { fetched = await rawStorage.getFresh(PROJECTS_KEY) } catch {}
    const fresh = normalizeProjects(fetched)
    if (fresh.length) return fresh
    if (projects.length) return projects
    return [{ id: DEFAULT_PROJECT_ID, name: 'Project 1', createdAt: Date.now() }]
  }, [projects, rawStorage])

  const deleteProjectTree = useCallback(async (projectId) => {
    const prefix = projectPrefix(projectId)
    if (!prefix) throw new Error('deleteProjectTree: refusing empty prefix (would wipe app root)')
    const removeUnder = async (dir) => {
      const entries = await rawStorage.list(dir)
      for (const entry of entries) {
        if (!entry || typeof entry.path !== 'string') continue
        if (entry.type === 'directory') await removeUnder(`${entry.path}/`)
        else await rawStorage.remove(entry.path)
      }
    }
    await removeUnder(prefix)
  }, [rawStorage])

  const startRenameProject = useCallback((projectId) => setRenamingId(projectId), [])
  const cancelRenameProject = useCallback(() => setRenamingId(null), [])

  const handleNewProject = useCallback(async () => {
    const name = `Project ${projects.length + 1}`
    const base = await readFreshProjects()
    const id = uniqueProjectId(name, base)
    const nextProject = { id, name, createdAt: Date.now() }
    const next = [...base, nextProject]
    try {
      await saveProjects(next)
      signal('item_created', { type: 'project' })
      signal('project_created', { project_count: next.length })
      // Flush dirty edits before changing activeProjectId — the project-change
      // effect clears the editor buffer, so unsaved keystrokes would be lost.
      // (handleNewProject sets activeProjectId directly, bypassing switchProject.)
      await flushDirtyEdits()
      writeActiveProject(appId, id)
      setActiveProjectId(id)
      setRenamingId(id)
      openNavRef.current?.()
    } catch (e) {
      signal('error', { message: e.message || String(e), source: 'create-project' })
      await modal.alert(e.message || String(e), { title: 'Could not create project' })
    }
  }, [appId, flushDirtyEdits, modal, projects.length, readFreshProjects, saveProjects])

  const commitRenameProject = useCallback(async (projectId, rawName) => {
    const clean = String(rawName || '').trim()
    try {
      const fresh = await readFreshProjects()
      const current = fresh.find((p) => p.id === projectId)
      if (!current || !clean || clean === current.name) return
      const next = fresh.map((p) => (p.id === projectId ? { ...p, name: clean } : p))
      await saveProjects(next)
    } catch (e) {
      signal('error', { message: e.message || String(e), source: 'rename-project' })
      await modal.alert(e.message || String(e), { title: 'Could not rename project' })
    } finally {
      setRenamingId(null)
    }
  }, [modal, readFreshProjects, saveProjects])

  const handleDeleteProject = useCallback(async (projectId) => {
    const base = await readFreshProjects()
    const project = base.find((p) => p.id === projectId)
    if (!project) return
    if (project.id === DEFAULT_PROJECT_ID || base.length <= 1) {
      await modal.alert('The default project and the last remaining project cannot be deleted.', { title: 'Cannot delete project' })
      return
    }
    const ok = await modal.confirm(
      `Delete “${project.name}” and all of its files and chat? This cannot be undone.`,
      { title: 'Delete project', danger: true },
    )
    if (!ok) return
    const fresh = await readFreshProjects()
    const current = fresh.find((p) => p.id === project.id)
    if (!current) {
      await modal.alert('That project no longer exists.', { title: 'Could not delete project' })
      return
    }
    if (current.id === DEFAULT_PROJECT_ID || fresh.length <= 1) {
      await modal.alert('The default project and the last remaining project cannot be deleted.', { title: 'Cannot delete project' })
      return
    }
    const next = fresh.filter((p) => p.id !== current.id)
    const fallback = next.some((p) => p.id === DEFAULT_PROJECT_ID) ? DEFAULT_PROJECT_ID : next[0].id
    try {
      await deleteProjectTree(current.id)
      await saveProjects(next)
      removeFileCache(appId, current.id)
      if (activeProjectId === current.id) {
        resetFileUi()
        writeActiveProject(appId, fallback)
        setActiveProjectId(fallback)
      }
      signal('item_deleted', { type: 'project' })
    } catch (e) {
      signal('error', { message: e.message || String(e), source: 'delete-project' })
      await modal.alert(e.message || String(e), { title: 'Could not delete project' })
    }
  }, [activeProjectId, appId, deleteProjectTree, modal, readFreshProjects, resetFileUi, saveProjects])

  const handleBuild = useCallback(() => {
    // Build always compiles the MAIN document, regardless of which file is
    // open (Overleaf-style). useBuild writes build/target.txt = mainPath so
    // the server-side script compiles the right root file.
    if (!mainPath || build.buildStatus === 'building') return
    // Save the currently-open file's unsaved edits first so a compile picks
    // up on-screen changes to the main doc (or to any \input'd chapter the
    // user just edited). handleSaveFile resolves once the write lands (or
    // fails silently into fileError); we build either way so a flaky save
    // doesn't strand the button.
    const kick = () => {
      buildStartedAtRef.current = Date.now()
      signal('build_started', {
        file_count: filesRef.current.filter((p) => !p.endsWith('/.keep')).length,
        has_cached_pdf: Boolean(pdfForMain),
      })
      build.build(mainPath, onBuildDone)
    }
    if (fileDirty && !fileSaving && canEditSelected) {
      handleSaveFile().then(kick, kick)
    } else {
      kick()
    }
  }, [mainPath, fileDirty, fileSaving, canEditSelected, build, onBuildDone, handleSaveFile, pdfForMain])

  // The PDF view: the build target's compiled output (with the build's
  // running / failed states), since Build always compiles the target file.
  function renderPdfView() {
    if (!mainPath) {
      return (
        <div className="preview-note">
          No build target set yet. Open the file drawer and tap the target
          icon on a .tex file (or use its “…” menu) to set it as the build
          target, then Build.
        </div>
      )
    }
    if (mainBuilding) {
      return (
        <div className="preview-note build-note">
          Building <b>{mainPath.replace(/^files\//, '')}</b>…
          (first build downloads packages, ~30–60s)
        </div>
      )
    }
    if (mainBuildError) {
      return (
        <div className="build-error">
          <div className="build-error-title">Build failed</div>
          <pre className="build-log">{build.buildLog}</pre>
        </div>
      )
    }
    if (pdfForMain) {
      return <PdfPreview storage={storage} path={pdfForMain.pdf} version={pdfForMain.ver} appId={appId} token={token} storagePrefix={storagePrefix} />
    }
    return (
      <div className="preview-note build-note">
        No PDF yet. Tap <b>Build</b> to compile <b>{mainPath.replace(/^files\//, '')}</b>.
      </div>
    )
  }

  // The main content area — source editor OR a viewer, toggled. A .tex
  // shows its raw source by default and flips to the main doc's PDF via the
  // top-bar toggle. Images and tree-selected .pdf files render directly.
  function renderMain() {
    if (!selectedPath) {
      return (
        <div className="preview-empty">
          <div className="preview-empty-title">LaTeX</div>
          <div className="preview-empty-body">
            Open the file drawer to pick a file.
          </div>
        </div>
      )
    }
    // Images: always inline. A .pdf opened from the tree: the pdf.js viewer
    // (static document, no build state). Both take previewReloadKey so a
    // same-path rewrite/delete by the agent (or another device) re-fetches
    // fresh bytes instead of stranding the stale preview on screen.
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(selectedExt)) {
      return <ImagePreview storage={storage} path={selectedPath} reloadKey={previewReloadKey} />
    }
    if (selectedExt === 'pdf') {
      return <PdfPreview storage={storage} path={selectedPath} version={previewReloadKey} appId={appId} token={token} storagePrefix={storagePrefix} />
    }
    // Desktop (>=860px): a .tex with a build target shows the Overleaf-style
    // two-pane split — editable source on the left, the main doc's PDF on the
    // right — instead of the single-pane toggle. The editor measure is capped
    // by .split-editor so source doesn't stretch edge-to-edge on a wide monitor.
    if (selectedIsTex && hasMain && isWide) {
      return (
        <div className="split">
          <div className="split-editor">{renderEditor()}</div>
          <div className="split-pdf">{renderPdfView()}</div>
        </div>
      )
    }
    // PDF mode (only reachable for .tex selections via the toggle) shows the
    // MAIN document's compiled output.
    if (selectedIsTex && viewMode === 'pdf') {
      return renderPdfView()
    }
    return renderEditor()
  }

  // The editable source for the open text file (or a read-only view of an
  // app-owned JSON record). Extracted so the desktop split can place it beside the PDF.
  function renderEditor() {
    if (fileLoading) return <div className="preview-note">Loading source…</div>
    if (fileError) return <div className="preview-note">{fileError}</div>
    // App-owned JSON records are shown read-only: editing them as text/plain
    // here would corrupt them for every typed-JSON reader, so we don't autosave
    // them. User files such as files/config.json do not hit this branch.
    if (isManagedJsonPath(selectedPath)) {
      return (
        <div className="editor-readonly">
          <div className="readonly-note">
            App metadata — edit via the app, not the source.
          </div>
          <CodeEditor
            value={fileContent}
            markdown={false}
            readOnly
            docKey={selectedPath}
            onChange={handleEditorChange}
          />
        </div>
      )
    }
    return (
      <CodeEditor
        value={fileContent}
        markdown={false}
        readOnly={false}
        docKey={selectedPath}
        onChange={handleEditorChange}
      />
    )
  }

  const openName = selectedPath ? selectedPath.replace(/^files\//, '') : null

  // ── Body render ─────────────────────────────────────────────────────────
  // Chat off: content is full-screen, no panel, no divider.
  // Chat on: 50/50 split — content above, slim draggable divider, chat panel
  // below. --chat-ratio (set inline) drives the panel height; the panel is a
  // flex column whose embedded chat iframe fills it, so the composer is
  // pinned to the bottom of the panel.
  function renderBody() {
    const fileNav = (
      <FileNavPanel
        open={navOpen}
        onClose={closeNav}
        files={files}
        selectedPath={selectedPath}
        onSelect={setSelectedPath}
        canMutate={indexLoaded}
        onCreateFile={handleCreateFile}
        onCreateFolder={handleCreateFolder}
        onDeleteFile={handleDeleteFile}
        onDeleteFolder={handleDeleteFolder}
        onUpload={uploadFiles}
        onMove={movePath}
        onRename={handleRename}
        mainPath={mainPath}
        onSetMain={handleSetMain}
        returnFocusRef={navToggleRef}
        projects={projects}
        projectsLoaded={projectsReady}
        activeProjectId={activeProjectId}
        onSwitchProject={switchProject}
        onNewProject={handleNewProject}
        onRenameProject={startRenameProject}
        onDeleteProject={handleDeleteProject}
        renamingId={renamingId}
        onCommitProjectRename={commitRenameProject}
        onCancelProjectRename={cancelRenameProject}
        pinned={isWide}
      />
    )
    if (!chatOpen) {
      return (
        <div ref={bodyRef} className="body">
          {fileNav}
          <main className="content">{renderMain()}</main>
        </div>
      )
    }
    return (
      <div
        ref={bodyRef}
        className="body body--chat-open"
        style={{ '--chat-ratio': chatRatio, '--chat-pane-min': `${CHAT_PANE_MIN_PX}px` }}
      >
        {fileNav}
        <main className="content">{renderMain()}</main>
        <div
          className="chat-divider"
          role="separator"
          aria-label="Resize chat and editor areas"
          aria-orientation="horizontal"
          aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round(chatRatio * 100)}
          tabIndex={0}
          onPointerDown={beginChatResize}
          onKeyDown={handleResizeKey}
        >
          <span className="chat-divider-bar" aria-hidden="true" />
        </div>
        <ChatPanel
          key={activeProjectId}
          appId={appId}
          token={token}
          storage={storage}
          onFilesMaybeChanged={onFilesMaybeChanged}
          quickActions={quickActions}
          getContext={getContext}
          activeProjectId={activeProjectId}
        />
      </div>
    )
  }

  // Error chips: float above the PDF viewer when build failed, dismissible.
  // Tapping a chip pre-fills the chat by switching to Chat tab and using
  // the postMessage draft mechanism.
  function renderErrorChips() {
    if (!errorChips.length) return null
    return (
      <div className="error-chips" aria-label="Build errors" role="region">
        {errorChips.map((chip) => (
          <div key={chip} className="error-chip">
            <span className="error-chip-text" title={chip}>{chip}</span>
            <button
              type="button"
              className="error-chip-fix"
              aria-label={`Fix: ${chip}`}
              onClick={() => {
                // Pre-fill the chat composer via shell postMessage.
                try {
                  window.parent.postMessage(
                    { type: 'moebius:new-chat', draft: `Fix this error: ${chip}` },
                    window.location.origin,
                  )
                } catch (e) {}
              }}
            >
              Fix
            </button>
            <button
              type="button"
              className="error-chip-dismiss"
              aria-label="Dismiss"
              onClick={() => dismissChip(chip)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="latex-root">
      <style>{CSS}</style>
      {/* Two-zone top bar: left = drawer toggle + open filename, right =
          source/PDF segmented toggle + Build (+ sync pill) + chat toggle on the
          far right. The grid is 1fr auto so the filename grows and the controls
          sit right. Identical structure in app-webstudio (ws- prefixed). */}
      <header className="top-bar">
        <div className="top-zone top-zone--left">
          {/* The app's own glossy icon IS the file-drawer toggle (the shell
              pattern: the brand logo, not a hamburger, opens the drawer). The
              real icon image — the backend serves a downscaled ~6KB copy at
              ?size=64 (cached 1h), so it paints fast without the old full-res
              PNG cost; the accent-dot fallback shows when an install has no
              custom icon (the route 404s). */}
          <button
            ref={navToggleRef}
            className="nav-toggle"
            onClick={toggleNav}
            aria-label={navOpen ? 'Close files' : 'Open files'}
            aria-expanded={navOpen}
            title="Toggle files"
          >
            <img
              src={`/api/apps/${appId}/icon?size=64`}
              alt=""
              width={34}
              height={34}
              className="latex-brand-icon"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
                const f = e.currentTarget.nextElementSibling
                if (f) f.style.display = 'flex'
              }}
            />
            <span className="latex-brand-fallback" style={{ display: 'none' }} aria-hidden="true" />
          </button>
          <div className="top-title">
            {openName
              ? <span className="top-path" title={selectedPath}>{openName}</span>
              : <span className="top-path top-path--muted">No file open</span>}
          </div>
        </div>
        <div className="top-zone top-zone--right">
          {hasMain && selectedIsTex && !isWide && (
            <div className="seg-toggle" role="group" aria-label="View">
              <button
                type="button"
                className={`seg-btn ${viewMode === 'source' ? 'seg-btn--active' : ''}`}
                aria-pressed={viewMode === 'source'}
                aria-label="Source"
                title="Source"
                onClick={() => setViewMode('source')}
              >
                <ToolIcon name="source" size={20} />
              </button>
              <button
                type="button"
                className={`seg-btn ${viewMode === 'pdf' ? 'seg-btn--active' : ''}`}
                aria-pressed={viewMode === 'pdf'}
                aria-label="PDF"
                title="PDF"
                onClick={() => setViewMode('pdf')}
              >
                <ToolIcon name="preview" size={20} />
              </button>
            </div>
          )}
          {hasMain && selectedIsTex && (
            <button
              className="toolbar-btn toolbar-btn--primary"
              onClick={handleBuild}
              disabled={build.buildStatus === 'building'}
              aria-label={build.buildStatus === 'building' ? 'Building…' : 'Build'}
              title={build.buildStatus === 'building'
                ? 'Building…'
                : `Build ${mainPath.replace(/^files\//, '')}`}
            >
              {build.buildStatus === 'building'
                ? <BuildingIndicator size={20} />
                : <PlayIcon size={20} />}
            </button>
          )}
          <SyncPill online={online} hasRuntime={storage.hasRuntime} />
          {/* Chat lives at the far right of the bar ("chat to the right"),
              after the sync indicator — moved here from the old centre zone
              when the bar collapsed to two zones. */}
          <button
            type="button"
            className="toolbar-btn chat-toggle-btn"
            aria-label={chatOpen ? 'Close chat' : 'Open chat'}
            aria-pressed={chatOpen}
            title={chatOpen ? 'Close chat' : 'Open chat'}
            onClick={toggleChat}
          >
            <ChatBubbleIcon size={20} />
          </button>
        </div>
      </header>

      {/* Error chips float over the content area when build fails */}
      {renderErrorChips()}

      {renderBody()}

      {modal.node}
    </div>
  )
}
