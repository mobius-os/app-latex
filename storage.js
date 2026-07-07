import { useEffect, useState } from 'react'
import {
  CHAT_OPEN_VERSION,
  CHAT_RATIO_VERSION,
  DEFAULT_PROJECT_ID,
  FILE_CACHE_VERSION,
  FILE_CONTENT_CACHE_LIMIT,
  PROJECT_ID_RE,
} from './constants.js'
import {
  cleanIndexPaths,
  isUserJsonProjectPath,
  normalizeFileCacheSnapshot,
  projectPrefix,
} from './domain.js'


export function makeStorage(appId, token) {
  const ms = (typeof window !== 'undefined' && window.mobius && window.mobius.storage) || null
  const hasRuntime = !!ms
  async function get(path) {
    // Read with the TYPED getter matching how the path was written: app-owned
    // .json paths hold JSON (get); project files under files/ are user assets
    // and stay raw text even when named config.json.
    if (ms) {
      const isJson = path.endsWith('.json') && !isUserJsonProjectPath(path)
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
  async function list(prefix = '') {
    if (ms && typeof ms.list === 'function') return ms.list(prefix)
    const norm = String(prefix || '').replace(/^\/+|\/+$/g, '')
    const entries = []
    let cursor = null
    for (let guard = 0; guard < 10000; guard++) {
      const q = `?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const r = await fetch(`/api/storage/apps-list/${appId}/${norm}${q}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) throw new Error(`list ${norm} → ${r.status}`)
      const body = await r.json()
      entries.push(...(Array.isArray(body.entries) ? body.entries : []))
      cursor = body.next_cursor
      if (!cursor) break
    }
    return entries
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
    list,
    subscribeText,
    pendingCount,
    hasRuntime,
  }
}

export function makeProjectStorage(storage, activeProjectId) {
  const prefix = projectPrefix(activeProjectId)
  const key = (path) => `${prefix}${path}`
  return {
    ...storage,
    prefix,
    key,
    get: (path) => storage.get(key(path)),
    getFresh: (path) => storage.getFresh(key(path)),
    getBlob: (path) => storage.getBlob(key(path)),
    getBlobFresh: (path) => storage.getBlobFresh(key(path)),
    setText: (path, text) => storage.setText(key(path), text),
    setBlob: (path, blob, options) => storage.setBlob(key(path), blob, options),
    setJSON: (path, obj) => storage.setJSON(key(path), obj),
    remove: (path) => storage.remove(key(path)),
    list: (path = '') => storage.list(key(path)),
    subscribeText: (path, cb) => storage.subscribeText(key(path), cb),
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

export function useOnline() {
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

export function fileCacheKey(appId) {
  return `latex:${appId}:files-cache:v${FILE_CACHE_VERSION}`
}

export function projectFileCacheKey(appId, projectId) {
  if (projectId === DEFAULT_PROJECT_ID) return fileCacheKey(appId)
  return `latex:${appId}:project:${projectId}:files-cache:v${FILE_CACHE_VERSION}`
}

export function activeProjectKey(appId) {
  return `latex:${appId}:activeProject`
}

export function readActiveProject(appId) {
  if (typeof localStorage === 'undefined') return DEFAULT_PROJECT_ID
  const stored = localStorage.getItem(activeProjectKey(appId))
  return PROJECT_ID_RE.test(stored || '') ? stored : DEFAULT_PROJECT_ID
}

export function writeActiveProject(appId, projectId) {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(activeProjectKey(appId), projectId || DEFAULT_PROJECT_ID) } catch {}
}

export function chatOpenKey(appId) { return `latex:${appId}:chat-open:v${CHAT_OPEN_VERSION}` }
export function chatRatioKey(appId) { return `latex:${appId}:chat-ratio:v${CHAT_RATIO_VERSION}` }

export function readChatOpen(appId) {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(chatOpenKey(appId)) === 'true'
}

export function readChatRatio(appId) {
  if (typeof localStorage === 'undefined') return 0.5
  const raw = Number(localStorage.getItem(chatRatioKey(appId)))
  if (!Number.isFinite(raw) || raw <= 0 || raw >= 1) return 0.5
  return Math.max(0.05, Math.min(0.95, raw))
}

export function readFileCache(appId, projectId = DEFAULT_PROJECT_ID) {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(projectFileCacheKey(appId, projectId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return normalizeFileCacheSnapshot(parsed)
  } catch {
    return null
  }
}

export function writeFileCache(appId, projectId, index, contents, lastPath) {
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
      projectFileCacheKey(appId, projectId),
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

export function removeFileCache(appId, projectId) {
  if (typeof localStorage === 'undefined') return
  try { localStorage.removeItem(projectFileCacheKey(appId, projectId)) } catch {}
}
