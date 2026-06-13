import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands'

const APP_VERSION = '2.7.3'

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
// Layout (mobile-first, VSCode-shaped; the top bar + chat split are kept
// structurally IDENTICAL to app-webstudio):
//   - Top bar, three zones: LEFT = the app logo (toggles the left file
//     drawer) + the open file's name; CENTER = the chat toggle; RIGHT = a
//     source/PDF view toggle and a play-triangle Build button (both for
//     .tex only; each icon button carries an aria-label + title).
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
//   - Chat: toggled from the top bar. Opening it splits the body 50/50 —
//     content above, a slim draggable divider in the middle, the embedded
//     agent chat below (composer pinned to the panel bottom). The user
//     describes the document in prose; the sub-agent edits files in
//     /data/apps/<id>/files/ via the Edit and Write tools.
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
  async function getBlobFresh(path) {
    // Server-canonical blob read, bypassing the runtime's cache-first blob
    // mirror. After a build the PDF at a DETERMINISTIC path (files/x.pdf)
    // changes bytes without changing its key, so the mirror hands back the
    // PREVIOUS build's blob. The runtime's plain getBlob is cache-first for a
    // PRESENT blob — it only re-checks the server for an absent/tombstoned key
    // — so falling back to ms.getBlob here returned the stale prior PDF on
    // every rebuild (the "can't see the PDF after building" bug). Prefer the
    // runtime's own fresh getter if it exposes one; otherwise fetch the bytes
    // DIRECTLY with cache:'no-store' so a rebuild's new PDF actually shows.
    // Only a network failure (offline) falls back to the cache-first mirror, so
    // a previously-built PDF still opens without a connection.
    if (ms && typeof ms.getBlobFresh === 'function') return ms.getBlobFresh(path)
    let r
    try {
      r = await fetch(`/api/storage/apps/${appId}/${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
    } catch (netErr) {
      if (ms && typeof ms.getBlob === 'function') return ms.getBlob(path)
      throw netErr
    }
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
    get, getFresh, getBlob, getBlobFresh,
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
// `reloadKey` is bumped by the parent on signals that the open file may have
// been rewritten or deleted server-side (a chat turn finished, or the window
// regained focus after another device touched it). The initial paint reads
// cache-first (getBlob) so an offline reopen is instant; a later reload reads
// getBlobFresh so a same-path REWRITE actually shows new bytes (the cache-first
// mirror would otherwise hand back the stale prior image), and a DELETE
// (blob === null) clears the stale preview to an honest note instead of leaving
// the gone image on screen.
function ImagePreview({ storage, path, reloadKey = 0 }) {
  const [url, setUrl] = useState(null)
  const [err, setErr] = useState(null)
  // Track which path the live `url` belongs to. A path change shows the
  // "Loading…" placeholder (we're switching files); a reloadKey bump on the
  // SAME path keeps the current image painted until the fresh bytes arrive, so
  // a background revalidation doesn't flash the placeholder.
  const shownPathRef = useRef(null)
  // The currently-committed object URL, so the unmount cleanup can revoke
  // whatever is still displayed without the load effect having to (the load
  // effect only owns URLs it created but never committed — see below).
  const committedUrlRef = useRef(null)
  const commitUrl = useCallback((next) => {
    setUrl((prev) => {
      if (prev && prev !== next) URL.revokeObjectURL(prev)
      committedUrlRef.current = next
      return next
    })
  }, [])
  useEffect(() => {
    let live = true
    let created = null
    setErr(null)
    if (shownPathRef.current !== path) {
      // Different file: revoke whatever we were showing and clear to the
      // loading placeholder.
      commitUrl(null)
      shownPathRef.current = path
    }
    // First paint reads cache-first (fast offline); a reload reads fresh so a
    // same-path REWRITE shows new bytes instead of the cache-first mirror's
    // stale prior image.
    const fetcher = reloadKey > 0 && typeof storage.getBlobFresh === 'function'
      ? storage.getBlobFresh(path)
      : storage.getBlob(path)
    fetcher.then((blob) => {
      if (!live) return
      if (!blob) {
        // 404 / deleted: drop the now-stale object URL and show a note rather
        // than keep painting a file that no longer exists.
        commitUrl(null)
        setErr('Image could not be loaded — it may have been deleted.')
        return
      }
      const u = URL.createObjectURL(blob)
      created = u
      commitUrl(u) // committed → owned by state; this run no longer revokes it
      created = null
    }).catch((e) => {
      if (live) setErr(e.message || 'Image load failed.')
    })
    return () => {
      live = false
      // Revoke a URL this run created but didn't commit (fetch resolved after
      // the effect was torn down). The committed URL is revoked on the next
      // swap / path change, or on unmount by the effect below.
      if (created) URL.revokeObjectURL(created)
    }
  }, [storage, path, reloadKey, commitUrl])
  // Unmount-only: revoke the last displayed URL so leaving the image preview
  // doesn't leak the final object URL.
  useEffect(() => () => {
    if (committedUrlRef.current) URL.revokeObjectURL(committedUrlRef.current)
    committedUrlRef.current = null
  }, [])
  if (err) return <div className="preview-note">{err}</div>
  if (!url) return <div className="preview-note">Loading image…</div>
  return <img className="img-preview" src={url} alt={path} />
}

/* zoom-math:begin — pure, dependency-free zoom helpers.
   tests/zoom-math.test.mjs extracts and executes this exact block, so keep
   it plain JS (no JSX, no imports, no references to anything outside it). */

// Continuous zoom bounds for the PDF viewer. 1 = fit-width.
export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 4
const ZOOM_FIT = 1          // fit = pages fill container width
const ZOOM_DOUBLE_TAP = 2   // double-tap toggles fit <-> 2×
const ZOOM_BTN_FACTOR = 1.25 // +/- buttons multiply/divide by this

export function clampScale(scale) {
  if (!Number.isFinite(scale)) return ZOOM_MIN
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale))
}

// Live scale during a pinch: the scale at gesture start times the ratio of
// the current finger distance to the starting finger distance, clamped.
export function pinchScale(startScale, startDist, dist) {
  if (!(startDist > 0) || !(dist > 0)) return clampScale(startScale)
  return clampScale(startScale * (dist / startDist))
}

// After committing a zoom (re-rendering content `ratio` times larger), move
// the scroll position so the content point that sat under the gesture anchor
// stays under it. `originX/originY` are the anchor's offset inside the scroll
// container's viewport; `scrollLeft/scrollTop` are the positions BEFORE the
// re-render. Derivation: the content coordinate under the anchor is
// (scroll + origin); after scaling it lands at (scroll + origin) * ratio, so
// the new scroll that keeps it at `origin` is that minus origin. The browser
// additionally clamps to the scrollable range; we only clamp the lower bound.
export function anchoredZoomScroll({ scrollLeft, scrollTop, originX, originY, ratio }) {
  return {
    scrollLeft: Math.max(0, (scrollLeft + originX) * ratio - originX),
    scrollTop: Math.max(0, (scrollTop + originY) * ratio - originY),
  }
}
/* zoom-math:end */

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
// appendChild/replaceChild — it MUST NOT also carry React children, or
// React would clobber the canvases on its next reconcile; that's why the
// loading note is a SIBLING, not a child of the host.
//
// Zoom model — ONE committed `scale` (1 = fit-width), three gestures:
//   pinch      — continuous; during the gesture a CSS transform (anchored at
//                the pinch midpoint via transform-origin) previews the zoom
//                instantly; on gesture end commitScale() makes it real.
//   double-tap — toggles fit <-> 2× toward the tap point (dblclick on desktop).
//   +/− / fit  — toolbar fallback, anchored at the viewport centre.
// commitScale() resizes the existing canvases synchronously (stretched bitmap
// — instant feedback), converts the scroll position with anchoredZoomScroll()
// so the content under the fingers stays put, then kicks an async crisp
// repaint that swaps each canvas for a freshly rendered one (no blanking).
// One-finger pan is the browser's own scrolling: the viewer is overflow:auto
// with touch-action: pan-x pan-y, so only multi-touch reaches our handlers.
//
// The page gap and host padding are scaled with the zoom (applyPageChrome) so
// the WHOLE content geometry is proportional to `scale` — that's what makes
// the anchoredZoomScroll math exact instead of drifting by the unscaled
// chrome around the pages.
const PDF_PAD_X = 12   // .pdf-pages horizontal padding at scale 1
const PDF_PAD_Y = 16   // .pdf-pages vertical padding at scale 1
const PDF_PAGE_GAP = 14 // gap between pages at scale 1
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_SLOP_PX = 24
const TAP_MOVE_SLOP_PX = 10

function applyPageChrome(host, scale) {
  host.style.gap = `${Math.round(PDF_PAGE_GAP * scale)}px`
  host.style.padding = `${Math.round(PDF_PAD_Y * scale)}px ${Math.round(PDF_PAD_X * scale)}px`
}

function PdfPreview({ storage, path, version }) {
  const scrollRef = useRef(null)  // the scrollable .pdf-viewer wrapper
  const pagesRef = useRef(null)   // the .pdf-pages canvas host
  const docRef = useRef(null)     // the loaded pdfjs document (kept for re-render)
  // Monotonic token: every paint pass takes the next value and aborts as soon
  // as a newer pass (or unmount) bumps it — replaces a boolean "isRendering"
  // lock so a commit during an in-flight repaint supersedes it instead of
  // being dropped.
  const renderTokenRef = useRef(0)

  // `err` is null when fine, otherwise { message, retryable }. We keep a
  // retryable flag so the same render can show a Retry button only when
  // re-attempting could actually help (a transport blip), but NOT for the
  // "not built yet" case where the user should tap Build, or the
  // "not a valid PDF yet" case where re-fetching the same empty bytes won't.
  const [err, setErr] = useState(null)
  const [loading, setLoading] = useState(true)
  // Bumping this re-runs the load effect — the in-app Retry mechanism.
  const [retryNonce, setRetryNonce] = useState(0)

  // The committed zoom. State drives the % readout; the ref is the sync copy
  // gesture closures read (React state reads are async).
  const [scale, setScale] = useState(ZOOM_FIT)
  const scaleRef = useRef(ZOOM_FIT)

  // Synchronously re-geometry the EXISTING canvases for `targetScale` — the
  // bitmaps stretch (blurry until the crisp repaint lands) but layout is
  // instant, so the scroll conversion right after reads correct extents.
  const layoutPages = useCallback((targetScale) => {
    const host = pagesRef.current
    const scroller = scrollRef.current
    if (!host || !scroller) return
    const fitW = Math.max(scroller.clientWidth - 2 * PDF_PAD_X, 120)
    applyPageChrome(host, targetScale)
    const cssW = Math.max(1, Math.round(fitW * targetScale))
    for (const canvas of host.children) {
      const baseW = Number(canvas.dataset.baseW)
      const baseH = Number(canvas.dataset.baseH)
      if (!(baseW > 0) || !(baseH > 0)) continue
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${Math.max(1, Math.round(cssW * (baseH / baseW)))}px`
    }
  }, [])

  // Crisply repaint every page at `targetScale` using the already-loaded
  // docRef (no blob re-fetch). Each page renders into a NEW offscreen canvas
  // that replaces the old one only when finished, so the viewer never blanks.
  const paintPages = useCallback(async (targetScale) => {
    const doc = docRef.current
    const host = pagesRef.current
    const scroller = scrollRef.current
    if (!doc || !host || !scroller) return
    const token = ++renderTokenRef.current
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const fitW = Math.max(scroller.clientWidth - 2 * PDF_PAD_X, 120)
    applyPageChrome(host, targetScale)
    for (let i = 1; i <= doc.numPages; i++) {
      if (token !== renderTokenRef.current) return
      const page = await doc.getPage(i)
      if (token !== renderTokenRef.current) return
      const base = page.getViewport({ scale: 1 })
      const cssW = Math.max(1, Math.round(fitW * targetScale))
      const cssH = Math.max(1, Math.round(cssW * (base.height / base.width)))
      const canvas = document.createElement('canvas')
      canvas.className = 'pdf-page'
      canvas.dataset.baseW = String(base.width)
      canvas.dataset.baseH = String(base.height)
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`
      canvas.width = Math.max(1, Math.round(cssW * dpr))
      canvas.height = Math.max(1, Math.round(cssH * dpr))
      const vp = page.getViewport({ scale: (cssW * dpr) / base.width })
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
      if (token !== renderTokenRef.current) return
      const existing = host.children[i - 1]
      if (existing) host.replaceChild(canvas, existing)
      else host.appendChild(canvas)
    }
    while (host.children.length > doc.numPages) host.removeChild(host.lastChild)
  }, [])

  // Commit a new zoom level, keeping the content under the gesture anchor
  // stationary. anchorX/anchorY are client coords (the pinch midpoint, the
  // tap point, or omitted for the toolbar = viewport centre).
  const commitScale = useCallback((next, anchorX, anchorY) => {
    const scroller = scrollRef.current
    const host = pagesRef.current
    if (!scroller || !host) return
    const prev = scaleRef.current
    const target = clampScale(next)
    if (target === prev) {
      host.style.transform = ''
      host.style.transformOrigin = ''
      return
    }
    const rect = scroller.getBoundingClientRect()
    const originX = (anchorX ?? rect.left + rect.width / 2) - rect.left
    const originY = (anchorY ?? rect.top + rect.height / 2) - rect.top
    const before = { scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop }
    scaleRef.current = target
    setScale(target)
    layoutPages(target)
    host.style.transform = ''
    host.style.transformOrigin = ''
    const converted = anchoredZoomScroll({
      ...before, originX, originY, ratio: target / prev,
    })
    scroller.scrollLeft = converted.scrollLeft
    scroller.scrollTop = converted.scrollTop
    paintPages(target)
  }, [layoutPages, paintPages])

  // Load effect: fetch + initial paint. Runs on storage/path/version/retryNonce changes.
  useEffect(() => {
    let cancelled = false
    setErr(null); setLoading(true)
    // Invalidate any in-flight paint + destroy the prior document.
    renderTokenRef.current += 1
    if (docRef.current) {
      try { docRef.current.destroy && docRef.current.destroy() } catch {}
      docRef.current = null
    }
    ;(async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs'
        let blob
        try {
          // getBlobFresh re-reads from the server (cache:'no-store') so a
          // just-rebuilt PDF at the same path shows the new bytes, not the
          // runtime mirror's stale prior build.
          blob = await storage.getBlobFresh(path)
        } catch (fetchErr) {
          // getBlob throws only for transient/other transport failures (404 is
          // returned as null below); re-fetching may succeed, so make it
          // retryable.
          const e = new Error("Couldn't load the PDF — tap Retry.")
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
        docRef.current = doc
        const host = pagesRef.current
        if (!host) return
        host.innerHTML = ''
        await paintPages(scaleRef.current)
        if (!cancelled) setLoading(false)
      } catch (e) {
        if (cancelled) return
        // A pdf.js parse failure on bytes that aren't a real PDF yet (empty
        // file, or a half-written build) surfaces as MissingPDFException /
        // InvalidPDFException — translate it into an honest, non-alarming note.
        let message = (e && e.message) || 'PDF failed to render.'
        let retryable = !!(e && e.retryable)
        const en = e && e.name
        if (en === 'MissingPDFException' || en === 'InvalidPDFException') {
          message = "This file isn't a valid PDF yet (it may be empty or still building)."
          retryable = false
        }
        setErr({ message, retryable })
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      renderTokenRef.current += 1
      if (docRef.current) {
        try { docRef.current.destroy && docRef.current.destroy() } catch {}
        docRef.current = null
      }
    }
  }, [storage, path, version, retryNonce, paintPages])

  // ----- Pinch + double-tap wiring -----
  // Native listeners (not React synthetic handlers) because React attaches
  // touchstart/touchmove passively at the root, so e.preventDefault() there
  // is a silent no-op — and we MUST preventDefault two-finger moves or the
  // browser treats the pinch as a two-finger pan (allowed by pan-x pan-y).
  const pinchRef = useRef(null)     // live pinch: dist0/scale0/mid/origin/g
  const tapRef = useRef({ t: 0, x: 0, y: 0 })     // last completed tap
  const touchStartRef = useRef(null)               // single-touch start point

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return undefined

    const onTouchStart = (e) => {
      if (e.touches.length === 2) {
        const [a, b] = e.touches
        const host = pagesRef.current
        const hostRect = host ? host.getBoundingClientRect() : null
        const midX = (a.clientX + b.clientX) / 2
        const midY = (a.clientY + b.clientY) / 2
        pinchRef.current = {
          dist0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
          scale0: scaleRef.current,
          midX,
          midY,
          // transform-origin in host coords: the content point under the
          // pinch midpoint, so scaling expands/contracts around the fingers.
          originX: hostRect ? midX - hostRect.left : 0,
          originY: hostRect ? midY - hostRect.top : 0,
          g: 1,
        }
        touchStartRef.current = null
      } else if (e.touches.length === 1) {
        const t = e.touches[0]
        touchStartRef.current = { x: t.clientX, y: t.clientY }
      }
    }

    const onTouchMove = (e) => {
      const p = pinchRef.current
      if (!p || e.touches.length !== 2) return
      e.preventDefault()
      const [a, b] = e.touches
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      const live = pinchScale(p.scale0, p.dist0, dist)
      p.g = live / p.scale0
      const host = pagesRef.current
      if (host) {
        host.style.transformOrigin = `${p.originX}px ${p.originY}px`
        host.style.transform = `scale(${p.g})`
      }
    }

    const onTouchEnd = (e) => {
      const p = pinchRef.current
      if (p) {
        if (e.touches.length >= 2) return
        pinchRef.current = null
        tapRef.current = { t: 0, x: 0, y: 0 }
        commitScale(p.scale0 * p.g, p.midX, p.midY)
        return
      }
      // Double-tap detection: two quick stationary taps near each other.
      if (e.changedTouches.length === 1 && e.touches.length === 0) {
        const t = e.changedTouches[0]
        const start = touchStartRef.current
        touchStartRef.current = null
        if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > TAP_MOVE_SLOP_PX) {
          tapRef.current = { t: 0, x: 0, y: 0 } // it was a pan, not a tap
          return
        }
        const now = Date.now()
        const last = tapRef.current
        if (now - last.t < DOUBLE_TAP_MS
          && Math.hypot(t.clientX - last.x, t.clientY - last.y) < DOUBLE_TAP_SLOP_PX) {
          e.preventDefault() // suppress the synthetic dblclick that would re-fire
          tapRef.current = { t: 0, x: 0, y: 0 }
          const next = scaleRef.current === ZOOM_FIT ? ZOOM_DOUBLE_TAP : ZOOM_FIT
          commitScale(next, t.clientX, t.clientY)
        } else {
          tapRef.current = { t: now, x: t.clientX, y: t.clientY }
        }
      }
    }

    const onTouchCancel = () => {
      const p = pinchRef.current
      pinchRef.current = null
      touchStartRef.current = null
      if (p) commitScale(p.scale0 * p.g, p.midX, p.midY)
    }

    scroller.addEventListener('touchstart', onTouchStart, { passive: true })
    scroller.addEventListener('touchmove', onTouchMove, { passive: false })
    scroller.addEventListener('touchend', onTouchEnd, { passive: false })
    scroller.addEventListener('touchcancel', onTouchCancel)
    return () => {
      scroller.removeEventListener('touchstart', onTouchStart)
      scroller.removeEventListener('touchmove', onTouchMove)
      scroller.removeEventListener('touchend', onTouchEnd)
      scroller.removeEventListener('touchcancel', onTouchCancel)
    }
    // `err` is a dep because the viewer node is unmounted while an error
    // shows — after Retry clears it, the listeners must attach to the NEW node.
  }, [commitScale, err])

  // Desktop equivalent of double-tap (touch double-taps preventDefault their
  // synthetic dblclick, so this never double-fires).
  const onDoubleClick = useCallback((e) => {
    const next = scaleRef.current === ZOOM_FIT ? ZOOM_DOUBLE_TAP : ZOOM_FIT
    commitScale(next, e.clientX, e.clientY)
  }, [commitScale])

  // ----- Zoom toolbar (the +/− fallback) -----
  const zoomIn = useCallback(() => { commitScale(scaleRef.current * ZOOM_BTN_FACTOR) }, [commitScale])
  const zoomOut = useCallback(() => { commitScale(scaleRef.current / ZOOM_BTN_FACTOR) }, [commitScale])
  const zoomFit = useCallback(() => { commitScale(ZOOM_FIT) }, [commitScale])

  const zoomPct = Math.round(scale * 100)
  const atMin = scale <= ZOOM_MIN + 0.001
  const atMax = scale >= ZOOM_MAX - 0.001

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
  // The toolbar floats OVER the scroller (absolute in .pdf-stage) instead of
  // living inside the scroll content: scrolled content is then ONLY the
  // pages host, whose geometry scales uniformly with the zoom — keeping the
  // anchored-zoom scroll conversion exact.
  return (
    <div className="pdf-stage">
      <div className="pdf-zoom-toolbar" aria-label="Zoom controls">
        <button
          type="button"
          className="pdf-zoom-btn"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={zoomOut}
          disabled={atMin}
        >−</button>
        <button
          type="button"
          className="pdf-zoom-btn pdf-zoom-pct"
          aria-label={`Zoom level: ${zoomPct}%`}
          title="Reset to fit width"
          onClick={zoomFit}
        >{zoomPct}%</button>
        <button
          type="button"
          className="pdf-zoom-btn"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={zoomIn}
          disabled={atMax}
        >+</button>
      </div>
      {loading && <div className="preview-note">Rendering PDF…</div>}
      <div className="pdf-viewer" ref={scrollRef} onDoubleClick={onDoubleClick}>
        <div className="pdf-pages" ref={pagesRef} />
      </div>
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

// File-type kind for the tree glyph. The glyph itself is a bare lucide-style
// SVG (see FileGlyph) — the kind only selects which inner mark it draws.
function fileKind(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.tex')) return 'tex'
  if (lower.endsWith('.md')) return 'md'
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.match(/\.(png|jpe?g|gif|webp|svg)$/)) return 'image'
  return 'file'
}

// Bare lucide-style file glyph for the tree (fill none, currentColor stroke,
// round caps — the shared Möbius icon idiom). Inherits the row's text color.
/* mobius-ui:FileGlyph v1 */
function FileGlyph({ name, size = 16 }) {
  const kind = fileKind(name)
  const sharedProps = {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round',
    strokeLinejoin: 'round', 'aria-hidden': true,
  }
  if (kind === 'image') {
    return (
      <svg {...sharedProps}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" />
        <path d="m21 16-5-5L5 20" />
      </svg>
    )
  }
  const page = <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
  const fold = <path d="M14 3v5h5" />
  return (
    <svg {...sharedProps}>
      {page}
      {fold}
      {kind === 'tex' && <path d="M9 13h6M9 16h4M10.5 10l3 0" />}
      {kind === 'md' && <path d="M9 17V11l2 2 2-2v6M15 11h1" />}
      {kind === 'pdf' && <path d="M9 14c0-1.1.9-2 2-2h.5c.8 0 1.5.7 1.5 1.5S12.3 15 11.5 15H11v2" />}
      {kind === 'file' && <path d="M9 14h6M9 17h4" />}
    </svg>
  )
}
/* mobius-ui:FileGlyph end */

// Bare chevron for folder rows — rotates via CSS when the folder is expanded.
/* mobius-ui:ChevronIcon v1 */
function ChevronIcon({ size = 14 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}
/* mobius-ui:ChevronIcon end */

// Inline 24x24 line icons for the top-bar controls, in the same
// stroke=currentColor / strokeWidth=2 / round-cap style as Workout's
// <SportIcon>. The toolbar shows them in icon-only buttons (each with its
// own aria-label + title), so the glyph stands in for the old text label.
//   source  — a code/'</>' glyph (view the .tex source)
//   preview — a document-page glyph (view the compiled PDF)
//   target  — a target/bullseye glyph (the "set as main document" affordance)
const ICON_PATHS = {
  source: <><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></>,
  preview: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <polyline points="14 3 14 8 19 8" />
    </>
  ),
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

// Vertical ⋯ kebab for the per-row actions button. A visible, always-faint
// handle onto the same Rename / Delete / Set-main menu the right-click and
// long-press gestures open — so the destructive action is discoverable on
// touch without a hidden long-press.
function KebabIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="5" r="0.6" />
      <circle cx="12" cy="12" r="0.6" />
      <circle cx="12" cy="19" r="0.6" />
    </svg>
  )
}

function ChatBubbleIcon({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

// Play triangle for the Build action — same component as Web Studio's, so the
// two editor-shaped apps share one primary-action icon.
/* mobius-ui:PlayIcon v1 — keep in sync with app-webstudio */
function PlayIcon({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <path d="M6 4.5 19 12 6 19.5V4.5Z" />
    </svg>
  )
}
/* /mobius-ui:PlayIcon */

// Spinner shown in the Build button while a compile runs (CSS animation on
// .building-spin). Same component as Web Studio's.
/* mobius-ui:BuildingIndicator v1 — keep in sync with app-webstudio */
function BuildingIndicator({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden className="building-spin">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  )
}
/* /mobius-ui:BuildingIndicator */

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
  onContextMenu, onMoveInto, mainPath, onSetMain, openMenuPath, parentPath = '',
}) {
  const [expanded, setExpanded] = useState(true)
  const [dropActive, setDropActive] = useState(false)
  const isFolder = !(node.children.size === 0 && node.isFile)
  // The per-row ⋯ menu is open for THIS row when the open context-menu's
  // anchor path matches ours. Mirrors the shell drawer's Radix trigger, which
  // gets data-state="open" so the lit/accent-tinted kebab visibly belongs to
  // the row whose menu is showing.
  const menuOpen = openMenuPath === node.path
  const longPress = useLongPress((cx, cy) => {
    onContextMenu({ x: cx, y: cy, path: node.path, isFolder })
  })
  // Open the per-row action menu (Set main / Rename / Delete) anchored at the
  // kebab button. Same menu the right-click / long-press gesture opens — the
  // visible ⋯ button just makes those actions (the destructive Delete in
  // particular) discoverable without a hidden long-press.
  const openMenuFromButton = useCallback((e, isFolderItem) => {
    e.preventDefault()
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    onContextMenu({ x: r.right, y: r.bottom, path: node.path, isFolder: isFolderItem })
  }, [node.path, onContextMenu])
  if (node.children.size === 0 && node.isFile) {
    const selected = node.path === selectedPath
    const isMain = node.path === mainPath
    const isTex = node.path.toLowerCase().endsWith('.tex')
    // Discoverable "set as build target" affordance: a visible target button
    // on every .tex that isn't already the build target, alongside the existing
    // right-click / long-press context-menu path (which still works). The
    // current target is marked instead with a single compact accent glyph (the
    // bullseye) — no text chip. We render the control as a role="button" span
    // (not a nested <button>, which is invalid inside the row's own <button>)
    // and stop propagation so tapping it sets the target without also
    // selecting/opening the file.
    const activateSetMain = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (onSetMain) onSetMain(node.path)
    }
    return (
      <div className="tree-row">
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
          <span className="tree-icon"><FileGlyph name={node.name} /></span>
          <span className="tree-name">{node.name}</span>
          {isMain && (
            <span className="tree-main-glyph" title="Build target — Build compiles this file" aria-label="Build target">
              <ToolIcon name="target" size={15} />
            </span>
          )}
          {isTex && !isMain && onSetMain && (
            <span
              className="tree-set-main"
              role="button"
              tabIndex={0}
              aria-label="Set as build target"
              title="Set as build target (Build will compile this file)"
              onClick={activateSetMain}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') activateSetMain(e) }}
            >
              <ToolIcon name="target" size={16} />
            </span>
          )}
        </button>
        <button
          type="button"
          className="tree-menu-btn"
          data-state={menuOpen ? 'open' : undefined}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Actions for ${node.name}`}
          title="File actions"
          onClick={(e) => openMenuFromButton(e, false)}
        >
          <KebabIcon />
        </button>
      </div>
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
            openMenuPath={openMenuPath}
            parentPath=""
          />
        ))}
      </div>
    )
  }
  return (
    <>
      <div className="tree-row">
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
          <span className={`tree-icon tree-chevron${expanded ? ' tree-chevron--open' : ''}`}><ChevronIcon /></span>
          <span className="tree-name">{node.name}/</span>
        </button>
        <button
          type="button"
          className="tree-menu-btn"
          data-state={menuOpen ? 'open' : undefined}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Actions for ${node.name} folder`}
          title="Folder actions"
          onClick={(e) => openMenuFromButton(e, true)}
        >
          <KebabIcon />
        </button>
      </div>
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
              openMenuPath={openMenuPath}
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
// the app-logo toggle in the top bar. It is ALWAYS mounted (the `--open` class
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
  pinned = false,
}) {
  // On desktop (>=860px) the panel is a persistent left rail, never an overlay:
  // it's always visible, the scrim/focus-trap/focus-return don't apply, and
  // swipe-to-close is a no-op.
  const shown = open || pinned
  const root = useMemo(() => buildTree(files), [files])
  const treeRef = useRef(null)
  const drawerRef = useRef(null)
  const dragStart = useRef(null) // { x, y } or null
  const prevOpenRef = useRef(open)

  // Swipe-left-to-close, ported faithfully from the Möbius shell Drawer:
  // touchstart captures the origin (only while open + single touch),
  // touchmove drags the panel 1:1 with the finger when the gesture is
  // dominantly horizontal-left, touchend either closes (>=70px past origin
  // AND horizontal-dominant) or snaps back. The CSS transition is disabled
  // mid-drag via `file-drawer--dragging` so the panel tracks the finger
  // without easing; on release the normal transform-transition animates the
  // snap/close. Scrim-click-to-close stays the separate, intact path.
  const drawerWidth = useCallback(() => {
    const el = drawerRef.current
    if (el && el.offsetWidth) return el.offsetWidth
    return Math.min(window.innerWidth * 0.78, 320)
  }, [])

  const onTouchStart = useCallback((e) => {
    if (!open || e.touches.length !== 1) return
    dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
  }, [open])

  const onTouchMove = useCallback((e) => {
    if (!dragStart.current || e.touches.length !== 1) return
    const dx = e.touches[0].clientX - dragStart.current.x
    const dy = e.touches[0].clientY - dragStart.current.y
    if (dx < 0 && Math.abs(dx) > Math.abs(dy) * 1.15) {
      const el = drawerRef.current
      if (!el) return
      el.classList.add('file-drawer--dragging')
      el.style.transform = `translateX(${Math.max(dx, -drawerWidth())}px)`
    }
  }, [drawerWidth])

  const onTouchEnd = useCallback((e) => {
    if (!dragStart.current) return
    const t = e.changedTouches[0]
    const dx = t.clientX - dragStart.current.x
    const dy = t.clientY - dragStart.current.y
    const shouldClose = dx < -70 && Math.abs(dx) > Math.abs(dy) * 1.35
    const el = drawerRef.current
    if (el) {
      el.classList.remove('file-drawer--dragging')
      if (shouldClose) {
        // Animate from the drag position to closed, then clear the inline
        // transform after the transition so the next open doesn't start from
        // translateX(-100%) inline (which would fight .file-drawer--open).
        el.style.transform = 'translateX(-100%)'
        const cleanup = () => {
          if (el) el.style.transform = ''
          el.removeEventListener('transitionend', cleanup)
        }
        el.addEventListener('transitionend', cleanup, { once: true })
      } else {
        // Snap back to open: clearing the inline transform lets the
        // .file-drawer--open class's translateX(0) take over with the
        // transition running from the drag position.
        el.style.transform = ''
      }
    }
    dragStart.current = null
    if (shouldClose) onClose?.()
  }, [onClose])

  // touchcancel positions are unreliable (clientX can be 0 or stale);
  // treat cancel as "snap back, don't close" — never evaluate the threshold.
  const onTouchCancel = useCallback(() => {
    const el = drawerRef.current
    if (el) {
      el.classList.remove('file-drawer--dragging')
      el.style.transform = ''
    }
    dragStart.current = null
  }, [])
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
    // Pinned (desktop rail) never opens/closes, so don't auto-move focus into
    // it on mount or yank focus back to the toggle — it's just part of the page.
    if (pinned) { prevOpenRef.current = open; return }
    const wasOpen = prevOpenRef.current
    prevOpenRef.current = open
    if (open && !wasOpen) {
      const raf = requestAnimationFrame(focusSelectedOrFirst)
      return () => cancelAnimationFrame(raf)
    }
    if (!open && wasOpen) {
      returnFocusRef?.current?.focus?.()
    }
  }, [focusSelectedOrFirst, open, returnFocusRef, pinned])

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

  // Context actions. A .tex file additionally offers "Set as build target"
  // (unless it already is the target) so the user can pick which file Build
  // compiles, Overleaf-style. The choice persists to main.json and Build
  // writes it to build/target.txt.
  const ctxItems = ctx ? [
    ...(!ctx.isFolder && ctx.path.endsWith('.tex') && ctx.path !== mainPath
      ? [{ label: 'Set as build target', onSelect: () => onSetMain(ctx.path) }]
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
      {/* No scrim for the pinned desktop rail — it doesn't overlay content. */}
      {!pinned && (
        <div
          className={`drawer-scrim ${open ? 'drawer-scrim--open' : ''}`}
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        ref={drawerRef}
        className={`file-drawer ${shown ? 'file-drawer--open' : ''} ${pinned ? 'file-drawer--pinned' : ''}`}
        aria-label="File tree"
        aria-hidden={!shown}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      >
        <div className="drawer-head">
          <div className="drawer-head-text">
            <span className="drawer-title">Files</span>
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
              openMenuPath={ctx ? ctx.path : null}
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
//
// In Read/Edit modes the chat rides inside a window.mobius.split() container
// (pill ↔ split ↔ full) when that API is available. When absent (older shell)
// we fall back to the bespoke chatHeight bottom-panel — identical behavior to
// the previous version. The split path and the fallback path are clearly
// fenced so they never touch each other's layout state.
// ----------------------------------------------------------------------
function bootstrapPrompt() {
  return [
    "You help the user write and compile their LaTeX documents in this app.",
    "Use the embedded-app-agent skill, which carries the full methodology;",
    "rely on the injected app_context for this app's id, file paths, and",
    "build commands.",
    "",
    "This is a silent setup brief — do NOT reply to it. Wait for the",
    "user's first message and act on that.",
  ].join('\n')
}

// Parse build log lines starting with "! " into ≤3 error chip strings.
// Returns an empty array when the log is empty or has no such lines.
export function parseBuildErrorChips(log) {
  if (!log || typeof log !== 'string') return []
  return log
    .split('\n')
    .filter((l) => l.startsWith('! '))
    .map((l) => l.slice(2).trim())
    .filter(Boolean)
    .slice(0, 3)
}

// ---------------------------------------------------------------------------
// ChatPanel — the bottom half of the 50/50 chat split. Fills the height the
// body allots it (via --chat-ratio) as a flex column; the embedded chat
// iframe fills the column, so its composer is pinned to the panel's bottom.
// ---------------------------------------------------------------------------
function ChatPanel({
  appId, token, storage,
  onFilesMaybeChanged,
  quickActions,
  getContext,
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
  const quickActionsRef = useRef(quickActions)
  useEffect(() => { quickActionsRef.current = quickActions }, [quickActions])
  const getContextRef = useRef(getContext)
  useEffect(() => { getContextRef.current = getContext }, [getContext])
  const systemPrompt = useMemo(() => bootstrapPrompt(), [])

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
      title: 'LaTeX',
      systemPrompt,
      picker: true,
      quickActions: quickActionsRef.current,
      getContext: () => {
        const fn = getContextRef.current
        return fn ? fn() : null
      },
      onTurnDone: () => { if (onFilesRef.current) onFilesRef.current() },
      onError: ({ error: e }) => { setError(typeof e === 'string' ? e : 'Embedded chat reported an error.') },
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
    <section className="chat-panel" aria-label="Agent chat">
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

function fileCacheKey(appId) {
  return `latex:${appId}:files-cache:v${FILE_CACHE_VERSION}`
}

// Chat toggle model.
// chatOpen: boolean (panel visible); chatRatio: 0..1 (fraction of body height).
const CHAT_OPEN_VERSION = 1
const CHAT_RATIO_VERSION = 1

// The chat pane must never collapse smaller than the embedded composer's input
// pill — the owner spec is "down to the top of the input pill but not more and
// not less". The embed runs the real ChatView in an opaque iframe and publishes
// no composer-height var, so we floor the pane at the standard Möbius composer
// pill height (~64px) plus the divider (10px). The message list above the pill
// can collapse to zero; the pill itself always stays fully visible and usable.
// The same floor caps the OTHER end so the editor never fully eats the chat.
const CHAT_PILL_MIN_PX = 64
const CHAT_DIVIDER_PX = 10
const CHAT_PANE_MIN_PX = CHAT_PILL_MIN_PX + CHAT_DIVIDER_PX

// Clamp a desired chat-pane height (px) into [pill, total - pill] and return it
// as a 0..1 ratio of the body. When the body is shorter than two pills, fall
// back to a 50/50 split so neither pane vanishes. Pure — unit-testable.
/* chat-bounds:begin (kept pure + dependency-free so a test can extract it) */
export function clampChatRatio(desiredPx, total, minPx) {
  if (!(total > 0)) return 0.5
  const floor = minPx
  const ceil = total - minPx
  // Body too short to honor both floors: split evenly rather than clip a pill.
  if (ceil <= floor) return 0.5
  const px = Math.max(floor, Math.min(ceil, desiredPx))
  return px / total
}
/* chat-bounds:end */

function chatOpenKey(appId) { return `latex:${appId}:chat-open:v${CHAT_OPEN_VERSION}` }
function chatRatioKey(appId) { return `latex:${appId}:chat-ratio:v${CHAT_RATIO_VERSION}` }

function readChatOpen(appId) {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(chatOpenKey(appId)) === 'true'
}

function readChatRatio(appId) {
  if (typeof localStorage === 'undefined') return 0.5
  const raw = Number(localStorage.getItem(chatRatioKey(appId)))
  if (!Number.isFinite(raw) || raw <= 0 || raw >= 1) return 0.5
  return Math.max(0.05, Math.min(0.95, raw))
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
function SyncPill({ online, hasRuntime }) {
  if (!hasRuntime) return null
  // Only surface the genuinely actionable state: offline. Local saves are
  // instant and reliable, so an outbox count ("Saving · N pending") is
  // internal plumbing the owner shouldn't have to read — and it flickered on
  // every keystroke. A clean, online editor shows nothing.
  if (online) return null
  return (
    <div
      className="sync-pill sync-pill--offline"
      role="status"
      aria-live="polite"
      title="Changes save locally and sync when you're back online."
    >
      <span className="sync-pill-dot" aria-hidden="true" />
      Offline
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
      // Pull the just-built PDF from the server BEFORE PdfPreview re-reads it,
      // so the runtime's cache-first blob mirror holds the new bytes (and not
      // the prior build's tombstoned/stale blob) when the viewer asks. Fire-
      // and-forget: PdfPreview's own getBlob is the real read; this just warms
      // the cache so the fresh PDF shows immediately on build-done.
      storage.getBlobFresh(pdf).catch(() => {})
    }
  }, [clearPoll, storage])

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
  const build = useBuild({ appId, token, storage, online })
  const seenBuildStatusRef = useRef('')
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
  }, [syncProjectFromStorage, storage, online, bumpPreviewReload])

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
      try { if (window.mobius?.signal) window.mobius.signal('item_created', { type: 'tex-file' }) } catch (sigErr) {}
    } catch (e) {
      try { if (window.mobius?.signal) window.mobius.signal('error', { message: e.message || String(e), source: 'create-file' }) } catch (sigErr) {}
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
  // The PDF compiled from the MAIN document this session, if any: a
  // { pdf, ver } record (ver is the build token, see useBuild). The PDF view
  // is gated on this so a never-built doc can't show a blank canvas.
  const pdfForMain = (mainPath && build.pdfByDoc[mainPath]) || null
  // Is the main doc currently building / did its last build fail? (build is
  // single-flight in the hook, keyed by buildDoc.)
  const mainBuilding = build.buildStatus === 'building' && build.buildDoc === mainPath
  const mainBuildError = build.buildStatus === 'error' && build.buildDoc === mainPath

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
  const signalReadySentRef = useRef(false)
  useEffect(() => {
    if (!indexLoaded || signalReadySentRef.current) return
    signalReadySentRef.current = true
    try {
      if (window.mobius?.signal) {
        window.mobius.signal('app_ready', { item_count: files.length, version: APP_VERSION })
      }
    } catch (e) {}
  }, [indexLoaded, files.length])

  // Fire build_succeeded / build_failed when the build status transitions.
  const prevBuildStatusRef = useRef(build.buildStatus)
  useEffect(() => {
    const prev = prevBuildStatusRef.current
    const cur = build.buildStatus
    prevBuildStatusRef.current = cur
    if (!window.mobius?.signal) return
    if (prev === 'building' && cur === 'done') {
      try { window.mobius.signal('build_succeeded', { doc: build.buildDoc || undefined }) } catch (e) {}
    } else if (prev === 'building' && cur === 'error') {
      try { window.mobius.signal('build_failed', { doc: build.buildDoc || undefined }) } catch (e) {}
    }
  }, [build.buildStatus, build.buildDoc])
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
    // (static document, no build state). Both take previewReloadKey so a
    // same-path rewrite/delete by the agent (or another device) re-fetches
    // fresh bytes instead of stranding the stale preview on screen.
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(selectedExt)) {
      return <ImagePreview storage={storage} path={selectedPath} reloadKey={previewReloadKey} />
    }
    if (selectedExt === 'pdf') {
      return <PdfPreview storage={storage} path={selectedPath} version={previewReloadKey} />
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

  // The editable source for the open text file (or a read-only view of a
  // managed .json). Extracted so the desktop split can place it beside the PDF.
  function renderEditor() {
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
          appId={appId}
          token={token}
          storage={storage}
          onFilesMaybeChanged={onFilesMaybeChanged}
          quickActions={quickActions}
          getContext={getContext}
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
      {/* Three-zone top bar: left = drawer toggle + open filename, center =
          the chat toggle, right = view toggle + Build (+ sync pill). The grid
          is 1fr auto 1fr so the chat toggle sits in the visual centre of the
          bar. Identical structure in app-webstudio (ws- prefixed). */}
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
              width={26}
              height={26}
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
        <div className="top-zone top-zone--center">
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
        </div>
      </header>

      {/* Error chips float over the content area when build fails */}
      {renderErrorChips()}

      {renderBody()}

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
/* mobius-ui:Focus v1 -- shared keyboard focus ring (WCAG 2.4.7); never bare outline:none */
:where(button,a,input,textarea,select,summary,[role="button"],[tabindex]:not([tabindex="-1"])):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
/* /mobius-ui:Focus */

/* mobius-ui:Root v1 */
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

/* mobius-ui:Toolbar v1 — keep in sync with app-webstudio (ws- prefixed) */
/* Three-zone bar: 1fr | auto | 1fr puts the centre zone (the chat toggle) in
   the visual middle of the bar; the side zones flex + truncate. */
.top-bar {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  min-height: 48px;
  /* Top-pinned bar: clear the notch / Dynamic Island and pad the sides past
     the rounded-corner / gesture insets on a full-screen PWA. */
  padding: max(6px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) 6px max(10px, env(safe-area-inset-left));
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  user-select: none;
}
.top-zone {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.top-zone--left { justify-content: flex-start; }
.top-zone--center { flex: 0 0 auto; justify-content: center; }
.top-zone--right { justify-content: flex-end; }
/* The logo-as-toggle: a bare 44px tap target holding the app icon, so the
   logo (not a hamburger) opens the file drawer — mirroring the Möbius shell. */
.nav-toggle {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  min-height: 44px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 16px;
  cursor: pointer;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  outline: none;
  -webkit-tap-highlight-color: transparent;
  -webkit-user-select: none;
  user-select: none;
}
/* Bare like the Möbius shell's .shell__brand: closing the drawer must leave
   NO highlight or bounding box, so no :active background and no focus ring
   on either :focus or :focus-visible. */
.nav-toggle:focus,
.nav-toggle:focus-visible { outline: none; }
/* The real app icon as the brand mark inside the drawer toggle. */
.latex-brand-icon {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  object-fit: cover;
  flex-shrink: 0;
  display: block;
}
/* Accent-dot fallback shown when the install has no custom icon (route 404s). */
.latex-brand-fallback {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent, var(--text));
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.top-title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.top-path {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.top-path--muted { color: var(--muted); font-weight: 400; }
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
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
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
.toolbar-btn:active { background: var(--surface2, var(--surface)); }
.toolbar-btn--primary:active { background: color-mix(in srgb, var(--accent) 80%, #000); }
@media (hover: hover) {
  .toolbar-btn:hover:not(:disabled) { background: var(--surface2, var(--surface)); }
  .toolbar-btn--primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 85%, #000); }
}
.chat-toggle-btn[aria-pressed="true"] {
  background: color-mix(in srgb, var(--accent) 18%, var(--surface));
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}
/* Build-button spinner (BuildingIndicator) — same recipe as app-webstudio. */
@keyframes building-spin { to { transform: rotate(360deg); } }
.building-spin {
  animation: building-spin 1.1s linear infinite;
  transform-origin: center;
}

/* ---- source/preview view toggle: bare icon buttons, matching Web
   Studio's top bar (no pill container — the active button carries the
   accent tint, same recipe as .ws-icon-btn[aria-pressed=true]). ---- */
.seg-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 6px;
}
.seg-btn {
  width: 44px;
  height: 44px;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.seg-btn--active {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  color: var(--accent);
}
.seg-btn:active { background: var(--surface2, var(--surface)); }
@media (hover: hover) {
  .seg-btn:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); color: var(--text); }
}

/* ---- body: content area + bounded chat, stacked ----
   position: relative so the absolutely-positioned file drawer + its
   backdrop resolve against THIS box — i.e. they overlay only the area
   below the top bar, leaving the logo toggle always tappable. */
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
.preview-empty-title { font-size: 26px; font-weight: 700; color: var(--text); }
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
  /* Same JetBrains Mono token as the CodeMirror scroller it sits beside, so
     the build log doesn't diverge from the source editor's typeface. */
  font: 12px/1.5 var(--mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
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
/* Stage = positioning context for the floating zoom toolbar; the scroller
   below it holds ONLY the pages host, so all scrolled content scales
   uniformly with the zoom (keeps the anchored-zoom scroll math exact). */
.pdf-stage {
  position: relative;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pdf-viewer {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  background: var(--surface2, var(--surface));
  /* One-finger pan is the browser's own scrolling (both axes); only
     multi-touch (pinch) reaches our handlers. */
  touch-action: pan-x pan-y;
  overscroll-behavior: contain;
  position: relative;
  /* Classic (non-overlay) scrollbars shrink clientWidth after the first
     paint, so fit-width computed pre-scrollbar overflows ~15px. Reserving
     the gutter keeps clientWidth stable from the start. */
  scrollbar-gutter: stable;
}
/* Floating zoom pill — overlays the top of the viewer (it must NOT live in
   the scroll content: unscaled chrome there would skew the zoom scroll
   conversion). Backdrop-blurred so page content reads through it. */
.pdf-zoom-toolbar {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 6px;
  background: color-mix(in srgb, var(--surface) 80%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--border);
  border-radius: 999px;
  user-select: none;
  -webkit-user-select: none;
}
.pdf-zoom-btn {
  min-height: 44px;
  min-width: 44px;
  padding: 6px 10px;
  border-radius: 7px;
  border: none;
  background: none;
  color: var(--text);
  font-family: var(--font);
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.pdf-zoom-btn:disabled { opacity: 0.35; cursor: default; }
.pdf-zoom-btn:active:not(:disabled) { background: var(--surface2, var(--surface)); }
@media (hover: hover) {
  .pdf-zoom-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 10%, transparent); }
}
/* The % readout button is slightly wider to fit the text. */
.pdf-zoom-pct {
  font-size: 13px;
  min-width: 56px;
  font-variant-numeric: tabular-nums;
}
/* Pages host. gap + padding are set inline (scaled with the zoom — see
   applyPageChrome). width: max-content + min-width: 100% so a zoomed-in host
   grows past the viewport and stays fully reachable by scrolling (a centered
   flex child wider than its scroller would clip its left edge). */
.pdf-pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: max-content;
  min-width: 100%;
  box-sizing: border-box;
}
.pdf-page {
  display: block;
  border-radius: 4px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.28);
  background: #fff;
}

/* mobius-ui:FileTree v1 */
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
/* While the finger drags, kill the transform-transition so the panel tracks
   1:1; on release the inline class is removed and the normal transition
   animates the snap-back or close. Mirrors the shell's .drawer--dragging. */
.file-drawer--dragging { transition: none; }
.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 52px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.drawer-head-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.drawer-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  line-height: 1.2;
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
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
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
	/* Each tree row pairs the (flex-growing) file/folder button with a trailing
	   ⋯ menu button. The row is the hover unit so the menu button reveals with
	   the row on a pointer device; on touch it stays visible (see below). */
	.tree-row {
	  display: flex;
	  align-items: stretch;
	  width: 100%;
	}
	.tree-file, .tree-folder {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 44px;
  padding: 7px 12px;
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
	  font-family: var(--font);
	  -webkit-tap-highlight-color: transparent;
	  touch-action: manipulation;
	  user-select: none;
	  -webkit-user-select: none;
	}
	/* The inset accent bar is the pointer/keyboard cue; only suppress the
	   default ring for non-keyboard focus so :focus-visible still rings. */
	.tree-file:focus:not(:focus-visible),
	.tree-folder:focus:not(:focus-visible) { outline: none; }
	/* Per-row ⋯ actions button: faint until the row is hovered/focused so it
	   doesn't compete with the filename; on touch (no hover) it stays visible so
	   the actions — Delete in particular — are reachable without a long-press. */
	.tree-menu-btn {
	  flex: 0 0 auto;
	  width: 40px;
	  min-height: 44px;
	  display: inline-flex;
	  align-items: center;
	  justify-content: center;
	  border: none;
	  background: none;
	  color: var(--muted);
	  cursor: pointer;
	  opacity: 0.5;
	  transition: opacity 0.12s ease, color 0.12s ease;
	}
	.tree-row:hover .tree-menu-btn,
	.tree-menu-btn:focus-visible { opacity: 1; }
	.tree-menu-btn:hover { color: var(--text); }
	.tree-menu-btn:active { color: var(--accent); }
	/* Pressed/open state — while this row's action menu is open the kebab stays
	   lit and accent-tinted (accent text + a subtle --accent-dim wash), the same
	   treatment the shell drawer's kebab gets via data-state="open". It overrides
	   the touch opacity reveal so the open menu visibly belongs to this row, and
	   :active gives the same feedback on the press itself (touch has no hover). */
	.tree-menu-btn[data-state="open"],
	.tree-menu-btn:active {
	  opacity: 1;
	  color: var(--accent);
	  background: var(--accent-dim, color-mix(in srgb, var(--accent) 12%, transparent));
	}
	@media (hover: none) {
	  .tree-menu-btn { opacity: 1; }
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
/* The main / build-target marker: ONE compact accent glyph (the bullseye) on
   that row — no text chip. Replaces both the old in-tree "main" badge and the
   removed top-bar "Build target" chip. */
.tree-main-glyph {
  margin-left: auto;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--accent);
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

/* mobius-ui:ContextMenu v1 */
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
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  user-select: none;
  -webkit-user-select: none;
}
.ctx-item:active { background: var(--surface2, var(--surface)); }
.ctx-item--danger { color: var(--danger); }
/* File/folder glyph: a BARE glyph like the Möbius shell drawer's icons
   (.drawer__item-icon) — no border, no background fill, no boxed padding.
   Just the glyph, centred in a fixed inline slot for column alignment, in
   the muted text color (the selected/main rows tint it via --accent). */
.tree-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--muted);
  background: none;
  flex: 0 0 auto;
}
.tree-icon svg { display: block; }
/* Folder chevron points right when collapsed, rotates down when expanded. */
.tree-chevron {
  transition: transform 0.12s ease;
}
.tree-chevron--open {
  transform: rotate(90deg);
}
.tree-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
/* mobius-ui:ChatEmbed v1 — keep in sync with app-webstudio (ws- prefixed) */
/* ---- chat panel (bottom half of the 50/50 split) ----
   The embedded shell chat runs inside an iframe (window.mobius.chat). The
   panel takes the height --chat-ratio allots it, floored at --chat-pane-min
   (= composer pill + divider, the 74px CHAT_PANE_MIN_PX constant) so the
   embed's input pill is never clipped, and capped at the same floor from the
   other end so the editor never fully eats the chat. The drag/keyboard ratio
   math already honors these bounds; the CSS floor also covers the persisted /
   default ratio on a short viewport before any drag. It's a flex column; the
   embed fills it (flex:1 + min-height:0) and the iframe fills the embed, so
   the chat's composer is pinned to the bottom of the panel. */
.chat-panel {
  flex: 0 0 auto;
  height: calc(var(--chat-ratio, 0.5) * 100%);
  min-height: min(var(--chat-pane-min, 74px), 100%);
  max-height: calc(100% - var(--chat-pane-min, 74px));
  display: flex;
  flex-direction: column;
  background: var(--surface);
  overflow: hidden;
  overscroll-behavior: contain;
  /* Bottom-pinned sheet: lift the embedded chat composer above the iPhone
     home-indicator / Android gesture bar on a full-screen PWA. */
  padding-bottom: env(safe-area-inset-bottom);
}
/* The draggable divider ("glider") between content and chat: a SLIM 10px
   visual bar; the ::before overlay extends the pointer hit area to ~26px
   without adding visual weight. z-index keeps the overlay above the
   adjacent panes so the extra hit area actually receives the pointer. */
.chat-divider {
  flex: 0 0 10px;
  height: 10px; /* explicit: the desktop grid ignores flex-basis */
  box-sizing: border-box;
  position: relative;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ns-resize;
  background: var(--surface);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  touch-action: none;
  user-select: none;
}
.chat-divider::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -8px;
  bottom: -8px;
}
.chat-divider:hover,
.chat-divider:focus-visible {
  background: color-mix(in srgb, var(--accent) 12%, var(--surface));
}
.chat-divider:focus-visible { outline-offset: -2px; }
.chat-divider-bar {
  width: 44px;
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted) 65%, transparent);
  pointer-events: none;
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
/* ---- Error chips (float above the main area when build fails) ----
   Up to 3 dismissible chips float at the top of the content area; tapping
   "Fix" switches to Chat and pre-fills the composer. */
.error-chips {
  position: absolute;
  top: 52px; /* just below the top-bar */
  left: 0;
  right: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  pointer-events: none; /* chips themselves have pointer-events: auto */
}
.error-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--surface);
  border: 1px solid color-mix(in srgb, var(--danger, var(--accent)) 55%, var(--border));
  border-radius: 8px;
  padding: 6px 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  pointer-events: auto;
  max-width: 100%;
}
.error-chip-text {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--danger, var(--text));
  font-family: var(--mono, ui-monospace, monospace);
}
.error-chip-fix {
  flex: 0 0 auto;
  min-height: 28px;
  padding: 3px 10px;
  border-radius: 5px;
  border: none;
  background: var(--accent);
  color: #062016;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.error-chip-fix:active { filter: brightness(0.9); }
.error-chip-dismiss {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: 5px;
  border: none;
  background: none;
  color: var(--muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  -webkit-tap-highlight-color: transparent;
}
.error-chip-dismiss:hover { color: var(--text); }
.error-chip-dismiss:active { background: var(--surface2, var(--surface)); }

/* mobius-ui:Sheet v1 */
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
  margin-bottom: 14px;
  box-sizing: border-box;
}
/* Border-tint + inner ring is the focus cue; suppress the default outline
   only for non-keyboard focus so :focus-visible still gets the shared ring. */
.modal-input:focus:not(:focus-visible) { outline: none; }
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
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.modal-btn:active { filter: brightness(0.92); }
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

/* mobius-ui:SyncPill v1 */
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
.top-zone--right .sync-pill {
  position: static;
  right: auto;
  bottom: auto;
  z-index: auto;
  box-shadow: none;
  white-space: nowrap;
}

/* mobius-ui:Desktop v1 -- at >=860px the phone stack becomes the Overleaf
   three-pane layout: a persistent file-tree rail, then a two-pane editor/PDF
   split (handled in renderMain), with the chat docked below the split. The
   body switches from a vertical flex stack to a CSS grid: the rail spans all
   rows in column 1; content / divider / chat fill column 2. The .split itself
   caps the editor measure so source doesn't stretch edge-to-edge on a monitor. */
@media (min-width: 860px) {
  .body {
    display: grid;
    grid-template-columns: 264px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto auto;
  }
  /* Chat open: row 3 takes the --chat-ratio share of the body height (the
     panel's own %-height rule is neutralised below — the grid row IS the
     height in this layout), clamped between --chat-pane-min (pill + divider)
     and (100% - that) so the embed's input pill is never clipped at either end. */
  .body--chat-open {
    grid-template-rows: minmax(0, 1fr) auto
      clamp(
        var(--chat-pane-min, 74px),
        calc(var(--chat-ratio, 0.5) * 100%),
        calc(100% - var(--chat-pane-min, 74px))
      );
  }
  /* The pinned rail: a static left column, not an overlay. Spans all rows. */
  .file-drawer--pinned {
    position: static;
    grid-column: 1;
    grid-row: 1 / -1;
    width: auto;
    max-width: none;
    transform: none;
    border-right: 1px solid var(--border);
  }
  /* Content / divider / chat stack down the right column. */
  .content { grid-column: 2; grid-row: 1; }
  .chat-divider { grid-column: 2; grid-row: 2; }
  .chat-panel { grid-column: 2; grid-row: 3; height: auto; }
  /* Two-pane editor/PDF split. The editor measure is capped so long source
     lines stay readable; the PDF pane takes the remaining width. */
  .split { display: flex; flex: 1 1 auto; height: 100%; min-height: 0; }
  .split-editor {
    flex: 0 1 620px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    overflow: hidden;
  }
  .split-pdf { flex: 1 1 0; min-width: 0; overflow: hidden; }
  /* Single-pane prose states (build errors, notes, the empty placeholder) get
     a comfortable reading measure instead of stretching the full window. */
  .preview-note, .build-error {
    max-width: 760px;
    margin-left: auto;
    margin-right: auto;
  }
  /* Error chips: tuck below the top-bar, absolute within the root. */
  .error-chips { top: 54px; }
}

/* mobius-ui:ReducedMotion v1 -- honor the OS reduce-motion setting */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
/* /mobius-ui:ReducedMotion */
`
