import { useCallback, useEffect, useRef, useState } from 'react'

export function ImagePreview({ storage, path, reloadKey = 0 }) {
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
