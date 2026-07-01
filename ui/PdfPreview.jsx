import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ZOOM_BTN_FACTOR,
  ZOOM_DOUBLE_TAP,
  ZOOM_FIT,
  ZOOM_MAX,
  ZOOM_MIN,
  anchoredZoomScroll,
  clampScale,
  pinchScale,
} from '../pdf/zoom.js'
import { ToolIcon } from './ToolIcon.jsx'

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

export function PdfPreview({ storage, path, version, appId, token, storagePrefix = '' }) {
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

  // Download / open the PDF in a new tab. The download lives HERE — inside the
  // preview pane, not the main app toolbar — so it travels with the PDF and
  // never disturbs the toolbar icon layout. Same-origin storage URL with the
  // ?token= query: a window.open()ed tab can't carry an Authorization header,
  // and the storage route serves application/pdf inline, so the browser shows
  // it and offers its own Save. Gated on having appId+token (the tree-opened
  // .pdf path passes them too).
  const canDownload = !!(appId && token && path)
  const onDownload = useCallback(() => {
    if (!canDownload) return
    // Segment-encode the path so a filename containing #, ?, spaces, etc.
    // survives the URL: encode each segment but keep the '/' separators (the
    // storage route is a {path:path} matcher). encodeURIComponent on the whole
    // string would turn '/' into %2F and break the route.
    const encPath = `${storagePrefix}${String(path)}`
      .split('/')
      .map(encodeURIComponent)
      .join('/')
    window.open(`/api/storage/apps/${appId}/${encPath}?token=${encodeURIComponent(token)}`)
  }, [canDownload, appId, token, path, storagePrefix])

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
  // The control bar is a SIBLING below the scroller (a normal flex row in the
  // .pdf-stage column), not an overlay floating over the pages — so it never
  // covers the PDF (owner feedback #5). It also keeps the scroller’s content
  // as ONLY the pages host, whose geometry scales uniformly with the zoom,
  // which is what keeps the anchored-zoom scroll conversion exact. The
  // download affordance lives in this bar too (owner feedback #4): inside the
  // preview pane, out of the main app toolbar.
  return (
    <div className="pdf-stage">
      {loading && <div className="preview-note">Rendering PDF…</div>}
      <div className="pdf-viewer" ref={scrollRef} onDoubleClick={onDoubleClick}>
        <div className="pdf-pages" ref={pagesRef} />
      </div>
      <div className="pdf-controlbar">
        <div className="pdf-zoom-group" aria-label="Zoom controls">
          <button
            type="button"
            className="pdf-ctl-btn"
            aria-label="Zoom out"
            title="Zoom out"
            onClick={zoomOut}
            disabled={atMin}
          >−</button>
          <button
            type="button"
            className="pdf-ctl-btn pdf-zoom-pct"
            aria-label={`Zoom level: ${zoomPct}%`}
            title="Reset to fit width"
            onClick={zoomFit}
          >{zoomPct}%</button>
          <button
            type="button"
            className="pdf-ctl-btn"
            aria-label="Zoom in"
            title="Zoom in"
            onClick={zoomIn}
            disabled={atMax}
          >+</button>
        </div>
        {canDownload && (
          <button
            type="button"
            className="pdf-ctl-btn pdf-download-btn"
            aria-label="Download PDF"
            title="Download PDF"
            onClick={onDownload}
          >
            <ToolIcon name="download" size={18} />
          </button>
        )}
      </div>
    </div>
  )
}
