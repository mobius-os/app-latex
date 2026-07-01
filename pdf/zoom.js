/* zoom-math:begin — pure, dependency-free zoom helpers.
   tests/zoom-math.test.mjs extracts and executes this exact block, so keep
   it plain JS (no JSX, no imports, no references to anything outside it). */

// Continuous zoom bounds for the PDF viewer. 1 = fit-width.
export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 4
export const ZOOM_FIT = 1          // fit = pages fill container width
export const ZOOM_DOUBLE_TAP = 2   // double-tap toggles fit <-> 2×
export const ZOOM_BTN_FACTOR = 1.25 // +/- buttons multiply/divide by this

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
