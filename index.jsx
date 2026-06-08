import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands'

// No HTML-injection surfaces remain: the live KaTeX/Tex preview and the
// markdown preview (the only `dangerouslySetInnerHTML` users) were removed
// in the Source/PDF redesign. Files are shown as raw source in a CodeMirror
// editor or as a pdf.js-rendered canvas, neither of which interprets stored
// bytes as markup — so DOMPurify is no longer needed and is dropped from the
// bundle (and can come out of the manifest esm_deps).

// Allowed characters for any storage path the UI writes. NAME_RE mirrors the
// server's `_SAFE_RE` (`[\w.\-/]+`); isSafeRelPath adds browser-side semantic
// guards (`.` / `..`, empty segments, absolute paths) so user input can never
// escape the app's files/ tree before it reaches storage.
const NAME_RE = /^[\w.\-/]+$/

export function isSafeRelPath(path) {
  const value = typeof path === 'string' ? path.trim() : ''
  if (!value || value.startsWith('/') || value.includes('\\')) return false
  if (!NAME_RE.test(value)) return false
  const parts = value.split('/')
  return parts.every((part) => part && part !== '.' && part !== '..')
}

export function isSafeStoragePath(path) {
  return typeof path === 'string'
    && path.startsWith('files/')
    && isSafeRelPath(path.slice('files/'.length))
}

const BINARY_FILE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'])

function extensionFor(path) {
  return String(path || '').split('.').pop().toLowerCase()
}

function isBinaryProjectPath(path) {
  return BINARY_FILE_EXTS.has(extensionFor(path))
}

function isTextProjectPath(path) {
  return isSafeStoragePath(path)
    && !path.endsWith('/.keep')
    && !isBinaryProjectPath(path)
}

// `.json` paths under the project (files-index.json, main.json, chat_id.json,
// and any .json the user makes) are MANAGED files: every other reader loads
// them with the typed JSON getter, which throws assertReadKind if they were
// written as text/plain. The text editor's debounced autosave writes
// text/plain, so editing a .json as source would corrupt it for every other
// reader. We make .json paths read-only in the editor instead — shown as
// source, but never autosaved back as text.
function isManagedJsonPath(path) {
  return String(path || '').toLowerCase().endsWith('.json')
}

// ----------------------------------------------------------------------
// CodeMirror plain-source editor — a parallel copy of the Editor app's
// non-markdown editor (app-editor/index.jsx), so the .tex source editor and
// the Editor app stay visually and behaviorally identical. This app edits
// source (.tex), never markdown, so only the plain pieces are copied: no
// live preview, no markdown highlighting, no KaTeX.
// ----------------------------------------------------------------------

// A plain-text theme for source — monospace, no markdown highlighting, no live
// preview. The 2px var(--accent) caret matches the Editor app's source pane.
const cmThemePlain = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)', lineHeight: '1.6', fontSize: '13.5px' },
  '.cm-content': { padding: '14px 16px 30vh', caretColor: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)' },
})

function buildPlainExtensions(onDocChange) {
  return [
    history(),
    EditorView.lineWrapping,
    keymap.of([indentWithTab, ...historyKeymap, ...defaultKeymap]),
    cmThemePlain,
    EditorView.updateListener.of((u) => { if (u.docChanged) onDocChange(u.state.doc.toString()) }),
  ]
}

// ----------------------------------------------------------------------
// CodeMirror React wrapper. Mounts an EditorView whose extension stack is
// chosen by `markdown` (live-preview vs plain monospace). `value` seeds the
// doc; an EXTERNAL change (open a different file, or the agent edited the file
// and onTurnDone re-read it) replaces the whole doc — but only when the user
// isn't the one who just typed it. We track the last value emitted by local
// typing in `lastEmitted` so a parent re-render that echoes our own onChange
// back as `value` does NOT reset the cursor. The view is rebuilt only when
// `markdown`/`docKey` change (different file or syntax mode), because the
// extension stack differs. `readOnly` is NOT a rebuild trigger: a transient
// readOnly flip (meta briefly null on agent reload) would tear down the view
// and reset the caret to position 0. Instead read-only is reconfigured live
// through a Compartment, leaving the view (and cursor) intact.
//
// This app only ever passes markdown={false} (it edits source, not markdown),
// so buildMarkdownExtensions is never reached; the `isMd` branch is kept
// verbatim from the Editor app so the wrapper stays a drop-in parallel copy.
// ----------------------------------------------------------------------
function CodeEditor({ value, markdown: isMd, readOnly, docKey, onChange }) {
  const host = useRef(null)
  const view = useRef(null)
  const onChangeRef = useRef(onChange)
  const lastEmitted = useRef(value)
  const roCompartment = useRef(null)
  if (roCompartment.current === null) roCompartment.current = new Compartment()
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  // Rebuild the view when the file (docKey) or the syntax mode (markdown)
  // changes. Read-only lives in a compartment (reconfigured below), so a
  // readOnly flip does NOT rebuild. Editing the same file just dispatches doc
  // changes (effect further below).
  useEffect(() => {
    const emit = (text) => {
      lastEmitted.current = text
      if (onChangeRef.current) onChangeRef.current(text)
    }
    const base = buildPlainExtensions(emit)
    const extensions = [
      ...base,
      roCompartment.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    ]
    const state = EditorState.create({ doc: value || '', extensions })
    const v = new EditorView({ state, parent: host.current })
    view.current = v
    lastEmitted.current = value || ''
    return () => { v.destroy(); view.current = null }
    // value/readOnly are intentionally omitted: a docKey change carries the new
    // file's value (reacting to value would rebuild on every keystroke), and
    // readOnly is reconfigured via the compartment effect below, not a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, isMd])

  // Read-only toggled for the SAME view (meta resolved/cleared on reload) —
  // reconfigure the compartment in place. No view rebuild, so the cursor stays.
  useEffect(() => {
    const v = view.current
    if (!v) return
    v.dispatch({
      effects: roCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    })
  }, [readOnly])

  // External value change for the SAME file (agent edit re-read, or a
  // revalidation) — replace the doc, but skip our own echo so typing isn't
  // interrupted and the cursor doesn't jump.
  useEffect(() => {
    const v = view.current
    if (!v) return
    if (value == null) return
    if (value === lastEmitted.current) return
    const cur = v.state.doc.toString()
    if (value === cur) return
    v.dispatch({ changes: { from: 0, to: cur.length, insert: value } })
    lastEmitted.current = value
  }, [value])

  return <div ref={host} className="cm-host" />
}

export function pdfPathForTexDoc(path) {
  if (!isSafeStoragePath(path) || !path.endsWith('.tex')) return null
  return `${path.slice(0, -'.tex'.length)}.pdf`
}

export function pdfFromBuildStatusForDoc(status, doc) {
  if (!status || typeof status !== 'object') return null
  if (status.status !== 'done') return null
  if (!isSafeStoragePath(doc) || !doc.endsWith('.tex')) return null
  if (status.target && status.target !== doc) return null
  if (!isSafeStoragePath(status.pdf) || !status.pdf.endsWith('.pdf')) return null
  return status.pdf
}

function cleanIndexPaths(paths) {
  return [...new Set((paths || []).filter(isSafeStoragePath))].sort()
}

export function normalizeFileCacheSnapshot(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  const index = cleanIndexPaths(parsed.index)
  const indexSet = new Set(index)
  const contents = {}
  const rawContents = (parsed.contents && typeof parsed.contents === 'object')
    ? parsed.contents : {}
  for (const [path, body] of Object.entries(rawContents)) {
    if (indexSet.has(path) && typeof body === 'string') contents[path] = body
  }
  const lastPath = (typeof parsed.lastPath === 'string' && indexSet.has(parsed.lastPath))
    ? parsed.lastPath : null
  return { index, contents, lastPath }
}

// ----------------------------------------------------------------------
// LaTeX editor mini-app for Möbius — an Overleaf-style editor.
//
// Layout (mobile-first, VSCode-shaped):
//   - Top bar: ☰ (toggle the left file drawer) · the open file's name
//     (+ a "main" badge if it's the document Build compiles) · a
//     single row of icon buttons: a source/preview view toggle and a
//     play-triangle Build button (both for .tex only; each icon button
//     carries an aria-label + title).
//   - Left drawer: slides in over a backdrop from the left edge — the
//     file tree + New file/folder/Upload + per-file context actions
//     (rename / delete / set-as-main). Each non-main .tex row also shows
//     a visible target icon to set it as the main document (the
//     discoverable twin of the context-menu action); the current main
//     doc wears a target "main" badge instead. Tapping a file or the
//     backdrop closes it.
//   - Main area: the SOURCE editor (CodeMirror) OR the compiled PDF
//     (pdf.js canvas), toggled. Images render inline; a .pdf in the
//     tree renders directly in the pdf.js viewer.
//   - Chat: a bottom panel with a bounded height so the embedded agent
//     conversation + composer stay fully visible and scrollable. The
//     user describes the document in prose; the sub-agent edits files
//     in /data/apps/<id>/files/ via the Edit and Write tools.
//
// Storage layout (under /api/storage/apps/<id>/):
//   files/<path>           the user's actual .tex/.md/etc. files
//   files-index.json       the canonical list of paths under files/.
//                          We maintain it because the storage API has
//                          no listing endpoint for apps; without it we
//                          would have to brute-force-probe paths.
//   main.json              {path: "files/<root>.tex"} — the designated
//                          MAIN document. Build always compiles this
//                          file regardless of which file is open, and
//                          the PDF view shows its output (Overleaf's
//                          "main document" concept).
//   chat_id.json           {id: "uuid"} — the chat the sub-agent runs
//                          in. Created lazily on first send and
//                          re-used across reloads so the user always
//                          has one continuous conversation.
// ----------------------------------------------------------------------

// Storage fallback shim — prefer the runtime's offline-aware
// window.mobius.storage when present, fall back to direct
// fetch() against /api/storage on older shells. The runtime's
// `set/remove` resolve to `{synced:true}` (online, server ack'd) or
// `{queued:true}` (offline / network fail, IndexedDB outbox will
// drain on `online`); `pendingCount()` exposes outbox depth so the
// header pill can surface unsynced work. The fallback path (no
// runtime) returns a normalised `{synced:true}` from writes and 0
// from pendingCount — we have no outbox to lie about.
function makeStorage(appId, token) {
  const ms = (typeof window !== 'undefined' && window.mobius && window.mobius.storage) || null
  const hasRuntime = !!ms
  async function get(path) {
    // Read with the TYPED getter matching how the path was written: .json
    // paths hold JSON (get); everything else (.tex, build/target.txt) is raw
    // text (getText). Mixing them throws assertReadKind in the runtime, so the
    // read kind MUST mirror the write kind (setText/setJSON below).
    if (ms) {
      const isJson = path.endsWith('.json')
      if (isJson && typeof ms.get === 'function') return ms.get(path)
      if (!isJson && typeof ms.getText === 'function') return ms.getText(path)
    }
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`get ${path} → ${r.status}`)
    const ct = r.headers.get('content-type') || ''
    if (ct.includes('application/json')) return r.json()
    return r.text()
  }
  async function getFresh(path) {
    // Direct server read. The runtime getter is cache-first for offline
    // work, which is exactly what we want during normal editing, but a
    // server-side agent can update the same file behind that mirror. This
    // path asks the backend for the canonical bytes so the editor and the
    // file on disk converge while online.
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`get ${path} → ${r.status}`)
    const ct = r.headers.get('content-type') || ''
    if (ct.includes('application/json')) return r.json()
    return r.text()
  }
  async function getBlob(path) {
    if (ms && typeof ms.getBlob === 'function') return ms.getBlob(path)
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    // Distinguish "the file doesn't exist yet" (404 — e.g. never built) from a
    // transient/other transport failure, so a caller can render an actionable
    // message instead of one opaque "could not load". 404 → null (sentinel for
    // absent); any other non-200 → a typed error carrying the HTTP status.
    if (r.status === 404) return null
    if (!r.ok) {
      const err = new Error(`get blob ${path} → ${r.status}`)
      err.name = 'BlobFetchError'
      err.status = r.status
      throw err
    }
    return r.blob()
  }
  async function setText(path, text) {
    // Write through the runtime's TYPED text writer — ms.set is the JSON writer
    // (sends application/json + JSON.stringify), which corrupts/400s a .tex or
    // build/target.txt save. ms.setText sends raw UTF-8 (text/plain). An older
    // runtime without setText falls through to the direct fetch below, which
    // also sends text/plain — so both paths agree on the wire shape.
    if (ms && typeof ms.setText === 'function') return ms.setText(path, text)
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: text,
    })
    if (!r.ok) throw new Error(`set ${path} → ${r.status}`)
    return { synced: true }
  }
  async function setBlob(path, blob, options = {}) {
    if (ms && typeof ms.setBlob === 'function') return ms.setBlob(path, blob, options)
    const contentType = options.contentType || (blob && blob.type) || 'application/octet-stream'
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body: blob,
    })
    if (!r.ok) throw new Error(`set ${path} → ${r.status}`)
    return { synced: true }
  }
  async function setJSON(path, obj) {
    if (ms && typeof ms.set === 'function') return ms.set(path, obj)
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    })
    if (!r.ok) throw new Error(`set ${path} → ${r.status}`)
    return { synced: true }
  }
  async function remove(path) {
    if (ms && typeof ms.remove === 'function') return ms.remove(path)
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok && r.status !== 404) throw new Error(`remove ${path} → ${r.status}`)
    return { synced: true }
  }
  async function pendingCount() {
    if (ms && typeof ms.pendingCount === 'function') {
      try { return await ms.pendingCount() } catch { return 0 }
    }
    return 0
  }
  function subscribeText(path, cb) {
    if (ms && typeof ms.subscribeText === 'function') return ms.subscribeText(path, cb)
    return () => {}
  }
  return {
    get, getFresh, getBlob,
    setText, setBlob, setJSON, remove,
    subscribeText,
    pendingCount,
    hasRuntime,
  }
}

// ----------------------------------------------------------------------
// Image preview. The storage API requires a bearer token, so we
// fetch the file as a blob and convert to an object URL — <img src>
// can't carry an Authorization header.
// ----------------------------------------------------------------------
function ImagePreview({ storage, path }) {
  const [url, setUrl] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    let live = true
    let revoke = null
    setUrl(null); setErr(null)
    storage.getBlob(path).then((blob) => {
      if (!live || !blob) {
        if (live) setErr('Image could not be loaded.')
        return
      }
      const u = URL.createObjectURL(blob)
      revoke = u
      setUrl(u)
    }).catch((e) => {
      if (live) setErr(e.message || 'Image load failed.')
    })
    return () => {
      live = false
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [storage, path])
  if (err) return <div className="preview-note">{err}</div>
  if (!url) return <div className="preview-note">Loading image…</div>
  return <img className="img-preview" src={url} alt={path} />
}

// PDF preview — a real pdf.js canvas render. Mobile browsers refuse to
// render a blob-URL PDF inline in an <iframe> (they offer an "open
// externally" button instead), so we fetch the bytes ourselves and
// rasterize each page to a <canvas>. pdfjs-dist comes from the shell's
// import map (bare specifier; externalized at compile time); the worker
// is served from the matching /vendor/pdfjs path.
//
// `version` (the build token) is in the deps so a rebuild that produces
// the SAME deterministic path still refetches + re-renders the fresh
// bytes. A .pdf opened directly from the tree passes version={undefined}
// (no build to track). The .pdf-pages host is populated imperatively via
// appendChild — it MUST NOT also carry React children, or React would
// clobber the canvases on its next reconcile; that's why the loading
// note is a SIBLING, not a child of the host.
function PdfPreview({ storage, path, version }) {
  const wrapRef = useRef(null)
  // `err` is null when fine, otherwise { message, retryable }. We keep a
  // retryable flag so the same render can show a Retry button only when
  // re-attempting could actually help (a transport blip), but NOT for the
  // "not built yet" case where the user should tap Build, or the
  // "not a valid PDF yet" case where re-fetching the same empty bytes won't.
  const [err, setErr] = useState(null)
  const [loading, setLoading] = useState(true)
  // Bumping this re-runs the load effect — the in-app Retry mechanism.
  const [retryNonce, setRetryNonce] = useState(0)
  useEffect(() => {
    let cancelled = false
    setErr(null); setLoading(true)
    ;(async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs'
        let blob
        try {
          blob = await storage.getBlob(path)
        } catch (fetchErr) {
          // getBlob throws only for transient/other transport failures (404 is
          // returned as null below); re-fetching may succeed, so make it
          // retryable.
          const e = new Error('Couldn’t load the PDF — tap Retry.')
          e.retryable = true
          throw e
        }
        if (!blob) {
          // 404 / absent: the doc has never been compiled. Build, don't retry.
          const e = new Error('No compiled PDF for this document yet — tap Build to compile it.')
          e.retryable = false
          throw e
        }
        const data = new Uint8Array(await blob.arrayBuffer())
        const doc = await pdfjs.getDocument({ data }).promise
        if (cancelled) { doc.destroy && doc.destroy(); return }
        const host = wrapRef.current
        if (!host) return
        host.innerHTML = ''            // imperative target — keep React children OUT of this node
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const cw = Math.max(host.clientWidth || 600, 200)
        for (let i = 1; i <= doc.numPages; i++) {
          if (cancelled) break
          const page = await doc.getPage(i)
          const base = page.getViewport({ scale: 1 })
          const cssScale = cw / base.width
          const vp = page.getViewport({ scale: cssScale * dpr })
          const canvas = document.createElement('canvas')
          canvas.className = 'pdf-page'
          canvas.width = Math.floor(vp.width)
          canvas.height = Math.floor(vp.height)
          canvas.style.width = '100%'
          canvas.style.height = 'auto'
          host.appendChild(canvas)
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
        }
        if (!cancelled) setLoading(false)
        doc.destroy && doc.destroy()
      } catch (e) {
        if (cancelled) return
        // A pdf.js parse failure on bytes that aren't a real PDF yet (empty
        // file, or a half-written build) surfaces as MissingPDFException /
        // InvalidPDFException — translate it into an honest, non-alarming note.
        let message = (e && e.message) || 'PDF failed to render.'
        let retryable = !!(e && e.retryable)
        const en = e && e.name
        if (en === 'MissingPDFException' || en === 'InvalidPDFException') {
          message = 'This file isn’t a valid PDF yet (it may be empty or still building).'
          retryable = false
        }
        setErr({ message, retryable })
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [storage, path, version, retryNonce])
  if (err) {
    return (
      <div className="preview-note">
        <div>{err.message}</div>
        {err.retryable && (
          <button
            className="preview-retry-btn"
            onClick={() => setRetryNonce((n) => n + 1)}
          >
            Retry
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="pdf-viewer">
      {loading && <div className="preview-note">Rendering PDF…</div>}
      <div className="pdf-pages" ref={wrapRef} />
    </div>
  )
}

// ----------------------------------------------------------------------
// File tree. We maintain files-index.json as the canonical list of
// paths, because the storage API doesn't expose a per-app listing
// endpoint. The agent is told (via the system prompt) to keep the
// index up to date when it creates/deletes files; the UI also writes
// to it whenever the user adds or removes a file from inside the app.
// We sort alphabetically and grouped by folder for the drawer view.
// ----------------------------------------------------------------------

// Build a tree-shaped structure from the flat path list.
function buildTree(paths) {
  // Each node: { name, path, children: Map, isFile }
  const root = { name: '', path: '', children: new Map(), isFile: false }
  for (const p of paths) {
    const parts = p.split('/')
    let node = root
    parts.forEach((seg, i) => {
      const last = i === parts.length - 1
      if (!node.children.has(seg)) {
        node.children.set(seg, {
          name: seg,
          path: parts.slice(0, i + 1).join('/'),
          children: new Map(),
          isFile: last,
        })
      } else if (last) {
        // Already exists but now confirmed as a file.
        node.children.get(seg).isFile = true
      }
      node = node.children.get(seg)
    })
  }
  return root
}

function fileIcon(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.tex')) return 'T'
  if (lower.endsWith('.md')) return 'M'
  if (lower.endsWith('.pdf')) return 'P'
  if (lower.match(/\.(png|jpe?g|gif|webp|svg)$/)) return 'i'
  return '·'
}

// Inline 24x24 line icons for the top-bar controls, in the same
// stroke=currentColor / strokeWidth=2 / round-cap style as Workout's
// <SportIcon>. The toolbar shows them in icon-only buttons (each with its
// own aria-label + title), so the glyph stands in for the old text label.
//   source  — a code/'</>' glyph (view the .tex source)
//   preview — a document-page glyph (view the compiled PDF)
//   build   — a play triangle (compile the main document)
//   target  — a target/bullseye glyph (the "set as main document" affordance)
const ICON_PATHS = {
  source: <><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></>,
  preview: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <polyline points="14 3 14 8 19 8" />
    </>
  ),
  build: <polygon points="7 4 20 12 7 20 7 4" />,
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
    </>
  ),
}

function ToolIcon({ name, size = 24 }) {
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size}
      fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden
    >
      {ICON_PATHS[name] || ICON_PATHS.source}
    </svg>
  )
}

// Detect whether a path's leaf is a file (vs a folder we haven't
// expanded yet). For the index-driven tree, anything in the flat
// list IS a file; folders only exist as intermediate path segments.
function isFilePath(path, index) {
  return index.includes(path)
}

// In-app context menu. Native context menus / window.prompt are unavailable
// in the mini-app sandbox (no allow-modals), and a native right-click menu
// would also offer "back/reload/inspect" that make no sense here. So we render
// our own absolutely-positioned menu at the cursor. It closes on any outside
// pointer-down, on Escape, and on scroll (a stale menu floating over moved
// content is worse than no menu). Positioned within `.latex-root` (which is
// `position: relative`), so coordinates are page-relative and clamped to the
// viewport so the menu can't open off-screen near an edge.
function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    // capture: true so we see the press before it lands on a tree row.
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])
  // Clamp so the menu stays on screen (rough width/height estimate; the menu
  // is small and fixed-content, so a static clamp is enough).
  const left = Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 180)
  const top = Math.min(y, (typeof window !== 'undefined' ? window.innerHeight : 9999) - (items.length * 44 + 8))
  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: `${Math.max(4, left)}px`, top: `${Math.max(4, top)}px` }}
      role="menu"
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className={`ctx-item ${it.danger ? 'ctx-item--danger' : ''}`}
          onClick={() => { onClose(); it.onSelect() }}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

// A long-press hook for touch: fires `onLongPress(clientX, clientY)` after
// LONG_PRESS_MS of a stationary touch, cancelling if the finger moves past a
// small slop or lifts early. This gives mobile users the same affordance
// right-click gives desktop. Structural timer (legitimate per the task).
const LONG_PRESS_MS = 500
const LONG_PRESS_SLOP = 10
function useLongPress(onLongPress) {
  const timerRef = useRef(null)
  const startRef = useRef(null)
  const clear = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    startRef.current = null
  }, [])
  useEffect(() => clear, [clear])
  const onTouchStart = useCallback((e) => {
    const t = e.touches && e.touches[0]
    if (!t) return
    startRef.current = { x: t.clientX, y: t.clientY }
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (startRef.current) onLongPress(startRef.current.x, startRef.current.y)
    }, LONG_PRESS_MS)
  }, [onLongPress])
  const onTouchMove = useCallback((e) => {
    const t = e.touches && e.touches[0]
    if (!t || !startRef.current) return
    if (Math.abs(t.clientX - startRef.current.x) > LONG_PRESS_SLOP
      || Math.abs(t.clientY - startRef.current.y) > LONG_PRESS_SLOP) {
      clear()
    }
  }, [clear])
  return { onTouchStart, onTouchMove, onTouchEnd: clear, onTouchCancel: clear }
}

function FileNode({
  node, selectedPath, onSelect, depth,
  onContextMenu, onMoveInto, mainPath, onSetMain, parentPath = '',
}) {
  const [expanded, setExpanded] = useState(true)
  const [dropActive, setDropActive] = useState(false)
  const isFolder = !(node.children.size === 0 && node.isFile)
  const longPress = useLongPress((cx, cy) => {
    onContextMenu({ x: cx, y: cy, path: node.path, isFolder })
  })
  if (node.children.size === 0 && node.isFile) {
    const selected = node.path === selectedPath
    const isMain = node.path === mainPath
    const isTex = node.path.toLowerCase().endsWith('.tex')
    // Discoverable "set as main document" affordance: a visible target button
    // on every .tex that isn't already the main doc, alongside the existing
    // right-click / long-press context-menu path (which still works). The
    // current target is marked with a filled "main" badge instead. We render
    // the control as a role="button" span (not a nested <button>, which is
    // invalid inside the row's own <button>) and stop propagation so tapping
    // it sets the target without also selecting/opening the file.
    const activateSetMain = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (onSetMain) onSetMain(node.path)
    }
    return (
      <button
        type="button"
        className={`tree-file ${selected ? 'tree-file--selected' : ''}`}
        style={{ paddingLeft: `${10 + depth * 16}px` }}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={selected}
        tabIndex={-1}
        data-tree-path={node.path}
        data-parent-path={parentPath}
        data-tree-kind="file"
        onClick={() => onSelect(node.path)}
        // Draggable so a file can be dropped onto a folder (or the root) to
        // move it. dataTransfer carries the source path.
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/mobius-path', node.path)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          onContextMenu({ x: e.clientX, y: e.clientY, path: node.path, isFolder: false })
        }}
        {...longPress}
      >
        <span className="tree-icon">{fileIcon(node.name)}</span>
        <span className="tree-name">{node.name}</span>
        {isMain && (
          <span className="tree-main-badge" title="Build compiles this file (the main document)">
            <ToolIcon name="target" size={13} />
            main
          </span>
        )}
        {isTex && !isMain && onSetMain && (
          <span
            className="tree-set-main"
            role="button"
            tabIndex={0}
            aria-label="Set as main document"
            title="Set as main document (Build will compile this file)"
            onClick={activateSetMain}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') activateSetMain(e) }}
          >
            <ToolIcon name="target" size={16} />
          </span>
        )}
      </button>
    )
  }
  // Folder node — own row plus indented children. We filter `.keep`
  // entries before sorting: those exist only so empty folders survive
  // a backend that has no mkdir endpoint (handleCreateFolder writes
  // `files/<name>/.keep` to materialise the folder), and showing
  // them in the tree would just look like noise the user can't act
  // on. The path stays in files-index.json so the folder itself is
  // still visible as an intermediate node here.
  const sortedChildren = [...node.children.values()]
    .filter((c) => !(c.isFile && c.name === '.keep'))
    .sort((a, b) => {
      // Folders first, then files, both alphabetical. Folder = has
      // non-empty children and isn't itself a leaf file.
      const af = a.children.size > 0 && !a.isFile
      const bf = b.children.size > 0 && !b.isFile
      if (af !== bf) return af ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  // Move the dragged file INTO this folder (or the root): keep its leaf name,
  // re-parent it under `destDir`. destDir is "" for the root, else the
  // folder's own path ("files/sub").
  const dropMove = (e, destDir) => {
    e.preventDefault()
    setDropActive(false)
    const from = e.dataTransfer.getData('text/mobius-path')
    if (!from) return
    const leaf = from.split('/').pop()
    // Root drops land back under files/ (the storage tree root for this app);
    // folder drops land under the folder. Either way the new path is
    // <dest>/<leaf>.
    const base = destDir || 'files'
    onMoveInto(from, `${base}/${leaf}`)
  }

  // Root folder (depth -1) renders just its children, no row of its own — but
  // the whole tree container is itself a drop target so a file can be moved
  // back out to the top level. The drop handler lives on the wrapper.
  if (depth < 0) {
    return (
      <div
        className={`tree-root ${dropActive ? 'tree-drop-active' : ''}`}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropActive(true) }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(e) => dropMove(e, '')}
      >
        {sortedChildren.map((c) => (
          <FileNode
            key={c.path}
            node={c}
            selectedPath={selectedPath}
            onSelect={onSelect}
            depth={0}
            onContextMenu={onContextMenu}
            onMoveInto={onMoveInto}
            mainPath={mainPath}
            onSetMain={onSetMain}
            parentPath=""
          />
        ))}
      </div>
    )
  }
  return (
    <>
      <button
        type="button"
        className={`tree-folder ${dropActive ? 'tree-drop-active' : ''}`}
        style={{ paddingLeft: `${10 + depth * 16}px` }}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={expanded}
        tabIndex={-1}
        data-tree-path={node.path}
        data-parent-path={parentPath}
        data-tree-kind="folder"
        onClick={() => setExpanded((e) => !e)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' && !expanded) {
            e.preventDefault()
            setExpanded(true)
          } else if (e.key === 'ArrowLeft' && expanded) {
            e.preventDefault()
            setExpanded(false)
          }
        }}
        // Folders are drop targets for moves.
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropActive(true) }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(e) => dropMove(e, node.path)}
        onContextMenu={(e) => {
          e.preventDefault()
          onContextMenu({ x: e.clientX, y: e.clientY, path: node.path, isFolder: true })
        }}
        {...longPress}
      >
        <span className="tree-icon">{expanded ? '▾' : '▸'}</span>
        <span className="tree-name">{node.name}/</span>
      </button>
      {expanded && (
        <div role="group" className="tree-group">
          {sortedChildren.map((c) => (
            <FileNode
              key={c.path}
              node={c}
              selectedPath={selectedPath}
              onSelect={onSelect}
              depth={depth + 1}
              onContextMenu={onContextMenu}
              onMoveInto={onMoveInto}
              mainPath={mainPath}
              onSetMain={onSetMain}
              parentPath={node.path}
            />
          ))}
        </div>
      )}
    </>
  )
}

// Left slide-in file drawer (VSCode explorer shape): a panel that
// transforms in from the left edge over a dimming backdrop, opened by
// the ☰ button in the top bar. It is ALWAYS mounted (the `--open` class
// drives the transform), so the slide animation plays both ways and the
// tree state survives a close/reopen.
//
// `canMutate` is false until the file index has been confirmed against
// the server (App owns the check). While false we disable add/delete so
// the user can't queue an index write derived from an unconfirmed list —
// the handler refuses too, but greying the buttons is the honest surface
// rather than a tap that pops an explanatory modal.
function FileNavPanel({
  open, onClose, files, selectedPath, onSelect, canMutate,
  onCreateFile, onCreateFolder, onDeleteFile, onDeleteFolder,
  onUpload, onMove, onRename, mainPath, onSetMain, returnFocusRef,
}) {
  const root = useMemo(() => buildTree(files), [files])
  const treeRef = useRef(null)
  const prevOpenRef = useRef(open)
  // Hidden inputs the Upload buttons click programmatically. Two separate
  // inputs because `webkitdirectory` and a plain multi-file picker can't share
  // one element — the directory flag turns the whole picker into folder mode.
  const fileInputRef = useRef(null)
  const folderInputRef = useRef(null)
  // The open context menu: {x, y, path, isFolder} or null.
  const [ctx, setCtx] = useState(null)
  const closeCtx = useCallback(() => setCtx(null), [])
  // Close the menu when the drawer closes so it can't outlive its anchor.
  useEffect(() => { if (!open) setCtx(null) }, [open])

  const treeItems = useCallback(() => {
    if (!treeRef.current) return []
    return Array.from(treeRef.current.querySelectorAll('[role="treeitem"]'))
  }, [])

  const focusTreeItem = useCallback((item) => {
    if (item && typeof item.focus === 'function') item.focus()
  }, [])

  const focusSelectedOrFirst = useCallback(() => {
    const items = treeItems()
    if (items.length === 0) return
    const selected = selectedPath
      ? items.find((item) => item.getAttribute('data-tree-path') === selectedPath)
      : null
    focusTreeItem(selected || items[0])
  }, [focusTreeItem, selectedPath, treeItems])

  useEffect(() => {
    const wasOpen = prevOpenRef.current
    prevOpenRef.current = open
    if (open && !wasOpen) {
      const raf = requestAnimationFrame(focusSelectedOrFirst)
      return () => cancelAnimationFrame(raf)
    }
    if (!open && wasOpen) {
      returnFocusRef?.current?.focus?.()
    }
  }, [focusSelectedOrFirst, open, returnFocusRef])

  const handleTreeFocus = useCallback((event) => {
    if (event.target === treeRef.current) focusSelectedOrFirst()
  }, [focusSelectedOrFirst])

  const handleTreeKeyDown = useCallback((event) => {
    if (event.defaultPrevented) return
    const current = event.target.closest?.('[role="treeitem"]')
    if (!current || !treeRef.current?.contains(current)) return
    const items = treeItems()
    const index = items.indexOf(current)
    if (index < 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusTreeItem(items[Math.min(index + 1, items.length - 1)])
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusTreeItem(items[Math.max(index - 1, 0)])
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusTreeItem(items[0])
    } else if (event.key === 'End') {
      event.preventDefault()
      focusTreeItem(items[items.length - 1])
    } else if (event.key === 'ArrowRight') {
      if (current.getAttribute('aria-expanded') === 'true') {
        const level = Number(current.getAttribute('aria-level') || '0')
        const child = items.slice(index + 1).find((item) => (
          Number(item.getAttribute('aria-level') || '0') > level
        ))
        if (child) {
          event.preventDefault()
          focusTreeItem(child)
        }
      }
    } else if (event.key === 'ArrowLeft') {
      const parentPath = current.getAttribute('data-parent-path')
      if (parentPath) {
        const parent = items.find((item) => item.getAttribute('data-tree-path') === parentPath)
        if (parent) {
          event.preventDefault()
          focusTreeItem(parent)
        }
      }
    }
  }, [focusTreeItem, treeItems])

  // Context actions. A .tex file additionally offers "Set as main
  // document" (unless it already is the main) so the user can pick which
  // file Build compiles, Overleaf-style.
  const ctxItems = ctx ? [
    ...(!ctx.isFolder && ctx.path.endsWith('.tex') && ctx.path !== mainPath
      ? [{ label: 'Set as main document', onSelect: () => onSetMain(ctx.path) }]
      : []),
    { label: 'Rename', onSelect: () => onRename(ctx.path) },
    {
      label: 'Delete',
      danger: true,
      onSelect: () => (ctx.isFolder ? onDeleteFolder(ctx.path) : onDeleteFile(ctx.path)),
    },
  ] : []

  return (
    <>
      <div
        className={`drawer-scrim ${open ? 'drawer-scrim--open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`file-drawer ${open ? 'file-drawer--open' : ''}`}
        aria-label="File tree"
        aria-hidden={!open}
      >
        <div className="drawer-head">
          <div>
            <span className="drawer-title">Files</span>
            <span className="drawer-count">{files.filter(p => !p.endsWith('/.keep')).length} items</span>
          </div>
        </div>
        <div className="drawer-actions">
          <button className="drawer-btn" onClick={onCreateFile} disabled={!canMutate}>New file</button>
          <button className="drawer-btn" onClick={onCreateFolder} disabled={!canMutate}>New folder</button>
          <button
            className="drawer-btn"
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
            disabled={!canMutate}
          >
            Upload
          </button>
          {/* Hidden file/folder pickers. Materialise the FileList into a real
              array SYNCHRONOUSLY before resetting input.value: onUpload is async
              (it awaits before reading the list), and `e.target.value = ''`
              empties the live FileList the input still owns — so capturing the
              reference and resetting first would hand the uploader an
              already-emptied list and silently upload nothing. The reset still
              runs (so re-picking the same file fires a change event); it just
              runs after we've copied the entries out. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const fl = Array.from(e.target.files || [])
              e.target.value = ''
              onUpload(fl, { asFolder: false })
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            webkitdirectory=""
            directory=""
            style={{ display: 'none' }}
            onChange={(e) => {
              const fl = Array.from(e.target.files || [])
              e.target.value = ''
              onUpload(fl, { asFolder: true })
            }}
          />
        </div>
        {!canMutate && (
          <div className="drawer-syncing" role="status">
            Loading your files… add, upload, and delete unlock once they sync.
          </div>
        )}
        <div
          ref={treeRef}
          className="drawer-tree"
          role="tree"
          aria-label="Project files"
          tabIndex={0}
          onFocus={handleTreeFocus}
          onKeyDown={handleTreeKeyDown}
        >
          {files.length === 0 ? (
            canMutate ? (
              <div className="drawer-empty">
                No files yet. Tap “New file” or Upload to make one.
              </div>
            ) : null
          ) : (
            <FileNode
              node={root}
              selectedPath={selectedPath}
              onSelect={(p) => { onSelect(p); onClose() }}
              depth={-1}
              onContextMenu={setCtx}
              onMoveInto={onMove}
              mainPath={mainPath}
              onSetMain={onSetMain}
            />
          )}
        </div>
        {ctx && (
          <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems} onClose={closeCtx} />
        )}
      </aside>
    </>
  )
}

// ----------------------------------------------------------------------
// Embedded shell chat. The runtime mounts the real ChatView into an
// iframe, so this app does not duplicate SSE handling, composer state,
// attachments, provider controls, queueing, or polling.
// ----------------------------------------------------------------------
function bootstrapPrompt(appId) {
  return [
    `You are the LaTeX-editor sub-agent for Möbius app id ${appId}.`,
    '',
    `Your working directory is /data/apps/${appId}/files/. Edit .tex files`,
    'there using the Edit and Write tools. The user describes documents in',
    'prose; you translate that to LaTeX. Your default action is to modify',
    'the project files, not to solve the task only in chat. If the user asks',
    'for a derivation, proof, rewrite, section, table, bibliography, or figure',
    'that belongs in the document, write it into the current/main .tex file',
    'unless they explicitly ask for a chat-only explanation. Keep the user’s',
    'intent; do not invent sections they did not ask for. After editing,',
    'summarise the change in ONE short sentence — the embedded chat panel',
    'renders only the last assistant message.',
    '',
    `After creating or deleting a file, append/remove its path (relative to`,
    `/data/apps/${appId}/files/, e.g. "files/chapter1.tex") in the JSON`,
    `array at /data/apps/${appId}/files-index.json. The mini-app reads`,
    'that file to populate its file tree; new files are invisible to the',
    'user until the index is updated.',
    '',
    'Folders created by the user appear as a `<folder>/.keep` placeholder',
    'in the index — the storage backend has no mkdir, so an empty folder',
    'is materialised by writing that 0-byte file. Leave .keep files alone',
    'unless the user explicitly asks to remove the folder.',
    '',
    `The MAIN document — the single root .tex the user compiles — is recorded`,
    `at /data/apps/${appId}/main.json as {"path": "files/<root>.tex"}. The`,
    'Build button always compiles that file. If you create a brand-new',
    'project with a different root than files/welcome.tex, update main.json',
    'to point at it (and keep its value to an existing .tex). The user can',
    'also set it from the file drawer.',
    '',
    'To build manually after edits: write the main document path (for',
    `example "files/welcome.tex") to /data/apps/${appId}/build/target.txt,`,
    `then call: curl -sS -X POST -H "Authorization: Bearer $AGENT_TOKEN"`,
    `"$API_BASE_URL/api/apps/${appId}/run-job". Poll or read`,
    `/data/apps/${appId}/build/status.json for {"status":"done","pdf":...}`,
    'or {"status":"error","log":...}. Report build errors briefly and fix',
    'the .tex when the error is actionable.',
    '',
    'This is a silent setup brief — do NOT reply to it. Wait for the',
    'user’s first message and act on that.',
  ].join('\n')
}

function ChatPanel({
  appId, token, storage,
  onFilesMaybeChanged,
}) {
  const mountRef = useRef(null)
  const [error, setError] = useState(null)
  // Keep the latest onFilesMaybeChanged in a ref so the mount effect below
  // does NOT depend on it. That callback's identity changes on every file
  // selection (it closes over selectedPath); if it were a mount-effect dep,
  // selecting a file would tear down + remount the chat iframe — destroying a
  // streaming turn mid-flight. The turn-done handler reads the ref instead.
  const onFilesRef = useRef(onFilesMaybeChanged)
  useEffect(() => { onFilesRef.current = onFilesMaybeChanged }, [onFilesMaybeChanged])
  const systemPrompt = useMemo(() => bootstrapPrompt(appId), [appId])

  // The helper owns the whole app-chat lifecycle: it creates the chat once
  // (POST /api/app-chats), persists its id as { id } under chat_id.json,
  // reuses it on later mounts, re-applies the system prompt on resume, and
  // reconciles the canonical id on 'ready'. We just give it a mount, the
  // persist key, and the prompt — and destroy the handle on cleanup.
  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !window.mobius || typeof window.mobius.chat !== 'function') {
      setError('Embedded chat is not available in this shell.')
      return undefined
    }
    let disposed = false
    let handle = null
    setError(null)

    window.mobius.chat({
      mount,
      persist: 'chat_id.json',
      title: 'LaTeX editor',
      systemPrompt,
      picker: true,
      onTurnDone: () => { if (onFilesRef.current) onFilesRef.current() },
      onError: ({ error }) => { setError(typeof error === 'string' ? error : 'Embedded chat reported an error.') },
    }).then((nextHandle) => {
      if (disposed) {
        nextHandle.destroy()
        return
      }
      handle = nextHandle
    }).catch((e) => {
      if (!disposed) setError(e.message || 'Could not mount embedded chat.')
    })

    return () => {
      disposed = true
      if (handle) handle.destroy()
    }
  }, [storage, systemPrompt])

  return (
    <section className="chat-panel">
      <div className="chat-head">
        <span className="chat-head-title">Agent</span>
        <span className="chat-head-hint">Describe your document — it writes the LaTeX</span>
      </div>
      {error && <div className="chat-error">{error}</div>}
      <div className="chat-embed" ref={mountRef} />
    </section>
  )
}

// ----------------------------------------------------------------------
// Online/offline detection. The runtime's `window.mobius.online` is a
// getter over `navigator.onLine` (see mobius-runtime.js) — same source,
// no separate change event — so we track `navigator.onLine` directly
// and react to the browser's own 'online'/'offline' events. That's the
// only signal the runtime actually emits; an earlier version subscribed
// to a `window.mobius.onChange` callback the runtime never exposes, so
// offline transitions only updated on a reload.
// ----------------------------------------------------------------------
function useOnline() {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const sync = () => setOnline(navigator.onLine !== false)
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])
  return online
}

// ----------------------------------------------------------------------
// In-app modal. Möbius mini-apps run in an iframe with the
// `allow-modals` sandbox token deliberately excluded, so window.alert
// / .confirm / .prompt silently no-op and return false — which would
// turn "type a name and tap OK" into a dead button. We render our own
// modal on top of the app instead. `useModal` returns an imperative
// {alert, confirm, prompt} surface that resolves with a Promise, plus
// the React node to render somewhere stable in the tree.
// ----------------------------------------------------------------------
function useModal() {
  const [state, setState] = useState(null)
  const navRef = useRef(null)
  const resolveRef = useRef(null)
  // state shape:
  //   { kind: 'alert'|'confirm'|'prompt',
  //     title, body, placeholder, defaultValue, danger, resolve }

  const finish = useCallback((value, fromShell = false) => {
    if (!fromShell) {
      try { navRef.current?.close?.() } catch {}
    }
    navRef.current = null
    setState(null)
    const resolve = resolveRef.current
    resolveRef.current = null
    if (resolve) resolve(value)
  }, [])

  const openModal = useCallback((factory, backValue) => new Promise((resolve) => {
    if (resolveRef.current) finish(backValue)
    resolveRef.current = resolve
    const show = () => setState(factory((value) => finish(value)))
    if (window.mobius?.nav?.open) {
      const handle = window.mobius.nav.open('latex-modal', () => finish(backValue, true))
      navRef.current = handle
      Promise.resolve(handle.ready).finally(() => {
        if (navRef.current === handle) show()
      })
    } else {
      show()
    }
  }), [finish])

  const alert = useCallback((body, opts = {}) => openModal((resolve) => ({
    kind: 'alert',
    title: opts.title || 'Heads up',
    body,
    resolve: () => resolve(undefined),
  }), undefined), [openModal])

  const confirm = useCallback((body, opts = {}) => openModal((resolve) => ({
    kind: 'confirm',
    title: opts.title || 'Confirm',
    body,
    danger: !!opts.danger,
    resolve: (ok) => resolve(!!ok),
  }), false), [openModal])

  const prompt = useCallback((body, opts = {}) => openModal((resolve) => ({
    kind: 'prompt',
    title: opts.title || 'Enter a value',
    body,
    placeholder: opts.placeholder || '',
    defaultValue: opts.defaultValue || '',
    resolve,
  }), null), [openModal])

  useEffect(() => () => {
    try { navRef.current?.close?.() } catch {}
    navRef.current = null
    resolveRef.current = null
  }, [])

  const node = state ? (
    <ModalView state={state} />
  ) : null

  return { node, alert, confirm, prompt }
}

function ModalView({ state }) {
  const [value, setValue] = useState(state.kind === 'prompt' ? (state.defaultValue || '') : '')
  const inputRef = useRef(null)
  useEffect(() => {
    if (state.kind === 'prompt' && inputRef.current) {
      // Autofocus + select-all so the user can replace any prefilled
      // value with a single keypress.
      inputRef.current.focus()
      inputRef.current.select()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (state.kind === 'alert') state.resolve()
        else state.resolve(state.kind === 'prompt' ? null : false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state])
  function onSubmit(e) {
    e.preventDefault()
    if (state.kind === 'prompt') state.resolve(value)
    else if (state.kind === 'confirm') state.resolve(true)
    else state.resolve()
  }
  return (
    <div className="modal-scrim" onClick={() => {
      // Click outside cancels (except for alert, which only has OK).
      if (state.kind === 'alert') state.resolve()
      else state.resolve(state.kind === 'prompt' ? null : false)
    }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={onSubmit}>
          <div className="modal-title">{state.title}</div>
          <div className="modal-body">{state.body}</div>
          {state.kind === 'prompt' && (
            <input
              ref={inputRef}
              className="modal-input"
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={state.placeholder}
            />
          )}
          <div className="modal-actions">
            {(state.kind === 'confirm' || state.kind === 'prompt') && (
              <button
                type="button"
                className="modal-btn modal-btn--secondary"
                onClick={() => state.resolve(state.kind === 'prompt' ? null : false)}
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              className={`modal-btn ${state.danger ? 'modal-btn--danger' : 'modal-btn--primary'}`}
            >
              {state.kind === 'confirm' ? (state.danger ? 'Delete' : 'OK')
                : state.kind === 'prompt' ? 'OK'
                : 'OK'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------
// localStorage snapshot of the file index + recently-viewed file
// contents so an offline reload paints SOMETHING — `storage.get()`
// returns null offline. Same shape as news's read-cache: small,
// per-app, deliberately not a write store. The server stays the
// source of truth; this exists purely so the first paint after a
// flaky-network reload shows last-known state.
//
// We cache up to FILE_CONTENT_CACHE_LIMIT bodies. Files-index is
// always cached (it's tiny). Cap chosen as roughly "all the files a
// user actively flicks between in a session" — large enough that a
// reload usually paints whatever they were last working on, small
// enough to stay well under the 5MB localStorage quota even for
// document-heavy users.
// ----------------------------------------------------------------------
const FILE_CONTENT_CACHE_LIMIT = 20
const FILE_CACHE_VERSION = 1
const CHAT_HEIGHT_CACHE_VERSION = 1

function fileCacheKey(appId) {
  return `latex:${appId}:files-cache:v${FILE_CACHE_VERSION}`
}

function chatHeightKey(appId) {
  return `latex:${appId}:chat-height:v${CHAT_HEIGHT_CACHE_VERSION}`
}

// The chat's min height (% of body). Low enough to drag the chat down to about
// composer height (hide-chat / full-vibe), so the editor + PDF can take the
// whole pane. The default opening height stays comfortable.
const CHAT_MIN_PCT = 10
const CHAT_MAX_PCT = 68
const CHAT_DEFAULT_PCT = 36

function readChatHeight(appId) {
  if (typeof localStorage === 'undefined') return CHAT_DEFAULT_PCT
  const raw = Number(localStorage.getItem(chatHeightKey(appId)))
  if (!Number.isFinite(raw)) return CHAT_DEFAULT_PCT
  return Math.min(CHAT_MAX_PCT, Math.max(CHAT_MIN_PCT, raw))
}

function readFileCache(appId) {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(fileCacheKey(appId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return normalizeFileCacheSnapshot(parsed)
  } catch {
    return null
  }
}

function writeFileCache(appId, index, contents, lastPath) {
  if (typeof localStorage === 'undefined') return
  try {
    const safeIndex = cleanIndexPaths(index)
    // Trim contents to the index — orphaned bodies (deleted files)
    // get GC'd here; only string bodies are kept (binary previews
    // fetch from the server on demand).
    const trimmed = {}
    const indexSet = new Set(safeIndex)
    const entries = Object.entries(contents)
      .filter(([p, v]) => indexSet.has(p) && typeof v === 'string')
      .slice(-FILE_CONTENT_CACHE_LIMIT)
    for (const [p, v] of entries) trimmed[p] = v
    localStorage.setItem(
      fileCacheKey(appId),
      JSON.stringify({
        index: safeIndex,
        contents: trimmed,
        // lastPath persists across reloads so an offline reload
        // reopens the file the user was last editing rather than
        // jumping back to the first entry in the tree.
        lastPath: (lastPath && indexSet.has(lastPath)) ? lastPath : null,
      }),
    )
  } catch {
    // Quota / disabled / serialization — leave the previous snapshot
    // in place; the in-memory state still works this session.
  }
}

// ----------------------------------------------------------------------
// Sync pill. Three observable states, in priority order:
//   pending > 0 + offline  → "Offline · N pending"
//   pending > 0 + online   → "Saving · N pending"
//   offline + pending == 0 → "Offline"
//   online + pending == 0  → null (idle steady state — don't clutter
//                            the surface with a persistent "Saved"
//                            sticker).
// hasRuntime=false (older shell without the offline runtime) means
// writes go straight to the server with no outbox to surface; we
// hide the pill in that mode rather than fabricate a queue depth.
// ----------------------------------------------------------------------
function SyncPill({ online, pending, hasRuntime }) {
  if (!hasRuntime) return null
  let label = null
  let variant = null
  if (pending > 0) {
    label = online ? `Saving · ${pending} pending` : `Offline · ${pending} pending`
    variant = online ? 'pending' : 'offline'
  } else if (!online) {
    label = 'Offline'
    variant = 'offline'
  }
  if (!label) return null
  return (
    <div
      className={`sync-pill sync-pill--${variant}`}
      role="status"
      aria-live="polite"
      title="Changes save locally and sync when you're back online."
    >
      <span className="sync-pill-dot" aria-hidden="true" />
      {label}
    </div>
  )
}

// ----------------------------------------------------------------------
// Build controller. Owns the source→PDF compile state machine and the
// poll loop. The actual compile runs server-side (tectonic via build.sh,
// triggered by run-job); the app's job is to set the target, kick the run,
// then poll build/status.json until the script writes a verdict.
//
// State machine:
//   idle → building → done   (status.json says {status:'done', pdf,...})
//                   → error  (status.json says {status:'error', log} OR
//                             run-job refused OR the 120s cap elapsed)
//
// status.json 404s the entire time the build is running (the script only
// writes it at the end), so a 404 during polling is "still building", not
// a failure. We cap at BUILD_TIMEOUT_MS so a wedged/never-finishing build
// doesn't poll forever. Exactly one poll timer exists at a time: starting
// a build clears any prior timer first, and unmount clears it too — there
// are never concurrent builds (the Build button is disabled while
// building, and `build()` early-returns if already building).
// ----------------------------------------------------------------------
const BUILD_POLL_MS = 2000
const BUILD_TIMEOUT_MS = 120000
const SOURCE_AUTOSAVE_MS = 700
const SOURCE_SYNC_MS = 3500
const PROJECT_SYNC_MS = 5000

function useBuild({ appId, token, storage, online }) {
  const [buildStatus, setBuildStatus] = useState('idle') // idle|building|done|error
  const [buildLog, setBuildLog] = useState('')
  // Which .tex the current/last build is FOR. The hook tracks one build at a
  // time; this lets the viewer scope "Building…" / "Build failed" to the doc
  // that's actually compiling, so switching to a different doc mid-build
  // doesn't mislabel it.
  const [buildDoc, setBuildDoc] = useState(null)
  // Map of source .tex path → its built .pdf path, so the viewer can show a
  // PDF tab only for documents that have actually been compiled or restored
  // from a previous successful build.
  // doc path → { pdf, ver }. `ver` is a monotonic per-build token (see
  // finishDone) so the viewer refetches even when the compiled path is
  // unchanged across rebuilds.
  const [pdfByDoc, setPdfByDoc] = useState({})
  const pollRef = useRef(null)
  const deadlineRef = useRef(0)
  // Monotonic build counter — sources the `ver` token in pdfByDoc.
  const buildSeqRef = useRef(0)
  // Synchronous in-flight guard. buildStatus lags a render, so it can't gate
  // a rapid double-click on the dirty-file path (build() is deferred behind an
  // async save); this ref flips before any await and is the real guard.
  const buildingRef = useRef(false)

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }, [])

  // Clear the timer on unmount so a poll can't fire into a dead component.
  useEffect(() => clearPoll, [clearPoll])

  const finishDone = useCallback((doc, pdf) => {
    clearPoll()
    buildingRef.current = false
    setBuildStatus('done')
    setBuildLog('')
    if (doc && pdf) {
      // Stamp a fresh token on every successful build. The compiled path is
      // deterministic per doc (files/x.tex always → files/x.pdf), so a rebuild
      // yields the identical string; storing the path alone made finishDone a
      // no-op (prev[doc] === pdf) and the viewer kept the FIRST build's blob.
      // The token gives each build a new value identity so PdfPreview refetches.
      const ver = (buildSeqRef.current += 1)
      setPdfByDoc((prev) => ({ ...prev, [doc]: { pdf, ver } }))
    }
  }, [clearPoll])

  const finishError = useCallback((log) => {
    clearPoll()
    buildingRef.current = false
    setBuildStatus('error')
    setBuildLog(log || 'Build failed.')
  }, [clearPoll])

  // One poll tick: read build/status.json. 404/null → still building (or the
  // cap elapsed → error). A verdict object → done/error. onDone is called
  // with the built pdf path so the caller can flip the viewer + register it.
  const poll = useCallback(async (doc, onDone) => {
    if (Date.now() > deadlineRef.current) {
      finishError('Build timed out (over 2 minutes). The first build downloads '
        + 'LaTeX packages and can be slow — try again, or check the .tex compiles.')
      return
    }
    let status = null
    try {
      status = await storage.get('build/status.json')
    } catch (e) {
      // Transient read failure — keep polling; the deadline still bounds us.
      status = null
    }
    if (status && typeof status === 'object' && status.status) {
      // The verdict echoes the target it was built FROM. build/target.txt +
      // build/status.json are one shared pair per app, so a build kicked from
      // another tab/device for a DIFFERENT doc can land its verdict here.
      // If it isn't the doc we're waiting on, ignore it and keep polling for
      // ours — otherwise we'd map a sibling's PDF onto this doc. (Verdicts
      // predating the `target` field have none and are accepted as before.)
      if (status.target && status.target !== doc) {
        pollRef.current = setTimeout(() => poll(doc, onDone), BUILD_POLL_MS)
        return
      }
      if (status.status === 'done') {
        finishDone(doc, status.pdf)
        if (typeof onDone === 'function' && status.pdf) onDone(doc, status.pdf)
        return
      }
      finishError(status.log || 'Build failed.')
      return
    }
    // Not ready yet (404 → null). Schedule the next tick.
    pollRef.current = setTimeout(() => poll(doc, onDone), BUILD_POLL_MS)
  }, [storage, finishDone, finishError])

  // Kick a build for `doc` (a "files/<name>.tex" path). onDone fires once the
  // PDF is ready. Guards against concurrent builds + offline.
  const build = useCallback(async (doc, onDone) => {
    // Re-entry guard (synchronous, before any await) — see buildingRef. Two
    // near-simultaneous build() calls (rapid double-click on a dirty .tex, whose
    // build is deferred behind an async save while buildStatus is still 'idle')
    // would otherwise both write target.txt and both POST run-job.
    if (buildingRef.current) return
    if (!doc || !doc.endsWith('.tex')) return
    if (!online) {
      finishError('You are offline. Building needs a connection — reconnect and try again.')
      return
    }
    buildingRef.current = true
    clearPoll()
    setBuildDoc(doc)
    setBuildStatus('building')
    setBuildLog('')
    try {
      // 0. Clear any verdict from a PRIOR build. The script only writes
      // status.json when tectonic finishes, so between run-job and that
      // write the OLD status.json still exists — the first poll would read
      // last build's done/error and finish instantly with stale results.
      // Removing it first means a poll sees 404 (still building) until the
      // new run lands a fresh verdict. A 404 on the remove is fine.
      await storage.remove('build/status.json')
      // 1. Tell the build script which file to compile.
      await storage.setText('build/target.txt', doc)
      // 2. Kick the server-side job. 202 = accepted; anything else is fatal.
      const r = await fetch(`/api/apps/${appId}/run-job`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (r.status !== 202) {
        let detail = ''
        try { detail = (await r.json()).detail || '' } catch { /* non-JSON body */ }
        finishError(
          `Could not start the build (server returned ${r.status}${detail ? `: ${detail}` : ''}).`,
        )
        return
      }
      // 3. Poll status.json until the script writes its verdict.
      deadlineRef.current = Date.now() + BUILD_TIMEOUT_MS
      pollRef.current = setTimeout(() => poll(doc, onDone), BUILD_POLL_MS)
    } catch (e) {
      finishError((e && e.message) ? e.message : 'Build failed to start.')
    }
  }, [appId, token, storage, online, clearPoll, finishError, poll])

  const rememberPdf = useCallback((doc, pdf) => {
    if (buildingRef.current) return
    if (!doc || !pdf) return
    setBuildDoc(doc)
    finishDone(doc, pdf)
  }, [finishDone])

  return {
    buildStatus, buildLog, buildDoc, pdfByDoc, build, rememberPdf,
    // Surfaced so the App can drop a doc's PDF mapping when the file is
    // deleted/renamed (the pdf path itself is just another tree entry).
    forgetDoc: useCallback((doc) => {
      setPdfByDoc((prev) => {
        if (!(doc in prev)) return prev
        const next = { ...prev }
        delete next[doc]
        return next
      })
    }, []),
    // Re-key the map across a move/rename. A folder rename re-parents every
    // child AND the move route relocates the compiled .pdf files with them, so
    // both the doc KEY and the stored .pdf path run through the same prefix
    // rewrite — otherwise the viewer loses the just-built PDF for files inside
    // the renamed folder (the old key no longer matches the selection).
    rewriteDocs: useCallback((rewrite) => {
      setPdfByDoc((prev) => {
        const next = {}
        for (const [doc, entry] of Object.entries(prev)) {
          next[rewrite(doc)] = { ...entry, pdf: rewrite(entry.pdf) }
        }
        return next
      })
    }, []),
    // Drop every mapping under a deleted folder (entries are keyed by their
    // source .tex, which lives inside the folder).
    forgetUnder: useCallback((prefix) => {
      setPdfByDoc((prev) => {
        let changed = false
        const next = {}
        for (const [doc, entry] of Object.entries(prev)) {
          if (doc === prefix || doc.startsWith(`${prefix}/`)) { changed = true; continue }
          next[doc] = entry
        }
        return changed ? next : prev
      })
    }, []),
  }
}

// ----------------------------------------------------------------------
// Top-level app.
// ----------------------------------------------------------------------
export default function App({ appId, token }) {
  const storage = useMemo(() => makeStorage(appId, token), [appId, token])
  const online = useOnline()
  const modal = useModal()
  const bodyRef = useRef(null)
  // Hydrate files + recent contents from the localStorage snapshot
  // synchronously on first render so an offline reload has SOMETHING
  // to paint before any storage.get() resolves (or returns null
  // offline). The server still gets fetched on mount and overwrites
  // this with the canonical state when online.
  const cached = useMemo(() => readFileCache(appId), [appId])
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
  useEffect(() => { fileContentRef.current = fileContent }, [fileContent])
  useEffect(() => { fileDirtyRef.current = fileDirty }, [fileDirty])
  useEffect(() => { fileSavingRef.current = fileSaving }, [fileSaving])
  // Outbox depth — surfaced by the SyncPill in the header. Refreshed
  // on every storage write (handled inline at each call site below)
  // and on a 10s background poll.
  const [pending, setPending] = useState(0)
  const [chatHeight, setChatHeight] = useState(() => readChatHeight(appId))
  // Viewer mode, toggled by the [Source | PDF] segmented control in the
  // top bar. 'source' shows the editable CodeMirror editor for the open file;
  // 'pdf' shows the MAIN document's compiled PDF (Overleaf-style — Build
  // always compiles the main file, so the PDF tab shows that one output
  // regardless of which file is currently open).
  const [viewMode, setViewMode] = useState('source')
  // The designated MAIN document — the single root .tex that Build
  // compiles and the PDF view renders. Persisted in main.json and
  // defaulted (below) to the first .tex (preferring files/welcome.tex).
  // null until the index loads + a default is resolved.
  const [mainPath, setMainPath] = useState(null)
  const mainPathRef = useRef(null)
  useEffect(() => { mainPathRef.current = mainPath }, [mainPath])
  const build = useBuild({ appId, token, storage, online })
  const seenBuildStatusRef = useRef('')

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try { localStorage.setItem(chatHeightKey(appId), String(chatHeight)) } catch {}
  }, [appId, chatHeight])

  const resizeChatBy = useCallback((deltaPct) => {
    setChatHeight((value) => Math.min(CHAT_MAX_PCT, Math.max(CHAT_MIN_PCT, value + deltaPct)))
  }, [])

  const beginChatResize = useCallback((event) => {
    event.preventDefault()
    const body = bodyRef.current
    const panel = body?.querySelector?.('.chat-panel')
    if (!body || !panel) return
    const total = body.getBoundingClientRect().height
    if (!total) return
    const startY = event.clientY
    const startHeight = panel.getBoundingClientRect().height
    // Floor at composer height so the chat can be dragged all the way down to a
    // sliver (hide-chat / full-vibe), letting the editor + PDF own the pane.
    const minPx = Math.min(96, total * (CHAT_MIN_PCT / 100))
    const maxPx = Math.max(minPx, total - 180)

    const onMove = (moveEvent) => {
      const nextPx = Math.min(maxPx, Math.max(minPx, startHeight + startY - moveEvent.clientY))
      setChatHeight(Math.min(CHAT_MAX_PCT, Math.max(CHAT_MIN_PCT, (nextPx / total) * 100)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }, [])

  const handleResizeKey = useCallback((event) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      resizeChatBy(4)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      resizeChatBy(-4)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setChatHeight(CHAT_MIN_PCT)
    } else if (event.key === 'End') {
      event.preventDefault()
      setChatHeight(CHAT_MAX_PCT)
    }
  }, [resizeChatBy])

  // Persist the file-cache snapshot whenever the index, contents, or
  // last-selected path change. Bounded above by FILE_CONTENT_CACHE_LIMIT
  // inside writeFileCache. The path field lets an offline reload land
  // on the file the user was last editing instead of bouncing to the
  // first tree entry.
  useEffect(() => {
    writeFileCache(appId, files, fileCache, selectedPath)
  }, [appId, files, fileCache, selectedPath])

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
    if (navOpen) return
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
  }, [navOpen])

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
        if (selectedPath && !cleaned.includes(selectedPath)) {
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
    refreshFiles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    const interval = setInterval(syncProjectFromStorage, PROJECT_SYNC_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') syncProjectFromStorage()
    }
    window.addEventListener('focus', syncProjectFromStorage)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', syncProjectFromStorage)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [online, syncProjectFromStorage])

  // Set a .tex as the main document (from the drawer context menu).
  // Persists immediately so Build + reload agree on the target.
  const handleSetMain = useCallback(async (path) => {
    if (!isSafeStoragePath(path) || !path.endsWith('.tex')) return
    setMainPath(path)
    try {
      await storage.setJSON('main.json', { path })
      refreshPending()
    } catch (e) {
      await modal.alert(e.message || String(e), { title: 'Could not set main document' })
    }
  }, [storage, refreshPending, modal])

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
  }, [syncProjectFromStorage, storage, online])

  // Gate every UI write to files-index.json. Until we've confirmed the
  // index against the server (indexLoaded), `files` may be a stale or
  // empty snapshot; writing a list derived from it would queue an index
  // that drains over the server's real one on reconnect and lose files.
  // Returns true when writing is safe; otherwise tells the user why and
  // returns false so the caller bails before touching storage.
  const ensureIndexWritable = useCallback(async () => {
    if (indexLoaded) return true
    await modal.alert(
      'Your file list hasn’t loaded yet. Reconnect (or wait for it to '
        + 'sync) before adding or deleting files, so this doesn’t '
        + 'overwrite work that’s already saved.',
      { title: 'File list not ready' },
    )
    return false
  }, [indexLoaded, modal])

  const handleCreateFile = useCallback(async () => {
    if (!(await ensureIndexWritable())) return
    const name = await modal.prompt(
      'Path under files/ — e.g. chapter1.tex or notes/draft.md',
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
    try {
      await storage.setText(path, '')
      const next = [...filesRef.current, path].sort()
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      // Seed the cache with the empty body so a subsequent offline
      // reload doesn't show "Not available offline" for a file we
      // just created.
      setFileCache((prev) => ({ ...prev, [path]: '' }))
      setSelectedPath(path)
      closeNav()
      refreshPending()
    } catch (e) {
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
      'Folder name under files/ — e.g. chapter1 or notes/2026',
      { title: 'New folder', placeholder: 'chapter1' },
    )
    if (!name) return
    const clean = name.replace(/^\/+/, '').replace(/\/+$/, '').trim()
    if (!isSafeRelPath(clean)) {
      await modal.alert('Use letters, digits, . - _ / only.', { title: 'Invalid name' })
      return
    }
    const path = `files/${clean}/.keep`
    try {
      await storage.setText(path, '')
      const next = [...filesRef.current, path].sort()
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      refreshPending()
    } catch (e) {
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
      const next = filesRef.current.filter((p) => p !== path)
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
    } catch (e) {
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
        } else {
          // Non-text: PUT the raw blob. We deliberately don't cache the body
          // (binary previews fetch on demand) — same policy as the existing
          // image/pdf path.
          await storage.setBlob(path, f, { contentType: f.type || 'application/octet-stream' })
        }
        added.push(path)
      } catch (e) {
        failed.push(rel)
      }
    }
    if (added.length) {
      const next = [...new Set([...filesRef.current, ...added])].sort()
      try {
        await storage.setJSON('files-index.json', next)
        setFiles(next)
      } catch (e) {
        await modal.alert(e.message || String(e), { title: 'Upload saved but index update failed' })
      }
      refreshPending()
    }
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
        body: JSON.stringify({ from, to }),
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
      const next = [...new Set(filesRef.current.map(rewrite))].sort()
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
      await modal.alert('A name can’t contain “/”. Drag the item to move it.', { title: 'Invalid name' })
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
      const r = await fetch(`/api/storage/apps/${appId}/folder/${folderPath}`, {
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
      const next = filesRef.current.filter((p) => !under(p))
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
    } catch (e) {
      await modal.alert(e.message || String(e), { title: 'Delete failed' })
    }
  }, [appId, token, storage, modal, refreshPending, ensureIndexWritable, build])

  const selectedExt = selectedPath ? extensionFor(selectedPath) : ''
  const selectedIsBinary = selectedPath ? isBinaryProjectPath(selectedPath) : false
  const canEditSelected = !!selectedPath && !selectedIsBinary && !fileLoading && !fileError
  const selectedIsTex = selectedExt === 'tex'
  // Whether there is a compilable main document. The [Source | PDF] toggle
  // and the Build button are meaningful exactly when one exists — Build
  // always compiles the MAIN file and the PDF view shows its output, so both
  // controls track the main doc, not the currently-open file (Overleaf model).
  const hasMain = !!mainPath
  const selectedIsMain = !!selectedPath && selectedPath === mainPath
  // The PDF compiled from the MAIN document this session, if any: a
  // { pdf, ver } record (ver is the build token, see useBuild). The PDF view
  // is gated on this so a never-built doc can't show a blank canvas.
  const pdfForMain = (mainPath && build.pdfByDoc[mainPath]) || null
  // Is the main doc currently building / did its last build fail? (build is
  // single-flight in the hook, keyed by buildDoc.)
  const mainBuilding = build.buildStatus === 'building' && build.buildDoc === mainPath
  const mainBuildError = build.buildStatus === 'error' && build.buildDoc === mainPath

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
    // Never autosave a managed .json path as text/plain — that corrupts it for
    // every typed-JSON reader (see isManagedJsonPath). Such paths are read-only
    // in the editor.
    if (!selectedPath || selectedIsBinary || isManagedJsonPath(selectedPath) || !fileDirty) return undefined
    const path = selectedPath
    const body = fileContent
    const timer = setTimeout(() => {
      if (selectedPathRef.current !== path) return
      setFileSaving(true)
      storage.setText(path, body).then(() => {
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
      })
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
    // Managed .json paths are read-only in the editor — skip the text/plain
    // write that would corrupt them for typed-JSON readers.
    if (!selectedPath || selectedIsBinary || isManagedJsonPath(selectedPath) || fileSaving) return
    setFileSaving(true)
    setFileError(null)
    try {
      await storage.setText(selectedPath, fileContent)
      setFileDirty(false)
      setFileCache((prev) => ({ ...prev, [selectedPath]: fileContent }))
      refreshPending()
    } catch (e) {
      setFileError(e.message || 'Could not save file.')
    } finally {
      setFileSaving(false)
    }
  }, [selectedPath, selectedIsBinary, fileSaving, storage, fileContent, refreshPending])

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
    const kick = () => build.build(mainPath, onBuildDone)
    if (fileDirty && !fileSaving && canEditSelected) {
      handleSaveFile().then(kick, kick)
    } else {
      kick()
    }
  }, [mainPath, fileDirty, fileSaving, canEditSelected, build, onBuildDone, handleSaveFile])

  // The PDF view: the MAIN document's compiled output (with the build's
  // running / failed states), since Build always compiles the main file.
  function renderPdfView() {
    if (!mainPath) {
      return (
        <div className="preview-note">
          No main document set yet. Open the file drawer and long-press a
          .tex file to set it as the main document, then Build.
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
      return <PdfPreview storage={storage} path={pdfForMain.pdf} version={pdfForMain.ver} />
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
    // (static document, no build state).
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(selectedExt)) {
      return <ImagePreview storage={storage} path={selectedPath} />
    }
    if (selectedExt === 'pdf') {
      return <PdfPreview storage={storage} path={selectedPath} />
    }
    // PDF mode (only reachable for .tex selections via the toggle) shows the
    // MAIN document's compiled output.
    if (selectedIsTex && viewMode === 'pdf') {
      return renderPdfView()
    }
    // Otherwise: the editable source for the open text file.
    if (fileLoading) return <div className="preview-note">Loading source…</div>
    if (fileError) return <div className="preview-note">{fileError}</div>
    // Managed .json files (files-index.json, main.json, chat_id.json, etc.) are
    // shown read-only: editing them as text/plain here would corrupt them for
    // every typed-JSON reader, so we don't autosave them. Surface that.
    if (isManagedJsonPath(selectedPath)) {
      return (
        <div className="editor-readonly">
          <div className="readonly-note">
            Managed file — edit via the app, not the source.
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

  // The PDF view shows the MAIN doc's output, so the [Source | PDF] toggle
  // and Build are meaningful while a .tex is open. (Showing them only on a
  // .tex keeps a clean toolbar for images/pdf/other files.)
  const showTexControls = selectedIsTex && hasMain
  const openName = selectedPath ? selectedPath.replace(/^files\//, '') : null

  return (
    <div className="latex-root">
      <style>{CSS}</style>
      <header className="top-bar">
        <button
          ref={navToggleRef}
          className="nav-toggle"
          onClick={toggleNav}
          aria-label={navOpen ? 'Close file drawer' : 'Open file drawer'}
          aria-expanded={navOpen}
        >
          ☰
        </button>
        <div className="top-title">
          {openName
            ? <span className="top-path" title={selectedPath}>{openName}</span>
            : <span className="top-path top-path--muted">No file open</span>}
          {selectedIsMain && <span className="top-main-badge" title="Build compiles this file">Build target</span>}
        </div>
        <div className="top-actions">
          {showTexControls && (
            <>
              <div className="seg-toggle" role="tablist" aria-label="View mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === 'source'}
                  aria-label="View source"
                  title="View source"
                  className={`seg-btn ${viewMode === 'source' ? 'seg-btn--active' : ''}`}
                  onClick={() => setViewMode('source')}
                >
                  <ToolIcon name="source" />
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === 'pdf'}
                  aria-label="View PDF preview"
                  title="View PDF preview"
                  className={`seg-btn ${viewMode === 'pdf' ? 'seg-btn--active' : ''}`}
                  onClick={() => setViewMode('pdf')}
                >
                  <ToolIcon name="preview" />
                </button>
              </div>
              <button
                className="toolbar-btn toolbar-btn--primary"
                onClick={handleBuild}
                disabled={build.buildStatus === 'building'}
                aria-label={build.buildStatus === 'building' ? 'Building the main document' : 'Build the main document'}
                title={`Compile the main document (${mainPath.replace(/^files\//, '')})`}
              >
                <ToolIcon name="build" />
              </button>
            </>
          )}
          <SyncPill online={online} pending={pending} hasRuntime={storage.hasRuntime} />
        </div>
      </header>

      <div
        ref={bodyRef}
        className="body"
        style={{ '--chat-panel-height': `${chatHeight}%` }}
      >
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
        />
        <main className="content">{renderMain()}</main>
        <div
          className="chat-resizer"
          role="separator"
          aria-label="Resize chat and PDF areas"
          aria-orientation="horizontal"
          aria-valuemin={CHAT_MIN_PCT}
          aria-valuemax={CHAT_MAX_PCT}
          aria-valuenow={Math.round(chatHeight)}
          tabIndex={0}
          onPointerDown={beginChatResize}
          onKeyDown={handleResizeKey}
        >
          <span className="chat-resizer-bar" aria-hidden="true" />
        </div>
        <ChatPanel
          appId={appId}
          token={token}
          storage={storage}
          onFilesMaybeChanged={onFilesMaybeChanged}
        />
      </div>
      {modal.node}
    </div>
  )
}

// ----------------------------------------------------------------------
// Styles. Inline so the app is single-file (per spec) and the CSS
// vars resolve against whatever theme the Möbius shell is painting.
// All colors come from var(--bg|--text|--accent|--border|--surface|
// --surface2|--muted|--font); no hard-coded brand colors anywhere.
// ----------------------------------------------------------------------
const CSS = `
.latex-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: var(--bg, #111614);
  color: var(--text, #eef7f1);
  font-family: var(--font, Inter, ui-sans-serif, system-ui, sans-serif);
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
}

.top-bar {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 6px 10px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.nav-toggle {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  min-height: 44px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 16px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.nav-toggle:active { background: var(--surface2); }
.top-title {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.top-path {
  font-family: var(--font);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.top-path--muted { color: var(--muted); font-weight: 400; }
.top-main-badge {
  flex: 0 0 auto;
  padding: 3px 7px;
  border-radius: 7px;
  font: 650 11px/1.2 var(--font);
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
}
.top-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}
/* Icon-only Build button: a square tap target with the play glyph centred. */
.toolbar-btn {
  width: 44px;
  height: 44px;
  min-height: 44px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
}
.toolbar-btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #062016;
}
.toolbar-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ---- segmented source/preview toggle (icon-only) ---- */
.seg-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  padding: 2px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg);
}
.seg-btn {
  width: 40px;
  height: 40px;
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 7px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.seg-btn--active {
  background: var(--surface2, var(--surface));
  color: var(--text);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
}

/* ---- body: content area + bounded chat, stacked ----
   position: relative so the absolutely-positioned file drawer + its
   backdrop resolve against THIS box — i.e. they overlay only the area
   below the top bar, leaving the ☰ toggle always tappable. */
.body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  overflow: hidden;
}
.content {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}
/* ---- source editor (CodeMirror) ---- */
.cm-host {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  background: var(--bg);
}

/* Managed .json files render read-only with an inline notice above the
   source — editing them as text/plain would corrupt them for typed-JSON
   readers, so the editor never autosaves them. */
.editor-readonly {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.readonly-note {
  flex: 0 0 auto;
  padding: 8px 16px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--muted);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

/* ---- empty / notes ---- */
.preview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  color: var(--muted);
  gap: 8px;
  padding: 24px;
}
.preview-empty-title { font-size: 26px; font-weight: 700; color: var(--text); letter-spacing: 0; }
.preview-empty-body { font-size: 14px; line-height: 1.5; max-width: 320px; }

.preview-note {
  color: var(--muted);
  font-size: 13px;
  padding: 24px 18px;
  text-align: center;
  line-height: 1.55;
}
.preview-note b { color: var(--text); }
.build-note { padding: 32px 18px; }
.preview-retry-btn {
  margin-top: 12px;
  min-height: 44px;
  padding: 8px 18px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.preview-retry-btn:active { background: var(--surface2, var(--surface)); }

/* ---- build failure ---- */
.build-error {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
}
.build-error-title {
  font-weight: 700;
  color: var(--danger, var(--accent));
  font-size: 14px;
}
.build-log {
  max-height: 60vh;
  overflow: auto;
  margin: 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---- image preview ---- */
.img-preview {
  display: block;
  max-width: 100%;
  margin: 18px auto;
  border-radius: 6px;
}

/* ---- pdf.js canvas viewer ---- */
.pdf-viewer {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--surface2, var(--surface));
}
.pdf-pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 16px 12px 28px;
}
.pdf-page {
  display: block;
  width: 100%;
  max-width: 820px;
  border-radius: 4px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.28);
  background: #fff;
}

/* ---- file drawer ---- */
.drawer-scrim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease;
  z-index: 10;
}
.drawer-scrim--open { opacity: 1; pointer-events: auto; }
.file-drawer {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 78%;
  max-width: 320px;
  background: var(--surface);
  color: var(--text);
  border-right: 1px solid var(--border);
  transform: translateX(-100%);
  transition: transform 0.22s ease;
  z-index: 11;
  display: flex;
  flex-direction: column;
}
.file-drawer--open { transform: translateX(0); }
.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 52px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
	.drawer-title { display: block; font-size: 14px; font-weight: 700; }
	.drawer-count {
	  display: block;
	  margin-top: 2px;
	  color: var(--muted);
	  font-size: 11px;
	  font-weight: 600;
	}
.drawer-actions {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.drawer-btn {
  flex: 1 1 0;
  min-height: 44px;
  padding: 7px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.drawer-btn:active { background: var(--surface2, var(--surface)); }
.drawer-btn--danger { color: var(--danger); border-color: var(--danger); }
.drawer-btn:disabled { opacity: 0.45; cursor: default; }
.drawer-syncing {
  padding: 8px 14px;
  font-size: 12px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
}
.drawer-tree {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 8px 0;
}
.drawer-empty {
  padding: 16px;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
}
	.tree-file, .tree-folder {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 44px;
  padding: 7px 12px;
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
	  font-family: var(--font);
	  outline: none;
	}
	.tree-file:hover, .tree-folder:hover {
	  background: color-mix(in srgb, var(--accent) 8%, transparent);
	}
	.tree-file:focus-visible, .tree-folder:focus-visible {
	  box-shadow: inset 3px 0 0 var(--accent);
	  background: color-mix(in srgb, var(--accent) 10%, transparent);
	}
.tree-file:active, .tree-folder:active {
  background: var(--surface2, var(--bg));
}
	.tree-file--selected {
	  background: color-mix(in srgb, var(--accent) 22%, var(--surface));
	  color: var(--text);
	  box-shadow: inset 3px 0 0 var(--accent);
	}
	.tree-file--selected .tree-icon { color: var(--accent); }
.tree-main-badge {
  margin-left: auto;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px 2px 4px;
  border-radius: 6px;
  font: 650 9px/1.3 var(--font);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
}
	.tree-file--selected .tree-main-badge {
	  color: var(--accent);
	  background: color-mix(in srgb, var(--accent) 18%, transparent);
	  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
	}
/* Discoverable "set as main document" affordance: a muted target icon on
   the right of every non-main .tex row, brightening on hover/focus. It's the
   visible twin of the context-menu's "Set as main document" item. */
.tree-set-main {
  margin-left: auto;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  color: var(--muted);
  opacity: 0.65;
  cursor: pointer;
}
.tree-set-main:hover,
.tree-set-main:focus-visible {
  color: var(--accent);
  opacity: 1;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  outline: none;
}
.tree-file[draggable="true"] { cursor: grab; }
/* Drop-target highlight while a drag hovers a folder or the root. */
.tree-drop-active {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.tree-root {
  min-height: 40px;
}
.tree-group {
  display: block;
}

/* In-app context menu (right-click / long-press). position: fixed so its
   left/top (set from the pointer's clientX/clientY — viewport coords) land
   exactly under the finger regardless of which positioned ancestor (the
   drawer, .body) it renders inside. Sits above the drawer + modal layers. */
.ctx-menu {
  position: fixed;
  z-index: 60;
  min-width: 160px;
  padding: 4px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ctx-item {
  display: block;
  width: 100%;
  min-height: 44px;
  padding: 8px 10px;
  text-align: left;
  border: none;
  border-radius: 7px;
  background: none;
  color: var(--text);
  font: 550 13px/1.2 var(--font);
  cursor: pointer;
}
.ctx-item:active { background: var(--surface2, var(--surface)); }
.ctx-item--danger { color: var(--danger); }
.tree-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  font-size: 12px;
  color: var(--muted);
  flex: 0 0 auto;
}
.tree-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
/* ---- chat panel (bottom sheet, bounded height) ----
   The embedded shell chat runs inside an iframe (window.mobius.chat).
   The classic flexbox overflow trap is what cut the conversation off:
   the panel needs a BOUNDED height and the embed needs min-height:0
   so the iframe (which has its own internal scroll + a sticky composer)
   can shrink to fit and scroll internally instead of overflowing the
   container and pushing its own composer off-screen. The panel is a
   fixed-height bottom sheet (about 42vh) so the messages + composer are
   always fully visible; flex-shrink keeps it from eating the editor. */
.chat-panel {
  flex: 0 0 auto;
  height: var(--chat-panel-height, 36%);
  min-height: 88px;
  max-height: calc(100% - 180px);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-top: 1px solid var(--border);
}
.chat-resizer {
  flex: 0 0 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ns-resize;
  background: var(--surface);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  touch-action: none;
}
.chat-resizer:hover,
.chat-resizer:focus-visible {
  background: color-mix(in srgb, var(--accent) 12%, var(--surface));
  outline: none;
}
.chat-resizer-bar {
  width: 44px;
  height: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted) 65%, transparent);
}
.chat-head {
  flex: 0 0 auto;
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-height: 34px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.chat-head-title {
  font: 700 11px/1 var(--font);
  color: var(--muted);
}
.chat-head-hint {
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.chat-embed {
  flex: 1 1 auto;
  min-height: 0;          /* the flexbox overflow fix — lets the iframe scroll internally */
  overflow: hidden;
  background: var(--bg);
}
.chat-embed iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
.chat-error {
  flex: 0 0 auto;
  margin: 8px 14px 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--text);
  font-size: 12px;
}

/* ---- modal ---- */
.modal-scrim {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  z-index: 50;
  padding: 16px;
}
.modal {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  width: 100%;
  max-width: 360px;
  padding: 18px 20px;
}
.modal-title {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 8px;
}
.modal-body {
  font-size: 14px;
  line-height: 1.5;
  color: var(--text);
  margin-bottom: 14px;
}
.modal-input {
  display: block;
  width: 100%;
  min-height: 44px;
  padding: 9px 11px;
  font-size: 16px;
  font-family: var(--font);
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  outline: none;
  margin-bottom: 14px;
  box-sizing: border-box;
}
.modal-input:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.modal-btn {
  min-height: 44px;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: var(--font);
}
.modal-btn--primary {
  background: var(--accent);
  color: #062016;
  border-color: var(--accent);
}
.modal-btn--danger {
  background: var(--danger);
  color: #fff;
  border-color: var(--danger);
}
.modal-btn--secondary { background: var(--surface); }

/* ---- sync pill ----
   Bottom-right floating pill that surfaces unsynced writes / offline
   state. Hidden in the steady state (online + 0 pending) so it
   doesn't clutter the preview pane with a persistent "Saved" sticker;
   only appears when there's something to say. Same shape as the
   atlas + gym apps so the platform feels coherent. */
.sync-pill {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  z-index: 40;
  /* Stay above the chat composer so it remains visible while typing. */
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  pointer-events: auto;
}
.sync-pill-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
}
.sync-pill--pending .sync-pill-dot {
  background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
}
.sync-pill--offline {
  border-color: var(--accent);
  color: var(--accent);
}
.sync-pill--offline .sync-pill-dot {
  background: var(--accent);
}

/* The SyncPill component defaults to a floating bottom-right pill (its
   absolute position is shared with other apps). Here it lives inline in
   the header, so un-float it. */
.top-actions .sync-pill {
  position: static;
  right: auto;
  bottom: auto;
  z-index: auto;
  box-shadow: none;
  white-space: nowrap;
}
`
