import { BINARY_FILE_EXTS, DEFAULT_PROJECT_ID, NAME_RE, PROJECT_ID_RE } from './constants.js'


export function projectPrefix(activeProjectId) {
  return activeProjectId === DEFAULT_PROJECT_ID ? '' : `projects/${activeProjectId}/`
}

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

export function extensionFor(path) {
  return String(path || '').split('.').pop().toLowerCase()
}

export function isBinaryProjectPath(path) {
  return BINARY_FILE_EXTS.has(extensionFor(path))
}

export function isTextProjectPath(path) {
  return isSafeStoragePath(path)
    && !path.endsWith('/.keep')
    && !isBinaryProjectPath(path)
}

// App-owned JSON records (files-index.json, main.json, chat_id.json,
// projects.json, build status) use the typed JSON storage getter. User project
// files live under files/ and are editable text even when their extension is
// .json, because LaTeX projects commonly include JSON config assets.
export function isManagedJsonPath(path) {
  const value = String(path || '').toLowerCase()
  return value.endsWith('.json') && !isSafeStoragePath(value)
}

export function isUserJsonProjectPath(path) {
  const value = String(path || '').toLowerCase()
  if (!value.endsWith('.json')) return false
  if (isSafeStoragePath(value)) return true
  const match = value.match(/^projects\/([^/]+)\/(files\/.+)$/)
  return !!(match && PROJECT_ID_RE.test(match[1]) && isSafeStoragePath(match[2]))
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

export function cleanIndexPaths(paths) {
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

export function buildTree(paths) {
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
export function fileKind(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.tex')) return 'tex'
  if (lower.endsWith('.md')) return 'md'
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.match(/\.(png|jpe?g|gif|webp|svg)$/)) return 'image'
  return 'file'
}

// Bare lucide-style file glyph for the tree (fill none, currentColor stroke,
// round caps — the shared Möbius icon idiom). Inherits the row's text color.

export function isFilePath(path, index) {
  return index.includes(path)
}

export function parseBuildErrorChips(log) {
  if (!log || typeof log !== 'string') return []
  return log
    .split('\n')
    .filter((l) => l.startsWith('! '))
    .map((l) => l.slice(2).trim())
    .filter(Boolean)
    .slice(0, 3)
}

export function normalizeProjects(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id : ''
    if (!PROJECT_ID_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    const name = typeof item.name === 'string' && item.name.trim()
      ? item.name.trim()
      : (id === DEFAULT_PROJECT_ID ? 'Project 1' : id)
    const createdAt = Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now()
    out.push({ id, name, createdAt })
  }
  return out
}

function slugifyProjectId(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export function uniqueProjectId(name, projects) {
  const used = new Set((projects || []).map((p) => p.id))
  let base = slugifyProjectId(name)
  if (!base || !PROJECT_ID_RE.test(base) || used.has(base)) {
    base = base || 'project'
    for (let i = 0; i < 20; i++) {
      const suffix = Math.random().toString(36).slice(2, 8)
      const id = `${base}-${suffix}`.slice(0, 64)
      if (PROJECT_ID_RE.test(id) && !used.has(id)) return id
    }
  }
  let id = base
  let n = 2
  while (used.has(id) || !PROJECT_ID_RE.test(id)) {
    const suffix = `-${n++}`
    id = `${base.slice(0, 64 - suffix.length)}${suffix}`
  }
  return id
}

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
