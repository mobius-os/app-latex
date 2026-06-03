import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react'
import DOMPurify from 'https://esm.sh/dompurify@3'

// Defense-in-depth sanitizer for the two `dangerouslySetInnerHTML`
// surfaces in this app. The HTML these surfaces inject is built
// entirely on-device from local files: the .tex tokenizer
// runs escapeHtml() over every text segment before re-allowing a
// fixed whitelist (\textbf{}, \emph{}, umlauts); the markdown
// renderer runs escapeHtml() over every line before applying its
// own bold/italic/code/link regex. KaTeX writes its rendered math
// imperatively into empty spans (no innerHTML on user data) with
// throwOnError disabled. The injected HTML should therefore be safe
// by construction — but the agent CAN write files on the user's
// behalf, and a poisoned .tex/.md landing on disk would otherwise
// flow straight into the DOM with the owner's JWT in localStorage.
// DOMPurify is a cheap second layer that strips the dangerous
// shapes (script/style/iframe/event-handlers/javascript: URIs)
// without affecting the small set of tags we actually emit.
const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'meta', 'link'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onsubmit', 'formaction', 'srcset'],
  ALLOWED_URI_REGEXP: /^(?:https?):/i,
}
function safeHtml(raw) {
  if (!raw) return ''
  return DOMPurify.sanitize(raw, SANITIZE_CONFIG)
}

// Allowed characters for any storage path the UI writes — mirrors the
// server's `_SAFE_RE` (`[\w.\-/]+`) so a create/upload/move never 4xx's on a
// stray character. Used by the new-file, upload, and move/rename paths.
const NAME_RE = /^[\w.\-/]+$/

// ----------------------------------------------------------------------
// LaTeX editor mini-app for Möbius.
//
// Three stacked regions on mobile (top-to-bottom):
//   1. preview pane — renders the currently selected file
//      (.tex math via KaTeX, .md as basic markdown, images as <img>,
//       .pdf in an iframe).
//   2. file tree drawer — slide-out left drawer with the contents of
//      /api/storage/apps/<id>/files/. New file + new folder buttons
//      at the top. Tapping a file selects it + closes the drawer.
//   3. chat panel — sticky composer at the bottom, scrolling thread
//      above it. The user describes the document in prose; the
//      sub-agent edits files in /data/apps/<id>/files/ via the Edit
//      and Write tools.
//
// Storage layout (under /api/storage/apps/<id>/):
//   files/<path>           the user's actual .tex/.md/etc. files
//   files-index.json       the canonical list of paths under files/.
//                          We maintain it because the storage API has
//                          no listing endpoint for apps; without it we
//                          would have to brute-force-probe paths.
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
    if (ms && typeof ms.get === 'function') return ms.get(path)
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
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) return null
    return r.blob()
  }
  async function setText(path, text) {
    if (ms && typeof ms.set === 'function') return ms.set(path, text)
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: text,
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
  return { get, getBlob, setText, setJSON, remove, pendingCount, hasRuntime }
}

// ----------------------------------------------------------------------
// KaTeX loader. Imported lazily from esm.sh because the importmap
// doesn't bake it in; surfaced via runtime.esm_deps in the manifest so
// the user sees it on install. ?bundle inlines the CSS-less JS and we
// also fetch the stylesheet so display math doesn't render unstyled.
//
// Offline-reload behaviour: a dynamic import to an external host hangs
// indefinitely on a flaky/offline link (the browser doesn't time out
// `import()` itself), so we race against a 5s deadline. The .tex
// editor and the paragraph/heading layer don't depend on KaTeX —
// math falls back to its raw `$...$` source in a `math-error` span —
// so editing and reading prose keep working while preview math is
// degraded. A later retry (next online open) gets a fresh attempt.
// ----------------------------------------------------------------------
let _katexPromise = null
function loadKatex() {
  if (_katexPromise) return _katexPromise
  // Inject the stylesheet once. Without this, fractions/integrals
  // render as unstyled stacked spans — recognizable but ugly.
  if (typeof document !== 'undefined' && !document.getElementById('katex-css')) {
    const link = document.createElement('link')
    link.id = 'katex-css'
    link.rel = 'stylesheet'
    link.href = 'https://esm.sh/katex@0.16/dist/katex.min.css'
    document.head.appendChild(link)
  }
  _katexPromise = import('https://esm.sh/katex@0.16?bundle').catch((err) => {
    // Reset so a later retry (back online) can try again.
    _katexPromise = null
    throw err
  })
  return _katexPromise
}

// Render a math string with KaTeX into the given DOM element. Silent
// failure draws the raw source in a "math-error" span so a typo
// doesn't bomb the whole preview pane.
function renderMath(katex, target, source, displayMode) {
  try {
    katex.render(source, target, {
      displayMode,
      throwOnError: false,
      output: 'html',
      strict: 'ignore',
    })
  } catch (e) {
    target.textContent = ''
    const span = document.createElement('span')
    span.className = 'math-error'
    span.textContent = (displayMode ? `$$${source}$$` : `$${source}$`)
    target.appendChild(span)
  }
}

// ----------------------------------------------------------------------
// .tex → renderable segments. We tokenize on $$ ... $$ first (display
// math), then $ ... $ (inline math), then apply tiny line-level rules
// for \section, \subsection, \textbf, \emph, and blank-line paragraph
// breaks. This is deliberately math-first and not a real LaTeX
// renderer — the spec calls out math-first preview only; no latexmk.
// ----------------------------------------------------------------------
function tokenizeTex(src) {
  const out = []
  let i = 0
  while (i < src.length) {
    if (src[i] === '$' && src[i + 1] === '$') {
      const end = src.indexOf('$$', i + 2)
      if (end === -1) {
        out.push({ kind: 'text', value: src.slice(i) })
        break
      }
      out.push({ kind: 'displayMath', value: src.slice(i + 2, end) })
      i = end + 2
    } else if (src[i] === '$') {
      const end = src.indexOf('$', i + 1)
      if (end === -1) {
        out.push({ kind: 'text', value: src.slice(i) })
        break
      }
      out.push({ kind: 'inlineMath', value: src.slice(i + 1, end) })
      i = end + 1
    } else {
      // Accumulate plain text until the next math marker.
      let j = i
      while (j < src.length && src[j] !== '$') j++
      out.push({ kind: 'text', value: src.slice(i, j) })
      i = j
    }
  }
  return out
}

// Per-line markup pass. Runs on text segments only — math is rendered
// separately so this never sees backslashes inside math mode.
function renderTexInline(text) {
  // \textbf{...} → <b>, \emph{...} → <i>. Done as regex passes; nested
  // commands aren't handled (rare in practice and out of scope).
  let html = escapeHtml(text)
  html = html.replace(/\\textbf\{([^}]*)\}/g, '<b>$1</b>')
  html = html.replace(/\\emph\{([^}]*)\}/g, '<i>$1</i>')
  html = html.replace(/\\textit\{([^}]*)\}/g, '<i>$1</i>')
  // \"o → ö etc. — a small set of common LaTeX umlauts so the welcome
  // file's "M\"obius" renders correctly. Not exhaustive.
  html = html.replace(/\\"([aeiouAEIOU])/g, (_, ch) => {
    const map = { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü' }
    return map[ch] || ch
  })
  return html
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c])
}

// Split a .tex source into a render plan: a flat array of blocks,
// each either text-segments-with-inline-math or a display-math span.
// The text blocks get split into paragraphs (blank-line separated)
// at render time.
function planTex(src) {
  const tokens = tokenizeTex(src)
  const blocks = []
  let buffer = []
  for (const tok of tokens) {
    if (tok.kind === 'displayMath') {
      if (buffer.length) {
        blocks.push({ kind: 'text', segments: buffer })
        buffer = []
      }
      blocks.push({ kind: 'displayMath', value: tok.value })
    } else {
      buffer.push(tok)
    }
  }
  if (buffer.length) blocks.push({ kind: 'text', segments: buffer })
  return blocks
}

// One paragraph (of mixed text + inline math). Renders the math into
// spans via KaTeX after mount; the surrounding HTML is built with
// the tiny markup pass above.
function TexParagraph({ katex, segments }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !katex) return
    // Replace the placeholders we left in the HTML with rendered math.
    const targets = ref.current.querySelectorAll('span[data-tex-inline]')
    targets.forEach((t) => {
      renderMath(katex, t, t.getAttribute('data-tex-inline'), false)
    })
  }, [katex, segments])

  const html = useMemo(() => {
    return segments.map((s) => {
      if (s.kind === 'inlineMath') {
        // Empty span; KaTeX fills it on mount via the useEffect above.
        // The raw source is stashed as an attribute (escaped) so we
        // can re-render after a swap without re-tokenizing.
        return `<span data-tex-inline="${escapeHtml(s.value)}"></span>`
      }
      // Apply the line-level markup AFTER escaping the raw text.
      return renderTexInline(s.value)
    }).join('')
  }, [segments])

  return <p className="tex-para" dangerouslySetInnerHTML={{ __html: safeHtml(html) }} />
}

function TexBlock({ block, katex }) {
  if (block.kind === 'displayMath') {
    return <DisplayMath katex={katex} source={block.value} />
  }
  // Section/subsection promotion happens line-by-line, before we hand
  // off to TexParagraph. The split keeps blank lines as paragraph
  // breaks.
  return <TexTextBlock katex={katex} segments={block.segments} />
}

function DisplayMath({ katex, source }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !katex) return
    renderMath(katex, ref.current, source, true)
  }, [katex, source])
  return <div className="tex-display" ref={ref} />
}

// Walk the text-segments, promoting line-leading \section{...} and
// \subsection{...} to <h2>/<h3>. Blank lines split paragraphs.
function TexTextBlock({ katex, segments }) {
  // Reassemble the segments into a single string with explicit
  // markers for inline math so the per-line splitter can keep math
  // tokens intact.
  const flat = []
  for (const s of segments) {
    if (s.kind === 'text') {
      flat.push({ kind: 'text', value: s.value })
    } else {
      flat.push({ kind: 'inlineMath', value: s.value })
    }
  }
  // Build a line-oriented stream. We split text on \n; math tokens
  // ride along inside the surrounding line.
  const lines = []
  let currentLine = []
  function flushLine() {
    lines.push(currentLine)
    currentLine = []
  }
  for (const item of flat) {
    if (item.kind !== 'text') {
      currentLine.push(item)
      continue
    }
    const pieces = item.value.split('\n')
    pieces.forEach((piece, i) => {
      if (piece.length) currentLine.push({ kind: 'text', value: piece })
      if (i < pieces.length - 1) flushLine()
    })
  }
  flushLine()

  // Group consecutive non-empty lines into paragraphs; empty lines
  // are paragraph breaks. Detect heading commands at the start of a
  // line and emit them as their own block.
  const out = []
  let para = []
  function flushPara() {
    if (para.length === 0) return
    // Collapse the line array into a flat segments list for
    // TexParagraph (join lines with spaces, preserving math tokens).
    const collapsed = []
    para.forEach((line, idx) => {
      line.forEach((seg) => collapsed.push(seg))
      if (idx < para.length - 1) {
        // Soft line break inside a paragraph → space.
        collapsed.push({ kind: 'text', value: ' ' })
      }
    })
    out.push({ kind: 'para', segments: collapsed, key: `p${out.length}` })
    para = []
  }

  for (const line of lines) {
    if (line.length === 0) {
      flushPara()
      continue
    }
    // Heading commands only fire when they're the first non-whitespace
    // thing on the line.
    if (line[0].kind === 'text') {
      const trimmed = line[0].value.replace(/^\s+/, '')
      const sectionMatch = trimmed.match(/^\\section\{([^}]*)\}/)
      const subsectionMatch = trimmed.match(/^\\subsection\{([^}]*)\}/)
      const subsubMatch = trimmed.match(/^\\subsubsection\{([^}]*)\}/)
      if (sectionMatch) {
        flushPara()
        out.push({ kind: 'h2', text: sectionMatch[1], key: `h${out.length}` })
        continue
      }
      if (subsectionMatch) {
        flushPara()
        out.push({ kind: 'h3', text: subsectionMatch[1], key: `h${out.length}` })
        continue
      }
      if (subsubMatch) {
        flushPara()
        out.push({ kind: 'h4', text: subsubMatch[1], key: `h${out.length}` })
        continue
      }
    }
    para.push(line)
  }
  flushPara()

  return (
    <>
      {out.map((b) => {
        if (b.kind === 'h2') return <h2 className="tex-h2" key={b.key}>{b.text}</h2>
        if (b.kind === 'h3') return <h3 className="tex-h3" key={b.key}>{b.text}</h3>
        if (b.kind === 'h4') return <h4 className="tex-h4" key={b.key}>{b.text}</h4>
        return <TexParagraph katex={katex} segments={b.segments} key={b.key} />
      })}
    </>
  )
}

// Top-level .tex renderer. Loads KaTeX on first mount, then renders
// the planned block list. If the dynamic import fails or times out
// (offline / flaky link), we render the rest of the .tex (headings,
// paragraphs, bold/italic) and the math falls back to its raw source
// in a `math-error` span — the user can still read and edit. The
// banner explains why preview math is degraded and disappears once
// the user is back online + reopens the app.
function TexPreview({ source }) {
  const [katex, setKatex] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let cancelled = false
    loadKatex().then((m) => {
      if (!cancelled) setKatex(m.default || m)
    }).catch(() => {
      // We don't surface the underlying error (timeout vs network vs
      // CORS) — the user just needs to know the math preview will
      // come back once they're online again.
      if (!cancelled) setError(true)
    })
    return () => { cancelled = true }
  }, [])
  const plan = useMemo(() => planTex(source || ''), [source])
  return (
    <div className="tex-preview">
      {error && (
        <div className="preview-banner">
          Preview math loads on next online open. Editing still works.
        </div>
      )}
      {plan.map((b, i) => <TexBlock key={i} block={b} katex={katex} />)}
    </div>
  )
}

// ----------------------------------------------------------------------
// Markdown preview — hand-rolled. We avoid esm.sh for marked because
// the user's markdown docs aren't expected to be huge; this keeps the
// app fully self-contained for offline. Supports headings, bold,
// italic, inline code, fenced code blocks, links, lists.
// ----------------------------------------------------------------------
function renderMarkdown(src) {
  const lines = src.split('\n')
  let html = ''
  let inCode = false
  let codeBuf = []
  let inList = false
  function flushList() {
    if (inList) {
      html += '</ul>'
      inList = false
    }
  }
  function inline(s) {
    let r = escapeHtml(s)
    // Code spans first (so we don't bold inside code).
    r = r.replace(/`([^`]+)`/g, '<code>$1</code>')
    r = r.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    r = r.replace(/\*([^*]+)\*/g, '<i>$1</i>')
    r = r.replace(/_([^_]+)_/g, '<i>$1</i>')
    // [text](url) — strict so a stray bracket pair doesn't trigger.
    r = r.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) =>
      `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    return r
  }
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        html += `<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`
        codeBuf = []
        inCode = false
      } else {
        flushList()
        inCode = true
      }
      continue
    }
    if (inCode) {
      codeBuf.push(line)
      continue
    }
    if (line.startsWith('# ')) { flushList(); html += `<h1>${inline(line.slice(2))}</h1>`; continue }
    if (line.startsWith('## ')) { flushList(); html += `<h2>${inline(line.slice(3))}</h2>`; continue }
    if (line.startsWith('### ')) { flushList(); html += `<h3>${inline(line.slice(4))}</h3>`; continue }
    if (line.match(/^[-*] /)) {
      if (!inList) { html += '<ul>'; inList = true }
      html += `<li>${inline(line.slice(2))}</li>`
      continue
    }
    flushList()
    if (line.trim() === '') { html += ''; continue }
    html += `<p>${inline(line)}</p>`
  }
  if (inCode) {
    html += `<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`
  }
  flushList()
  return html
}

function MarkdownPreview({ source }) {
  const html = useMemo(() => renderMarkdown(source || ''), [source])
  return <div className="md-preview" dangerouslySetInnerHTML={{ __html: safeHtml(html) }} />
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

// PDF preview — same auth dance as images. iframe with the blob URL
// gives us the browser's native PDF viewer.
function PdfPreview({ storage, path, version }) {
  const [url, setUrl] = useState(null)
  const [err, setErr] = useState(null)
  // `version` (the build token) is in the deps so a rebuild that produces the
  // SAME deterministic path still refetches the fresh bytes; without it the
  // effect wouldn't re-run and the iframe would keep showing the prior compile.
  useEffect(() => {
    let live = true
    let revoke = null
    setUrl(null); setErr(null)
    storage.getBlob(path).then((blob) => {
      if (!live || !blob) {
        if (live) setErr('PDF could not be loaded.')
        return
      }
      const u = URL.createObjectURL(blob)
      revoke = u
      setUrl(u)
    }).catch((e) => {
      if (live) setErr(e.message || 'PDF load failed.')
    })
    return () => {
      live = false
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [storage, path, version])
  if (err) return <div className="preview-note">{err}</div>
  if (!url) return <div className="preview-note">Loading PDF…</div>
  return <iframe className="pdf-preview" src={url} title={path} />
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
  onContextMenu, onMoveInto,
}) {
  const [expanded, setExpanded] = useState(true)
  const [dropActive, setDropActive] = useState(false)
  const isFolder = !(node.children.size === 0 && node.isFile)
  const longPress = useLongPress((cx, cy) => {
    onContextMenu({ x: cx, y: cy, path: node.path, isFolder })
  })
  if (node.children.size === 0 && node.isFile) {
    const selected = node.path === selectedPath
    return (
      <button
        type="button"
        className={`tree-file ${selected ? 'tree-file--selected' : ''}`}
        style={{ paddingLeft: `${10 + depth * 16}px` }}
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
        onClick={() => setExpanded((e) => !e)}
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
      {expanded && sortedChildren.map((c) => (
        <FileNode
          key={c.path}
          node={c}
          selectedPath={selectedPath}
          onSelect={onSelect}
          depth={depth + 1}
          onContextMenu={onContextMenu}
          onMoveInto={onMoveInto}
        />
      ))}
    </>
  )
}

// `canMutate` is false until the file index has been confirmed against
// the server (App owns the check). While false we disable add/delete so
// the user can't queue an index write derived from an unconfirmed list —
// the handler refuses too, but greying the buttons is the honest surface
// rather than a tap that pops an explanatory modal.
function FileNavPanel({
  open, onClose, files, selectedPath, onSelect, canMutate,
  onCreateFile, onCreateFolder, onDeleteFile, onDeleteFolder,
  onUpload, onMove, onRename,
}) {
  const root = useMemo(() => buildTree(files), [files])
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
  if (!open) return null

  const ctxItems = ctx ? [
    { label: 'Rename', onSelect: () => onRename(ctx.path) },
    {
      label: 'Delete',
      danger: true,
      onSelect: () => (ctx.isFolder ? onDeleteFolder(ctx.path) : onDeleteFile(ctx.path)),
    },
  ] : []

  return (
    <section className="file-nav-panel" aria-label="File tree">
      <div className="nav-panel-head">
        <span className="nav-panel-title">Files</span>
        <button className="nav-panel-close" onClick={onClose} aria-label="Close file tree">Close</button>
      </div>
      <div className="nav-panel-actions">
        <button className="nav-panel-btn" onClick={onCreateFile} disabled={!canMutate}>+ New file</button>
        <button className="nav-panel-btn" onClick={onCreateFolder} disabled={!canMutate}>+ New folder</button>
        <button
          className="nav-panel-btn"
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
          disabled={!canMutate}
        >
          Upload
        </button>
        <button
          className="nav-panel-btn"
          onClick={() => folderInputRef.current && folderInputRef.current.click()}
          disabled={!canMutate}
        >
          Upload folder
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
        <div className="nav-panel-syncing" role="status">
          Loading your files... add, upload, and delete are available once they sync.
        </div>
      )}
      <div className="nav-panel-tree">
        {files.length === 0 ? (
          canMutate ? (
            <div className="nav-panel-empty">
              No files yet. Tap "+ New file", Upload, or ask the agent to make one.
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
          />
        )}
      </div>
      {selectedPath && (
        <div className="nav-panel-foot">
          <button
            className="nav-panel-btn nav-panel-btn--danger"
            onClick={() => onDeleteFile(selectedPath)}
            disabled={!canMutate}
          >
            Delete "{selectedPath}"
          </button>
        </div>
      )}
      {ctx && (
        <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems} onClose={closeCtx} />
      )}
    </section>
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
    'prose; you translate that to LaTeX. Keep the user’s intent; do not',
    'invent sections they did not ask for. After editing, summarise the',
    'change in ONE short sentence — the embedded chat panel renders only',
    'the last assistant message.',
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
    'This is a silent setup brief — do NOT reply to it. Wait for the',
    'user’s first message and act on that.',
  ].join('\n')
}

// Create a real chat the embed can bind to. The old code fell back to a
// hard-coded id ('latex-chat') that is truthy but not a UUID, so
// window.mobius.chat treated it as "use this existing chat" and pointed the
// embed iframe at /shell/embed/chat?chatId=latex-chat — a chat that never
// exists → 404 → the permanent "no conversation yet" empty state. Instead we
// mint a genuine chat ourselves via the app-token endpoint
// (POST /api/app-chats, the same Bearer token makeStorage holds) and mount the
// embed with that real id. The chat is app-attributed, so it stays out of the
// owner's drawer history but the embed can still stream it.
async function createAppChat(appId, token) {
  const r = await fetch('/api/app-chats', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: 'LaTeX editor' }),
  })
  if (!r.ok) throw new Error(`create chat → ${r.status}`)
  const data = await r.json()
  if (!data || !data.id) throw new Error('create chat returned no id')
  return String(data.id)
}

function ChatPanel({
  appId, token, storage,
  onFilesMaybeChanged,
}) {
  const mountRef = useRef(null)
  // null until resolved; once set it is always a REAL chat id (a persisted
  // one from chat_id.json or a freshly-created one). We never mount the embed
  // with a placeholder.
  const [chatId, setChatId] = useState(null)
  const [error, setError] = useState(null)
  // Keep the latest onFilesMaybeChanged in a ref so the mount effect below
  // does NOT depend on it. That callback's identity changes on every file
  // selection (it closes over selectedPath); if it were a mount-effect dep,
  // selecting a file would tear down + remount the chat iframe — destroying a
  // streaming turn mid-flight. The turn-done handler reads the ref instead.
  const onFilesRef = useRef(onFilesMaybeChanged)
  useEffect(() => { onFilesRef.current = onFilesMaybeChanged }, [onFilesMaybeChanged])

  // Resolve a real chat id before mounting the embed: read chat_id.json, and
  // if absent create one ourselves and persist it. A create failure surfaces
  // the chat-error rather than silently mounting an empty embed.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const saved = await storage.get('chat_id.json')
        if (cancelled) return
        if (saved && saved.id) {
          setChatId(String(saved.id))
          return
        }
      } catch (e) {
        // Read failure (e.g. offline) — fall through to create below; if
        // that also fails the catch surfaces the error.
      }
      try {
        const id = await createAppChat(appId, token)
        if (cancelled) return
        setChatId(id)
        storage.setJSON('chat_id.json', { id }).catch(() => {})
      } catch (e) {
        if (!cancelled) {
          setError(
            (e && e.message)
              ? `Could not start the agent chat (${e.message}).`
              : 'Could not start the agent chat.',
          )
        }
      }
    })()
    return () => { cancelled = true }
  }, [appId, token, storage])

  useEffect(() => {
    const mount = mountRef.current
    if (!chatId) return undefined
    if (!mount || !window.mobius || typeof window.mobius.chat !== 'function') {
      setError('Embedded chat is not available in this shell.')
      return undefined
    }
    let disposed = false
    let handle = null
    setError(null)

    window.mobius.chat({
      mount,
      // Always the real id — never a placeholder or undefined, so the embed
      // binds to a chat that actually exists.
      chatId,
      title: 'LaTeX editor',
      systemPrompt: bootstrapPrompt(appId),
    }).then((nextHandle) => {
      if (disposed) {
        nextHandle.destroy()
        return
      }
      handle = nextHandle
      handle
        .on('ready', ({ chatId: resolved }) => {
          // The runtime may hand back its own canonical id; reconcile +
          // persist so a reload re-binds the same conversation.
          if (!resolved) return
          const next = String(resolved)
          if (next !== chatId) {
            setChatId(next)
            storage.setJSON('chat_id.json', { id: next }).catch(() => {})
          }
        })
        .on('turn-done', () => { if (onFilesRef.current) onFilesRef.current() })
        .on('error', ({ error: chatError }) => {
          setError(chatError || 'Embedded chat reported an error.')
        })
    }).catch((e) => {
      if (!disposed) setError(e.message || 'Could not mount embedded chat.')
    })

    return () => {
      disposed = true
      if (handle) handle.destroy()
    }
  }, [appId, chatId, storage])

  return (
    <section className="chat-panel">
      <div className="pane-head">
        <span>Agent chat</span>
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
  // state shape:
  //   { kind: 'alert'|'confirm'|'prompt',
  //     title, body, placeholder, defaultValue, danger, resolve }

  const close = useCallback(() => setState(null), [])

  const alert = useCallback((body, opts = {}) => new Promise((resolve) => {
    setState({
      kind: 'alert',
      title: opts.title || 'Heads up',
      body,
      resolve: () => { close(); resolve(undefined) },
    })
  }), [close])

  const confirm = useCallback((body, opts = {}) => new Promise((resolve) => {
    setState({
      kind: 'confirm',
      title: opts.title || 'Confirm',
      body,
      danger: !!opts.danger,
      resolve: (ok) => { close(); resolve(!!ok) },
    })
  }), [close])

  const prompt = useCallback((body, opts = {}) => new Promise((resolve) => {
    setState({
      kind: 'prompt',
      title: opts.title || 'Enter a value',
      body,
      placeholder: opts.placeholder || '',
      defaultValue: opts.defaultValue || '',
      resolve: (val) => { close(); resolve(val) },
    })
  }), [close])

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

function readFileCache(appId) {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(fileCacheKey(appId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const index = Array.isArray(parsed.index)
      ? parsed.index.filter((p) => typeof p === 'string')
      : []
    const contents = (parsed.contents && typeof parsed.contents === 'object')
      ? parsed.contents : {}
    const lastPath = typeof parsed.lastPath === 'string' ? parsed.lastPath : null
    return { index, contents, lastPath }
  } catch {
    return null
  }
}

function writeFileCache(appId, index, contents, lastPath) {
  if (typeof localStorage === 'undefined') return
  try {
    // Trim contents to the index — orphaned bodies (deleted files)
    // get GC'd here; only string bodies are kept (binary previews
    // fetch from the server on demand).
    const trimmed = {}
    const indexSet = new Set(index)
    const entries = Object.entries(contents)
      .filter(([p, v]) => indexSet.has(p) && typeof v === 'string')
      .slice(-FILE_CONTENT_CACHE_LIMIT)
    for (const [p, v] of entries) trimmed[p] = v
    localStorage.setItem(
      fileCacheKey(appId),
      JSON.stringify({
        index,
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

function useBuild({ appId, token, storage, online }) {
  const [buildStatus, setBuildStatus] = useState('idle') // idle|building|done|error
  const [buildLog, setBuildLog] = useState('')
  // Which .tex the current/last build is FOR. The hook tracks one build at a
  // time; this lets the viewer scope "Building…" / "Build failed" to the doc
  // that's actually compiling, so switching to a different doc mid-build
  // doesn't mislabel it.
  const [buildDoc, setBuildDoc] = useState(null)
  // Map of source .tex path → its built .pdf path, so the viewer can show a
  // PDF tab only for documents that have actually been compiled this session.
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

  return {
    buildStatus, buildLog, buildDoc, pdfByDoc, build,
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
  // Restore the file the user was viewing last session so an offline
  // reload opens straight into their work-in-progress (assuming we
  // have its body cached — handled by the cache-first load below).
  const [selectedPath, setSelectedPath] = useState(() => cached?.lastPath || null)
  const [fileContent, setFileContent] = useState('')
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState(null)
  const [fileDirty, setFileDirty] = useState(false)
  const [fileSaving, setFileSaving] = useState(false)
  // Outbox depth — surfaced by the SyncPill in the header. Refreshed
  // on every storage write (handled inline at each call site below)
  // and on a 10s background poll.
  const [pending, setPending] = useState(0)
  // Preview viewer mode for the selected source file. 'source' shows the
  // KaTeX/markdown render; 'pdf' shows the compiled PDF. The PDF tab is only
  // reachable once the current .tex has a build mapped (see pdfByDoc below).
  const [viewMode, setViewMode] = useState('source')
  const build = useBuild({ appId, token, storage, online })

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

  const toggleNav = useCallback(() => setNavOpen((open) => !open), [])
  const closeNav = useCallback(() => setNavOpen(false), [])

  // Pull the canonical file list out of files-index.json. Falls back
  // to ["files/welcome.tex"] when the index doesn't exist (older
  // install, or the seed didn't apply for some reason). When the
  // runtime is offline, storage.get returns null — we keep whatever
  // we hydrated from the localStorage snapshot rather than blanking
  // the tree.
  const refreshFiles = useCallback(async () => {
    try {
      const idx = await storage.get('files-index.json')
      if (Array.isArray(idx)) {
        // De-dup + sort for stable rendering.
        const cleaned = [...new Set(idx.filter((p) => typeof p === 'string' && p.startsWith('files/')))]
        cleaned.sort()
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
        const probe = await storage.get('files/welcome.tex')
        const seed = probe ? ['files/welcome.tex'] : []
        await storage.setJSON('files-index.json', seed)
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
      const firstReal = files.find((p) => !p.endsWith('/.keep'))
      if (firstReal) setSelectedPath(firstReal)
    }
  }, [files, selectedPath])

  // Load the selected file's content. Cache-first: if the body lives
  // in fileCache we paint it from state without fetching. Selection
  // alone doesn't trigger a re-fetch — agent edits propagate via
  // `onFilesMaybeChanged` after every chat turn, which is the only
  // place a server-side change can come from in this app. That keeps
  // file switching instant (no flicker) and means offline reselect
  // never blanks a file the user just had open.
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
    const ext = selectedPath.split('.').pop().toLowerCase()
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'].includes(ext)) {
      setFileContent('')
      setFileLoading(false)
      setFileError(null)
      setFileDirty(false)
      return
    }
    // Cache hit — paint synchronously. No background refetch: agent
    // edits land via onFilesMaybeChanged, the only other writer.
    const cachedBody = fileCache[selectedPath]
    if (typeof cachedBody === 'string') {
      setFileContent(cachedBody)
      setFileError(null)
      setFileLoading(false)
      setFileDirty(false)
      return
    }
    // Cache miss. Offline → show a friendly note rather than the
    // "File not found" misnomer the old code used when storage.get
    // returned null offline. Online → fetch + memoise.
    if (!online) {
      setFileContent('')
      setFileError('Not available offline. Open this file once online to cache it.')
      setFileLoading(false)
      setFileDirty(false)
      return
    }
    let cancelled = false
    setFileLoading(true)
    setFileError(null)
    storage.get(selectedPath).then((data) => {
      if (cancelled) return
      if (data == null) {
        // Online + null body means the file genuinely doesn't exist
        // on the server (404). Drop any stale cache entry too.
        setFileError('File not found — was it deleted?')
        setFileContent('')
        setFileDirty(false)
      } else {
        const body = typeof data === 'string'
          ? data
          // JSON came back as an object — stringify so the preview
          // shows something legible.
          : JSON.stringify(data, null, 2)
        setFileContent(body)
        setFileError(null)
        setFileDirty(false)
        // Memoise for instant re-select + offline-reload survival.
        setFileCache((prev) => (prev[selectedPath] === body ? prev : { ...prev, [selectedPath]: body }))
      }
      setFileLoading(false)
    }).catch((e) => {
      if (!cancelled) {
        setFileError(e.message || 'Could not load file.')
        setFileLoading(false)
        setFileDirty(false)
      }
    })
    return () => { cancelled = true }
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
  // pings this via onFilesMaybeChanged. Refetched contents land in
  // both `fileContent` (what's painted now) and `fileCache` (what an
  // offline reload paints) so the agent's edits survive a refresh.
  const onFilesMaybeChanged = useCallback(async () => {
    await refreshFiles()
    if (selectedPath && online) {
      try {
        const data = await storage.get(selectedPath)
        if (typeof data === 'string') {
          setFileContent(data)
          setFileDirty(false)
          setFileCache((prev) => (prev[selectedPath] === data ? prev : { ...prev, [selectedPath]: data }))
        } else if (data == null) {
          setFileContent('')
          setFileDirty(false)
          setFileCache((prev) => {
            if (!(selectedPath in prev)) return prev
            const next = { ...prev }
            delete next[selectedPath]
            return next
          })
        }
      } catch (e) {
        // Silent — selectedPath useEffect will retry on next select.
      }
    }
  }, [refreshFiles, selectedPath, storage, online])

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
    if (!clean) return
    // Reject characters the storage backend rejects (matches its
    // _SAFE_RE on the server: [\w.\-/]+ — strict but reasonable).
    if (!/^[\w.\-/]+$/.test(clean)) {
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
    if (!clean) return
    if (!/^[\w.\-/]+$/.test(clean)) {
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
      if (!rel || !NAME_RE.test(rel)) {
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
          const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}` },
            body: f,
          })
          if (!r.ok) throw new Error(`PUT ${path} → ${r.status}`)
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
  }, [appId, token, storage, modal, refreshPending, ensureIndexWritable])

  // ---- Move / rename (drag-to-move + context-menu rename) ----------------
  // Both go through POST /storage/apps/{id}/move {from, to}. The index is a
  // flat list of FILE paths; a move of a file replaces its one entry, a move
  // of a folder replaces every entry whose path is under it. We re-derive the
  // index by string-prefix rewrite, then persist once.
  const movePath = useCallback(async (from, to) => {
    if (from === to) return
    if (!(await ensureIndexWritable())) return
    if (!NAME_RE.test(to.replace(/^files\//, ''))) {
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

  const selectedExt = selectedPath ? selectedPath.split('.').pop().toLowerCase() : ''
  const selectedIsBinary = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'].includes(selectedExt)
  const canEditSelected = !!selectedPath && !selectedIsBinary && !fileLoading && !fileError
  const selectedIsTex = selectedExt === 'tex'
  // The PDF compiled from the selected .tex this session, if any: a
  // { pdf, ver } record (ver is the build token, see useBuild). The viewer's
  // PDF tab is gated on this so a doc with no build can't show a blank iframe.
  const pdfForSelected = (selectedPath && build.pdfByDoc[selectedPath]) || null

  // Reset the viewer to source whenever the user switches files — a per-doc
  // PDF tab shouldn't carry over to a different (maybe-never-built) document.
  // Selecting a .pdf directly is handled by renderPreview (it just shows the
  // PDF); this only governs the source/pdf TAB state for .tex/.md docs.
  useEffect(() => {
    setViewMode('source')
  }, [selectedPath])

  // When a build finishes, flip the selected doc's viewer to PDF and make the
  // new .pdf visible in the tree by adding it to files-index.json if missing.
  // Only writes the index when it's safe to (indexLoaded) — same gate as every
  // other UI index write, so an unconfirmed list never clobbers the server's.
  const onBuildDone = useCallback(async (doc, pdfPath) => {
    // Only yank the viewer to PDF if the user is still on the doc we built —
    // a build can finish after they've navigated elsewhere.
    if (doc === selectedPathRef.current) setViewMode('pdf')
    if (!pdfPath || !indexLoaded) return
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

  const handleSaveFile = useCallback(async () => {
    if (!selectedPath || selectedIsBinary || fileSaving) return
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
    if (!selectedIsTex || !selectedPath) return
    if (build.buildStatus === 'building') return
    // Save unsaved edits first so the compile sees what's on screen, then
    // kick the build. handleSaveFile resolves once the write lands (or fails
    // silently into fileError); we build either way so a flaky save doesn't
    // strand the button.
    const kick = () => build.build(selectedPath, onBuildDone)
    if (fileDirty && !fileSaving) {
      handleSaveFile().then(kick, kick)
    } else {
      kick()
    }
  }, [selectedIsTex, selectedPath, fileDirty, fileSaving, build, onBuildDone, handleSaveFile])

  function renderEditor() {
    if (!selectedPath) {
      return (
        <div className="editor-empty">
          <div className="editor-empty-title">No source selected</div>
          <div className="editor-empty-body">Open the file tree or create a new file.</div>
        </div>
      )
    }
    if (selectedIsBinary) {
      return (
        <div className="editor-empty">
          <div className="editor-empty-title">Binary preview</div>
          <div className="editor-empty-body">{selectedPath}</div>
        </div>
      )
    }
    if (fileLoading) return <div className="preview-note">Loading source...</div>
    if (fileError) return <div className="preview-note">{fileError}</div>
    return (
      <textarea
        className="source-editor"
        value={fileContent}
        onChange={(e) => handleEditorChange(e.target.value)}
        spellCheck={false}
        aria-label={`Source for ${selectedPath}`}
      />
    )
  }

  // Choose the preview renderer based on the file extension.
  function renderPreview() {
    if (!selectedPath) {
      return (
        <div className="preview-empty">
          <div className="preview-empty-title">LaTeX</div>
          <div className="preview-empty-body">
            Open the file tree to pick a file, or ask the agent below to
            create one.
          </div>
        </div>
      )
    }
    const ext = selectedExt
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
      return <ImagePreview storage={storage} path={selectedPath} />
    }
    // A .pdf selected directly in the tree just shows the PDF — no tabs,
    // no build state; it's a static document, not a compile target.
    if (ext === 'pdf') {
      return <PdfPreview storage={storage} path={selectedPath} />
    }
    // For .tex docs, the viewer toggles between the live source render and
    // the compiled PDF. The PDF view also has to surface the build's own
    // states (running / failed) since a build is a per-doc async operation.
    if (ext === 'tex' && viewMode === 'pdf') {
      // Building / error states only apply to the doc that's actually
      // compiling (build is single-flight in the hook).
      const isBuildingThis = build.buildStatus === 'building' && build.buildDoc === selectedPath
      const isErrorThis = build.buildStatus === 'error' && build.buildDoc === selectedPath
      if (isBuildingThis) {
        return (
          <div className="preview-note build-note">
            Building… (first build downloads packages, ~30–60s)
          </div>
        )
      }
      if (isErrorThis) {
        return (
          <div className="build-error">
            <div className="build-error-title">Build failed</div>
            <pre className="build-log">{build.buildLog}</pre>
          </div>
        )
      }
      if (pdfForSelected) {
        return (
          <PdfPreview
            storage={storage}
            path={pdfForSelected.pdf}
            version={pdfForSelected.ver}
          />
        )
      }
      // viewMode flipped to pdf but no build yet — fall through to source.
    }
    if (fileLoading) return <div className="preview-note">Loading…</div>
    if (fileError) return <div className="preview-note">{fileError}</div>
    if (ext === 'md') return <MarkdownPreview source={fileContent} />
    if (ext === 'tex') return <TexPreview source={fileContent} />
    // Fallback: render any other text file as plain preformatted text.
    return <pre className="text-preview">{fileContent}</pre>
  }

  return (
    <div className="latex-root">
      <style>{CSS}</style>
      <header className="top-bar">
        <button
          className="nav-toggle"
          onClick={toggleNav}
          aria-label={navOpen ? 'Close file tree' : 'Open file tree'}
          aria-expanded={navOpen}
        >
          ☰
        </button>
        <div className="top-title">
          <span className="app-title">LaTeX</span>
          {selectedPath
            ? <span className="top-path">{selectedPath}</span>
            : <span className="top-path top-path--muted">No file selected</span>}
        </div>
        <div className="top-actions">
          <button className="toolbar-btn" onClick={handleCreateFile} disabled={!indexLoaded}>New</button>
          <button
            className="toolbar-btn"
            onClick={handleSaveFile}
            disabled={!canEditSelected || !fileDirty || fileSaving}
          >
            {fileSaving ? 'Saving' : fileDirty ? 'Save' : 'Saved'}
          </button>
          <button
            className="toolbar-btn toolbar-btn--primary"
            onClick={handleBuild}
            disabled={!selectedIsTex || build.buildStatus === 'building'}
            title={selectedIsTex
              ? 'Compile this .tex to PDF'
              : 'Select a .tex file to build'}
          >
            {build.buildStatus === 'building' ? 'Building…' : 'Build'}
          </button>
          <SyncPill online={online} pending={pending} hasRuntime={storage.hasRuntime} />
        </div>
      </header>
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
      />
      <main className="workspace">
        <section className="editor-pane">
          <div className="pane-head">
            <span>Source</span>
          </div>
          <div className="pane-body">{renderEditor()}</div>
        </section>
        <section className="preview-pane">
          <div className="pane-head">
            {selectedIsTex ? (
              <div className="view-tabs" role="tablist" aria-label="Preview mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === 'source'}
                  className={`view-tab ${viewMode === 'source' ? 'view-tab--active' : ''}`}
                  onClick={() => setViewMode('source')}
                >
                  Source
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === 'pdf'}
                  className={`view-tab ${viewMode === 'pdf' ? 'view-tab--active' : ''}`}
                  onClick={() => setViewMode('pdf')}
                  // PDF tab opens once the doc has a build mapped, or while a
                  // build for THIS doc is in flight (so the user can watch
                  // progress / see the failure log).
                  disabled={!pdfForSelected
                    && !(build.buildStatus !== 'idle' && build.buildDoc === selectedPath)}
                  title={(!pdfForSelected
                    && !(build.buildStatus !== 'idle' && build.buildDoc === selectedPath))
                    ? 'Build this document to see its PDF'
                    : 'View the compiled PDF'}
                >
                  PDF
                </button>
              </div>
            ) : (
              <span>Preview</span>
            )}
          </div>
          <div className="pane-body preview-body">{renderPreview()}</div>
        </section>
        <ChatPanel
          appId={appId}
          token={token}
          storage={storage}
          onFilesMaybeChanged={onFilesMaybeChanged}
        />
      </main>
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
}

.top-bar {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.nav-toggle {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 20px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.nav-toggle:active { background: var(--surface2); }
.top-title {
  min-width: 0;
  text-align: center;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.app-title {
  display: block;
  font-size: 15px;
  color: var(--text);
}
.top-path { font-family: var(--font); }
.top-path--muted { color: var(--muted); font-weight: 400; }
.top-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}
.toolbar-btn {
  min-height: 40px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font: 600 13px/1 var(--font);
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

.file-nav-panel {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 10px;
  align-items: start;
  width: 100%;
  max-height: 34vh;
  overflow: auto;
  padding: 10px 12px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  box-sizing: border-box;
}
.nav-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
}
.nav-panel-title { font-size: 14px; font-weight: 700; }
.nav-panel-close {
  min-height: 36px;
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font: 600 12px/1 var(--font);
  cursor: pointer;
}
.nav-panel-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
.nav-panel-btn {
  min-height: 40px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font: 600 13px/1.2 var(--font);
  cursor: pointer;
}
.nav-panel-btn--danger { color: var(--accent); border-color: var(--accent); }
.nav-panel-btn:disabled { opacity: 0.45; cursor: default; }
.nav-panel-syncing,
.nav-panel-empty {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
}
.nav-panel-tree {
  grid-column: 1 / -1;
  min-height: 0;
  max-height: 22vh;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  padding: 4px 0;
}
.nav-panel-foot {
  grid-column: 1 / -1;
  display: flex;
  justify-content: flex-end;
}

.workspace {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(260px, 1fr) minmax(260px, 1fr) minmax(300px, 0.9fr);
  background: var(--bg);
}
.editor-pane,
.preview-pane,
.chat-panel {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.editor-pane,
.preview-pane {
  border-right: 1px solid var(--border);
}
.pane-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  min-height: 38px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  color: var(--muted);
  font: 700 12px/1 var(--font);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.pane-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

/* ---- preview pane ---- */
.preview-pane {
  overflow: hidden;
}
.preview-body {
  padding: 18px 18px 24px;
  overflow-y: auto;
  overflow-x: hidden;
}
.source-editor {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 300px;
  padding: 16px;
  box-sizing: border-box;
  resize: none;
  border: 0;
  outline: none;
  background: var(--bg);
  color: var(--text);
  font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.source-editor:focus {
  box-shadow: inset 0 0 0 1px var(--accent);
}
.editor-empty {
  display: flex;
  height: 100%;
  min-height: 240px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px;
  color: var(--muted);
  text-align: center;
}
.editor-empty-title {
  color: var(--text);
  font-weight: 700;
}

.preview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  color: var(--muted);
  gap: 8px;
}
.preview-empty-title { font-size: 26px; font-weight: 700; color: var(--text); letter-spacing: -0.5px; }
.preview-empty-body { font-size: 14px; line-height: 1.5; max-width: 320px; }

.preview-note {
  color: var(--muted);
  font-size: 13px;
  padding: 16px 0;
  text-align: center;
}
.build-note {
  padding: 24px 16px;
  line-height: 1.55;
}

/* ---- Source/PDF viewer tabs ---- */
.view-tabs {
  display: inline-flex;
  gap: 4px;
}
.view-tab {
  min-height: 28px;
  padding: 5px 12px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: none;
  color: var(--muted);
  font: 700 11px/1 var(--font);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
}
.view-tab--active {
  background: var(--bg);
  border-color: var(--border);
  color: var(--text);
}
.view-tab:disabled {
  opacity: 0.4;
  cursor: default;
}

/* ---- build failure ---- */
.build-error {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.build-error-title {
  font-weight: 700;
  color: var(--accent);
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
/* Subtle accent-tinted strip sitting at the top of the .tex preview
   when KaTeX failed to load (offline / flaky link). Loud enough to
   notice, quiet enough not to dominate the page; matches the news
   app's offline banner so the two apps feel like one family. */
.preview-banner {
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.45;
}

/* ---- .tex render ---- */
.tex-preview {
  font-size: 15px;
  line-height: 1.65;
  word-wrap: break-word;
  overflow-wrap: anywhere;
}
.tex-h2 {
  font-size: 22px;
  font-weight: 700;
  margin: 20px 0 8px;
  letter-spacing: -0.3px;
}
.tex-h3 {
  font-size: 17px;
  font-weight: 700;
  margin: 16px 0 6px;
}
.tex-h4 {
  font-size: 15px;
  font-weight: 700;
  margin: 14px 0 4px;
  color: var(--muted);
}
.tex-para {
  margin: 0 0 12px;
}
.tex-display {
  display: block;
  margin: 14px 0;
  padding: 4px 0;
  overflow-x: auto;
  text-align: center;
}
.math-error {
  color: var(--accent);
  font-family: ui-monospace, SFMono-Regular, monospace;
  /* Tinted backdrop follows --accent instead of pinning to red,
     so the malformed-math flag stays visible on themes whose
     accent isn't red. color-mix is supported in every browser
     Möbius targets. */
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  padding: 0 4px;
  border-radius: 3px;
}

/* ---- .md render ---- */
.md-preview {
  font-size: 15px;
  line-height: 1.6;
}
.md-preview h1, .md-preview h2, .md-preview h3 {
  margin-top: 18px;
  margin-bottom: 8px;
}
.md-preview h1 { font-size: 24px; }
.md-preview h2 { font-size: 19px; }
.md-preview h3 { font-size: 16px; }
.md-preview p { margin: 0 0 12px; }
.md-preview code {
  background: var(--surface);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: ui-monospace, monospace;
  font-size: 90%;
}
.md-preview pre {
  background: var(--surface);
  padding: 10px 12px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 13px;
}
.md-preview pre code { background: none; padding: 0; }
.md-preview a { color: var(--accent); }
.md-preview ul { padding-left: 22px; }
.md-preview li { margin-bottom: 4px; }

/* ---- image/pdf/text ---- */
.img-preview {
  display: block;
  max-width: 100%;
  margin: 0 auto;
  border-radius: 6px;
}
.pdf-preview {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 50vh;
  border: none;
  border-radius: 6px;
  background: var(--surface);
}
.text-preview {
  font-family: ui-monospace, monospace;
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
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
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.drawer-title { font-size: 16px; font-weight: 700; }
.drawer-close {
  width: 44px;
  height: 44px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 22px;
  cursor: pointer;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.drawer-actions {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.drawer-btn {
  flex: 1 1 0;
  min-height: 44px;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.drawer-btn:active { background: var(--surface2, var(--surface)); }
.drawer-btn--danger { color: var(--accent); border-color: var(--accent); }
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
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 10px 14px;
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  cursor: pointer;
  font-size: 14px;
  font-family: var(--font);
}
.tree-file:active, .tree-folder:active {
  background: var(--surface2, var(--bg));
}
.tree-file--selected {
  background: var(--accent);
  color: #fff;
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

/* In-app context menu (right-click / long-press). Positioned within the
   relative .latex-root; sits above the drawer + modal layers. */
.ctx-menu {
  position: absolute;
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
  min-height: 40px;
  padding: 9px 12px;
  text-align: left;
  border: none;
  border-radius: 7px;
  background: none;
  color: var(--text);
  font: 500 14px/1.2 var(--font);
  cursor: pointer;
}
.ctx-item:active { background: var(--surface2, var(--surface)); }
.ctx-item--danger { color: var(--accent); }
.tree-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  font-size: 12px;
  color: var(--muted);
  flex: 0 0 auto;
}
.tree-file--selected .tree-icon { color: rgba(255,255,255,0.8); }
.tree-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.drawer-foot {
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}

/* ---- chat panel ---- */
.chat-panel {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface);
  border-top: 1px solid var(--border);
}
.chat-scroll {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.chat-note {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.55;
  padding: 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.chat-note b { color: var(--text); }
.chat-note ul { margin: 8px 0 0 18px; padding: 0; }
.chat-note li { margin-bottom: 4px; }
.chat-note code {
  background: var(--surface2, var(--surface));
  padding: 0 4px;
  border-radius: 3px;
  font-family: ui-monospace, monospace;
  font-size: 90%;
}

.chat-msg {
  display: flex;
  width: 100%;
}
.chat-msg--user { justify-content: flex-end; }
.chat-msg--agent { justify-content: flex-start; }
.chat-bubble {
  max-width: 86%;
  padding: 9px 13px;
  border-radius: 14px;
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: anywhere;
}
.chat-msg--user .chat-bubble {
  background: var(--accent);
  color: #fff;
  border-bottom-right-radius: 4px;
}
.chat-msg--agent .chat-bubble {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-bottom-left-radius: 4px;
}
.chat-bubble--typing {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 10px 14px;
}
.chat-bubble--typing .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
  animation: latex-pulse 1.2s infinite ease-in-out;
}
.chat-bubble--typing .dot:nth-child(2) { animation-delay: 0.15s; }
.chat-bubble--typing .dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes latex-pulse {
  0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-2px); }
}
.chat-error {
  color: var(--accent);
  font-size: 12px;
  padding: 4px 6px;
}

.chat-composer {
  flex: 0 0 auto;
  border-top: 1px solid var(--border);
  background: var(--bg);
  padding: 10px 12px;
}
/* Inline composer banner shown when the user is offline. Subtle
   accent-tinted strip — loud enough to notice, quiet enough not to
   dominate the chat. Matches the news app's offlineBanner so the
   two surfaces feel like one family. */
.chat-offline {
  margin: 0 0 8px;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--text);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border: 1px solid var(--border);
  text-align: center;
}
.chat-input-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.chat-input {
  flex: 1 1 auto;
  resize: none;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.4;
  outline: none;
  min-height: 40px;
  max-height: 140px;
}
.chat-input:focus { border-color: var(--accent); }
.chat-input:disabled { opacity: 0.6; }
.chat-send {
  flex: 0 0 auto;
  padding: 10px 16px;
  border-radius: 10px;
  border: none;
  background: var(--accent);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  min-width: 64px;
  min-height: 44px;
}
.chat-send:disabled {
  opacity: 0.5;
  cursor: default;
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
  padding: 9px 11px;
  font-size: 14px;
  font-family: var(--font);
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  outline: none;
  margin-bottom: 14px;
  box-sizing: border-box;
}
.modal-input:focus { border-color: var(--accent); }
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.modal-btn {
  min-height: 44px;
  padding: 10px 16px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  font-family: var(--font);
}
.modal-btn--primary {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.modal-btn--danger {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.modal-btn--secondary { background: var(--surface); }

/* ---- sync pill ----
   Bottom-right floating pill that surfaces unsynced writes / offline
   state. Hidden in the steady state (online + 0 pending) so it
   doesn't clutter the preview pane with a persistent "Saved" sticker;
   only appears when there's something to say. Same shape as the
   countries + gym apps so the platform feels coherent. */
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
  letter-spacing: 0.04em;
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

/* ---- final layout overrides ---- */
.chat-panel {
  flex: initial;
  min-height: 300px;
  overflow: hidden;
  background: var(--surface);
  border-top: 0;
  border-left: 1px solid var(--border);
}
.chat-embed {
  flex: 1 1 auto;
  min-height: 300px;
  overflow: auto;
  background: var(--bg);
}
.chat-error {
  flex: 0 0 auto;
  margin: 8px 12px 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--text);
}
.top-actions .sync-pill {
  position: static;
  right: auto;
  bottom: auto;
  z-index: auto;
  box-shadow: none;
  white-space: nowrap;
}

@media (max-width: 980px) {
  .workspace {
    grid-template-columns: 1fr;
    overflow: auto;
  }
  .editor-pane,
  .preview-pane,
  .chat-panel {
    min-height: 340px;
    border-right: 0;
    border-left: 0;
    border-bottom: 1px solid var(--border);
  }
  .chat-panel,
  .chat-embed {
    min-height: 360px;
  }
  .file-nav-panel {
    grid-template-columns: 1fr;
    max-height: 42vh;
  }
  .nav-panel-actions {
    flex-wrap: wrap;
  }
  .nav-panel-tree {
    max-height: 24vh;
  }
}

@media (max-width: 620px) {
  .top-bar {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .top-actions {
    grid-column: 1 / -1;
    width: 100%;
    justify-content: stretch;
  }
  .toolbar-btn {
    flex: 1 1 0;
  }
  .top-actions .sync-pill {
    margin-left: auto;
  }
}
`
