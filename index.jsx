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
const KATEX_LOAD_TIMEOUT_MS = 5000
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
  const importPromise = import('https://esm.sh/katex@0.16?bundle')
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('katex-load-timeout')), KATEX_LOAD_TIMEOUT_MS)
  })
  _katexPromise = Promise.race([importPromise, timeoutPromise]).catch((err) => {
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
function PdfPreview({ storage, path }) {
  const [url, setUrl] = useState(null)
  const [err, setErr] = useState(null)
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
  }, [storage, path])
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

function FileNode({ node, selectedPath, onSelect, depth }) {
  const [expanded, setExpanded] = useState(true)
  if (node.children.size === 0 && node.isFile) {
    const selected = node.path === selectedPath
    return (
      <button
        type="button"
        className={`tree-file ${selected ? 'tree-file--selected' : ''}`}
        style={{ paddingLeft: `${10 + depth * 16}px` }}
        onClick={() => onSelect(node.path)}
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
  // Root folder (depth -1) renders just its children, no row of its own.
  if (depth < 0) {
    return (
      <>
        {sortedChildren.map((c) => (
          <FileNode
            key={c.path}
            node={c}
            selectedPath={selectedPath}
            onSelect={onSelect}
            depth={0}
          />
        ))}
      </>
    )
  }
  return (
    <>
      <button
        type="button"
        className="tree-folder"
        style={{ paddingLeft: `${10 + depth * 16}px` }}
        onClick={() => setExpanded((e) => !e)}
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
        />
      ))}
    </>
  )
}

function FileDrawer({
  open, onClose, files, selectedPath, onSelect,
  onCreateFile, onCreateFolder, onDeleteFile,
}) {
  const root = useMemo(() => buildTree(files), [files])
  return (
    <>
      <div
        className={`drawer-scrim ${open ? 'drawer-scrim--open' : ''}`}
        onClick={onClose}
      />
      <aside className={`file-drawer ${open ? 'file-drawer--open' : ''}`}>
        <div className="drawer-head">
          <span className="drawer-title">Files</span>
          <button className="drawer-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="drawer-actions">
          <button className="drawer-btn" onClick={onCreateFile}>+ New file</button>
          <button className="drawer-btn" onClick={onCreateFolder}>+ New folder</button>
        </div>
        <div className="drawer-tree">
          {files.length === 0 ? (
            <div className="drawer-empty">
              No files yet. Tap “+ New file” or ask the agent to make one.
            </div>
          ) : (
            <FileNode
              node={root}
              selectedPath={selectedPath}
              onSelect={(p) => { onSelect(p); onClose() }}
              depth={-1}
            />
          )}
        </div>
        {selectedPath && (
          <div className="drawer-foot">
            <button
              className="drawer-btn drawer-btn--danger"
              onClick={() => onDeleteFile(selectedPath)}
            >
              Delete “{selectedPath}”
            </button>
          </div>
        )}
      </aside>
    </>
  )
}

// ----------------------------------------------------------------------
// Chat panel. We POST a user message to /api/chats/<chat_id>/messages,
// then poll /api/chats/<chat_id> every second until the chat reports
// `running: false`. We do not consume the SSE stream — the streaming
// endpoint emits ~12 different event types (text, tool_start,
// tool_input, tool_end, question, ...) that we'd otherwise have to
// re-implement the shell's interpretation of. Polling the persisted
// chat history is good enough for an embedded panel: we render the
// last assistant message's text blocks as one flowing reply, which
// matches the spec ("after editing, summarise the change in one
// sentence").
// ----------------------------------------------------------------------

// System-prompt-style first user message. We send this as a hidden
// first turn on chat creation so the sub-agent knows it's working in
// /data/apps/<id>/files/. The chat-creation API doesn't take a
// system_prompt override (see chats.py:create_chat — it inherits the
// shell's default skill), so an opening "here's the contract" user
// message is the practical lever.
//
// The user message is sent with hidden:true so the main Möbius shell
// (where the same chat may be opened from the drawer) renders it as
// nothing — see frontend/ChatView.jsx, which skips m.hidden. The
// agent's "Ready." reply is NOT auto-hidden by the backend; we live
// with that one-line leak rather than depend on an explicit hidden
// flag the backend doesn't apply to assistant turns. In-app, we use
// `dropBootstrap()` (below) to strip both turns from the rendered
// thread — more robust than slice(2), which silently mis-slices if
// the API ever returns fewer than two messages mid-bootstrap.
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
    'Reply with “Ready.” to confirm you’ve read this brief.',
  ].join('\n')
}

// Strip the bootstrap user message (which we sent with hidden:true)
// and the assistant turn that immediately follows it from a message
// list. Robust to weird states (missing first turn, multi-turn
// bootstrap retry) where a hardcoded slice(2) would mis-slice and
// leak the contract into the user-visible thread.
function dropBootstrap(msgs) {
  if (!msgs || msgs.length === 0) return msgs || []
  let i = 0
  if (msgs[i] && msgs[i].role === 'user' && msgs[i].hidden) i += 1
  if (msgs[i] && msgs[i].role === 'assistant' && i > 0) i += 1
  return msgs.slice(i)
}

// One assistant turn's plain text — concatenate text blocks, ignoring
// tool calls / thinking / questions. Good enough for a "summary"
// surface.
function assistantPlainText(message) {
  if (!message || message.role !== 'assistant') return ''
  if (typeof message.content === 'string') return message.content
  const blocks = message.blocks || []
  return blocks
    .filter((b) => b.type === 'text' && b.content)
    .map((b) => b.content)
    .join('\n')
}

// localStorage key for the chat composer draft. Per-app so two app
// installs don't trample each other; same shape as the news report
// read-cache (which uses localStorage rather than the outbox-backed
// storage shim so we don't queue keystrokes into the sync queue).
function draftKey(appId) {
  return `latex:${appId}:chat-draft:v1`
}

function ChatPanel({
  appId, token, storage, online,
  onFilesMaybeChanged,
}) {
  const [chatId, setChatId] = useState(null)
  const [bootstrapping, setBootstrapping] = useState(true)
  const [messages, setMessages] = useState([])  // [{role, content|blocks}]
  // Draft is persisted to localStorage so flipping offline (and the
  // subsequent re-mount many shells do on visibility change) doesn't
  // eat what the user was typing. localStorage rather than the
  // outbox-backed storage shim: keystrokes shouldn't enqueue server
  // writes, and the draft is single-user, single-device by nature.
  const [draft, setDraft] = useState(() => {
    if (typeof localStorage === 'undefined') return ''
    try { return localStorage.getItem(draftKey(appId)) || '' } catch { return '' }
  })
  const [sending, setSending] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState(null)
  const scrollerRef = useRef(null)
  const pollRef = useRef(null)
  const filesPollRef = useRef(null)

  // Persist the draft on every change. The set call is synchronous so
  // there's no race with a quick send; the storage write is bounded
  // (~140KB max in practice, well under the 5MB quota).
  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try {
      if (draft) localStorage.setItem(draftKey(appId), draft)
      else localStorage.removeItem(draftKey(appId))
    } catch {
      // Quota / disabled — keep going. The in-memory draft survives
      // this session even if persistence fails.
    }
  }, [appId, draft])

  // Discover or create the chat id. We persist {id: "uuid"} to
  // chat_id.json so subsequent app loads land in the same conversation.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const saved = await storage.get('chat_id.json')
        if (cancelled) return
        if (saved && saved.id) {
          setChatId(saved.id)
          // Hydrate history.
          await loadHistory(saved.id)
          setBootstrapping(false)
          return
        }
      } catch (e) {
        // Fall through and create fresh.
      }
      setBootstrapping(false)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, token])

  // Load past messages for an existing chat.
  async function loadHistory(id) {
    try {
      const r = await fetch(`/api/chats/${id}?limit=200`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) return
      const data = await r.json()
      // Hide the bootstrap turn (first user + assistant) from the UI.
      // The bootstrap prompt is implementation detail.
      const msgs = dropBootstrap(data.messages || [])
      setMessages(msgs)
    } catch (e) {
      // Quietly ignore — the chat might have been deleted; user can
      // start fresh by sending a message.
    }
  }

  // Create a new chat and prime it with the system-style instructions.
  // Returns the new chat id or null on failure.
  async function createChat() {
    try {
      const r = await fetch('/api/chats', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'LaTeX editor' }),
      })
      if (!r.ok) return null
      const data = await r.json()
      // Persist immediately so a refresh during the bootstrap turn
      // doesn't orphan the chat.
      await storage.setJSON('chat_id.json', { id: data.id })
      // Send the bootstrap prompt as a hidden first user message so
      // the sub-agent knows where to write files. We don't await its
      // completion — the user's own message follows in the same call
      // path and queues behind the bootstrap turn.
      await fetch(`/api/chats/${data.id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        // hidden:true so the main Möbius shell (drawer → this chat)
        // doesn't render the contract as a user turn. The agent's
        // "Ready." reply still posts as a normal assistant message;
        // see comment on bootstrapPrompt() for the trade-off.
        body: JSON.stringify({ content: bootstrapPrompt(appId), hidden: true }),
      })
      return data.id
    } catch (e) {
      setError(`Could not create chat: ${e.message || e}`)
      return null
    }
  }

  // Poll loop: every 2s while we expect activity, fetch the chat and
  // refresh the message list. Stops when `running: false` AND the
  // last message is an assistant turn (i.e. the agent has spoken).
  // 2s (was 1s) is responsive enough for an embedded panel — the
  // surface only renders the final assistant message anyway, so we
  // don't need sub-second turn-of-bubble updates. Costs us roughly
  // half the GETs per build. The SSE stream would be cheaper still,
  // but its 12-event-type protocol would require us to re-implement
  // the shell's interpretation of tool_start/tool_end/question/...
  // and that's out of scope for the polish pass.
  function startPolling(id) {
    if (pollRef.current) clearInterval(pollRef.current)
    setStreaming(true)
    let consecutiveIdle = 0
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/chats/${id}?limit=200`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!r.ok) return
        const data = await r.json()
        const msgs = dropBootstrap(data.messages || [])
        setMessages(msgs)
        if (!data.running) {
          consecutiveIdle += 1
          // Two consecutive idle ticks before we consider it really
          // done — guards against the brief gap between turns when
          // the queue promotes the next pending message.
          if (consecutiveIdle >= 2) {
            clearInterval(pollRef.current)
            pollRef.current = null
            setStreaming(false)
            // One last file-list refresh so a delete the agent did at
            // turn-end is reflected immediately, not 3s later.
            onFilesMaybeChanged()
          }
        } else {
          consecutiveIdle = 0
        }
      } catch (e) {
        // Network blip — keep polling. The next tick will retry.
      }
    }, 2000)
  }

  // Separate, slower poll for the file index while a turn is active.
  // The chat detail tells us what the agent SAID; this tells us what
  // it DID. 5s cadence — the agent's edit-then-summarise turn takes
  // tens of seconds, so a 5s lag on the tree refresh is invisible
  // and a final post-turn refresh (in startPolling) catches the
  // last write within ~2s of the agent finishing.
  useEffect(() => {
    if (!streaming) {
      if (filesPollRef.current) {
        clearInterval(filesPollRef.current)
        filesPollRef.current = null
      }
      return
    }
    filesPollRef.current = setInterval(() => {
      onFilesMaybeChanged()
    }, 5000)
    return () => {
      if (filesPollRef.current) clearInterval(filesPollRef.current)
      filesPollRef.current = null
    }
  }, [streaming, onFilesMaybeChanged])

  // Cleanup on unmount.
  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current)
    if (filesPollRef.current) clearInterval(filesPollRef.current)
  }, [])

  // Auto-scroll the thread when new content arrives.
  useEffect(() => {
    if (!scrollerRef.current) return
    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight
  }, [messages, sending, streaming])

  const handleSend = useCallback(async () => {
    const text = draft.trim()
    if (!text || sending || !online) return
    setError(null)
    setSending(true)
    try {
      let id = chatId
      if (!id) {
        id = await createChat()
        if (!id) {
          setSending(false)
          return
        }
        setChatId(id)
      }
      // Optimistic append so the user sees their message immediately.
      setMessages((prev) => [...prev, { role: 'user', content: text }])
      setDraft('')
      const r = await fetch(`/api/chats/${id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, hidden: false }),
      })
      if (!r.ok && r.status !== 202) {
        setError(`Send failed (HTTP ${r.status}).`)
      } else {
        startPolling(id)
      }
    } catch (e) {
      setError(e.message || 'Send failed.')
    } finally {
      setSending(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, sending, online, chatId, token, appId])

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <section className="chat-panel">
      <div className="chat-scroll" ref={scrollerRef}>
        {bootstrapping ? (
          <div className="chat-note">Loading…</div>
        ) : messages.length === 0 ? (
          <div className="chat-note">
            <b>Describe what you want to write.</b> The agent will create
            <code> .tex </code> files in the file tree on the left. Try:
            <ul>
              <li>“Make a one-page CV for Hamza Merzic”</li>
              <li>“Add a section on the chain rule with two worked examples”</li>
              <li>“Convert welcome.tex into a math cheat sheet”</li>
            </ul>
          </div>
        ) : (
          messages.map((m, i) => {
            if (m.role === 'user') {
              const txt = typeof m.content === 'string' ? m.content : ''
              return (
                <div className="chat-msg chat-msg--user" key={i}>
                  <div className="chat-bubble">{txt}</div>
                </div>
              )
            }
            const txt = assistantPlainText(m)
            if (!txt) return null
            return (
              <div className="chat-msg chat-msg--agent" key={i}>
                <div className="chat-bubble">{txt}</div>
              </div>
            )
          })
        )}
        {streaming && (
          <div className="chat-msg chat-msg--agent">
            <div className="chat-bubble chat-bubble--typing">
              <span className="dot" /><span className="dot" /><span className="dot" />
            </div>
          </div>
        )}
        {error && <div className="chat-error">{error}</div>}
      </div>
      <div className="chat-composer">
        {!online && (
          <div className="chat-offline" role="status" aria-live="polite">
            Offline — replies resume when you reconnect. Your draft is saved.
          </div>
        )}
        <div className="chat-input-row">
          {/* The textarea stays enabled while offline so the user can
              keep drafting; only Send is gated. The brief: drafts
              should NOT be lost on an offline transition, so making
              the input read-only would be the wrong shape. */}
          <textarea
            className="chat-input"
            placeholder={online ? 'Describe your document…' : 'Type your message — sends when online'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={sending}
            rows={2}
          />
          <button
            className="chat-send"
            onClick={handleSend}
            disabled={!online || sending || !draft.trim()}
            title={!online ? 'Reconnect to send' : undefined}
          >
            {sending ? '…' : 'Send'}
          </button>
        </div>
      </div>
    </section>
  )
}

// ----------------------------------------------------------------------
// Online/offline detection. window.mobius.online is the runtime's
// own signal (richer than navigator.onLine — it pings the API);
// navigator.onLine is the browser-level fallback that's accurate
// enough for an "are we able to talk to the agent" check.
// ----------------------------------------------------------------------
function useOnline() {
  const initial = (() => {
    if (typeof window === 'undefined') return true
    if (typeof window.mobius?.online === 'boolean') return window.mobius.online
    return navigator.onLine !== false
  })()
  const [online, setOnline] = useState(initial)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onUp = () => setOnline(true)
    const onDown = () => setOnline(false)
    window.addEventListener('online', onUp)
    window.addEventListener('offline', onDown)
    // Subscribe to the richer mobius signal if present.
    let mobiusUnsub = null
    if (window.mobius && typeof window.mobius.onChange === 'function') {
      mobiusUnsub = window.mobius.onChange((s) => {
        if (typeof s?.online === 'boolean') setOnline(s.online)
      })
    }
    return () => {
      window.removeEventListener('online', onUp)
      window.removeEventListener('offline', onDown)
      if (mobiusUnsub) mobiusUnsub()
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
  const [fileCache, setFileCache] = useState(() => cached?.contents || {})
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Restore the file the user was viewing last session so an offline
  // reload opens straight into their work-in-progress (assuming we
  // have its body cached — handled by the cache-first load below).
  const [selectedPath, setSelectedPath] = useState(() => cached?.lastPath || null)
  const [fileContent, setFileContent] = useState('')
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState(null)

  // Persist the file-cache snapshot whenever the index, contents, or
  // last-selected path change. Bounded above by FILE_CONTENT_CACHE_LIMIT
  // inside writeFileCache. The path field lets an offline reload land
  // on the file the user was last editing instead of bouncing to the
  // first tree entry.
  useEffect(() => {
    writeFileCache(appId, files, fileCache, selectedPath)
  }, [appId, files, fileCache, selectedPath])

  // moebius:nav-back integration — when the drawer is open and the
  // user swipes back / presses the device back button, the shell hands
  // us the back-press. We close the drawer instead of dismissing the
  // whole app. openDrawer / closeDrawer keep our state in lock-step
  // with the shell's back-sentinel via the moebius:nav-push / nav-pop
  // protocol (same shape prod's klix-filter and our app-store use).
  useEffect(() => {
    function onMessage(event) {
      if (event.origin !== window.location.origin) return
      if (event.data?.type === 'moebius:nav-back') {
        setDrawerOpen(false)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const openDrawer = useCallback(async () => {
    const requestId = `np-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          window.removeEventListener('message', onAck)
          reject(new Error('nav-push timeout'))
        }, 5000)
        function onAck(event) {
          if (event.origin !== window.location.origin) return
          if (event.data?.requestId !== requestId) return
          if (event.data.type === 'moebius:nav-push-ack') {
            clearTimeout(timer); window.removeEventListener('message', onAck); resolve()
          } else if (event.data.type === 'moebius:nav-push-rejected') {
            clearTimeout(timer); window.removeEventListener('message', onAck); reject()
          }
        }
        window.addEventListener('message', onAck)
        window.parent.postMessage(
          { type: 'moebius:nav-push', label: 'latex-files', requestId },
          window.location.origin,
        )
      })
    } catch {
      // Older shell — open without the sentinel.
    }
    setDrawerOpen(true)
  }, [])

  const closeDrawer = useCallback(() => {
    window.parent.postMessage(
      { type: 'moebius:nav-pop' }, window.location.origin,
    )
    setDrawerOpen(false)
  }, [])

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
      return
    }
    const ext = selectedPath.split('.').pop().toLowerCase()
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'].includes(ext)) {
      setFileContent('')
      setFileLoading(false)
      setFileError(null)
      return
    }
    // Cache hit — paint synchronously. No background refetch: agent
    // edits land via onFilesMaybeChanged, the only other writer.
    const cachedBody = fileCache[selectedPath]
    if (typeof cachedBody === 'string') {
      setFileContent(cachedBody)
      setFileError(null)
      setFileLoading(false)
      return
    }
    // Cache miss. Offline → show a friendly note rather than the
    // "File not found" misnomer the old code used when storage.get
    // returned null offline. Online → fetch + memoise.
    if (!online) {
      setFileContent('')
      setFileError('Not available offline. Open this file once online to cache it.')
      setFileLoading(false)
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
      } else {
        const body = typeof data === 'string'
          ? data
          // JSON came back as an object — stringify so the preview
          // shows something legible.
          : JSON.stringify(data, null, 2)
        setFileContent(body)
        setFileError(null)
        // Memoise for instant re-select + offline-reload survival.
        setFileCache((prev) => (prev[selectedPath] === body ? prev : { ...prev, [selectedPath]: body }))
      }
      setFileLoading(false)
    }).catch((e) => {
      if (!cancelled) {
        setFileError(e.message || 'Could not load file.')
        setFileLoading(false)
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
    if (!drawerOpen) return
    refreshFiles()
  }, [drawerOpen, refreshFiles])

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
          setFileCache((prev) => (prev[selectedPath] === data ? prev : { ...prev, [selectedPath]: data }))
        } else if (data == null) {
          setFileContent('')
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

  const handleCreateFile = useCallback(async () => {
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
    if (files.includes(path)) {
      await modal.alert(`“${path}” already exists.`, { title: 'Name taken' })
      return
    }
    try {
      await storage.setText(path, '')
      const next = [...files, path].sort()
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      // Seed the cache with the empty body so a subsequent offline
      // reload doesn't show "Not available offline" for a file we
      // just created.
      setFileCache((prev) => ({ ...prev, [path]: '' }))
      setSelectedPath(path)
      closeDrawer()
    } catch (e) {
      await modal.alert(e.message || String(e), { title: 'Could not create file' })
    }
  }, [files, storage, modal, closeDrawer])

  const handleCreateFolder = useCallback(async () => {
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
      const next = [...files, path].sort()
      await storage.setJSON('files-index.json', next)
      setFiles(next)
    } catch (e) {
      await modal.alert(e.message || String(e), { title: 'Could not create folder' })
    }
  }, [files, storage, modal])

  const handleDeleteFile = useCallback(async (path) => {
    const ok = await modal.confirm(
      `Delete “${path}”? This cannot be undone.`,
      { title: 'Delete file', danger: true },
    )
    if (!ok) return
    try {
      await storage.remove(path)
      const next = files.filter((p) => p !== path)
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
      if (selectedPath === path) {
        // Prefer a real file over a `.keep` placeholder for the
        // post-delete selection — landing on .keep would show a
        // blank preview pane.
        const nextReal = next.find((p) => !p.endsWith('/.keep'))
        setSelectedPath(nextReal || null)
      }
    } catch (e) {
      await modal.alert(e.message || String(e), { title: 'Could not delete' })
    }
  }, [files, selectedPath, storage, modal])

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
    const ext = selectedPath.split('.').pop().toLowerCase()
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
      return <ImagePreview storage={storage} path={selectedPath} />
    }
    if (ext === 'pdf') {
      return <PdfPreview storage={storage} path={selectedPath} />
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
          className="drawer-toggle"
          onClick={openDrawer}
          aria-label="Open file tree"
        >
          ☰
        </button>
        <div className="top-title">
          {selectedPath
            ? <span className="top-path">{selectedPath}</span>
            : <span className="top-path top-path--muted">No file selected</span>}
        </div>
      </header>
      <main className="preview-pane">{renderPreview()}</main>
      <ChatPanel
        appId={appId}
        token={token}
        storage={storage}
        online={online}
        onFilesMaybeChanged={onFilesMaybeChanged}
      />
      <FileDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        files={files}
        selectedPath={selectedPath}
        onSelect={setSelectedPath}
        onCreateFile={handleCreateFile}
        onCreateFolder={handleCreateFolder}
        onDeleteFile={handleDeleteFile}
      />
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
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  overflow: hidden;
}

.top-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.drawer-toggle {
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
.drawer-toggle:active { background: var(--surface2, var(--surface)); }
.top-title {
  flex: 1 1 auto;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.top-path { font-family: var(--font); }
.top-path--muted { color: var(--muted); font-weight: 400; }

/* ---- preview pane ---- */
.preview-pane {
  flex: 0 0 40%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 18px 18px 24px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
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
`
