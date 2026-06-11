// Unit tests for the PDF viewer's pure zoom helpers (clampScale, pinchScale,
// anchoredZoomScroll). The helpers live in index.jsx inside the
// `zoom-math:begin` / `zoom-math:end` fence as plain dependency-free JS, so
// this test extracts that exact block and executes it directly — no esbuild
// bundle, no react/pdfjs resolution needed (the whole-bundle import path is
// what keeps path-guards' first test red in this environment).
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

// Own scratch dir (path-guards uses tests/.build): node --test runs test
// files in parallel processes, so sharing a dir both sides rm -rf would race.
const root = dirname(fileURLToPath(import.meta.url))
const buildDir = join(root, '.build-zoom')

async function loadZoomMath() {
  const source = readFileSync(join(root, '..', 'index.jsx'), 'utf8')
  const begin = source.indexOf('/* zoom-math:begin')
  const end = source.indexOf('/* zoom-math:end */')
  assert.ok(begin !== -1 && end > begin, 'zoom-math fence found in index.jsx')
  const block = source.slice(begin, end)
  await rm(buildDir, { recursive: true, force: true })
  await mkdir(buildDir, { recursive: true })
  const out = join(buildDir, 'zoom-math.mjs')
  await writeFile(out, block)
  return import(pathToFileURL(out))
}

test('clampScale bounds the zoom to [ZOOM_MIN, ZOOM_MAX]', async () => {
  const { clampScale, ZOOM_MIN, ZOOM_MAX } = await loadZoomMath()
  assert.equal(clampScale(1), 1)
  assert.equal(clampScale(0.01), ZOOM_MIN)
  assert.equal(clampScale(99), ZOOM_MAX)
  assert.equal(clampScale(ZOOM_MIN), ZOOM_MIN)
  assert.equal(clampScale(ZOOM_MAX), ZOOM_MAX)
  assert.equal(clampScale(NaN), ZOOM_MIN)
  assert.equal(clampScale(Infinity), ZOOM_MIN)
})

test('pinchScale scales continuously from the gesture-start scale', async () => {
  const { pinchScale, ZOOM_MIN, ZOOM_MAX } = await loadZoomMath()
  // Fingers twice as far apart → twice the scale.
  assert.equal(pinchScale(1, 100, 200), 2)
  // Fingers half as far apart → half the scale.
  assert.equal(pinchScale(1.5, 200, 100), 0.75)
  // No movement → unchanged.
  assert.equal(pinchScale(2, 120, 120), 2)
  // Clamped at both ends.
  assert.equal(pinchScale(1, 400, 10), ZOOM_MIN)
  assert.equal(pinchScale(3, 10, 400), ZOOM_MAX)
  // Degenerate distances never produce NaN.
  assert.equal(pinchScale(2, 0, 100), 2)
  assert.equal(pinchScale(2, 100, 0), 2)
})

test('anchoredZoomScroll keeps the content under the anchor stationary', async () => {
  const { anchoredZoomScroll } = await loadZoomMath()
  // Zoom 2× anchored at viewport point (100, 200) with scroll (50, 80):
  // the content coordinate under the anchor is (150, 280); after scaling it
  // sits at (300, 560); keeping it at the anchor needs scroll (200, 360).
  assert.deepEqual(
    anchoredZoomScroll({ scrollLeft: 50, scrollTop: 80, originX: 100, originY: 200, ratio: 2 }),
    { scrollLeft: 200, scrollTop: 360 },
  )
})

test('anchoredZoomScroll inverts itself (zoom in then back out returns home)', async () => {
  const { anchoredZoomScroll } = await loadZoomMath()
  const start = { scrollLeft: 120, scrollTop: 340 }
  const anchor = { originX: 180, originY: 90 }
  const zoomed = anchoredZoomScroll({ ...start, ...anchor, ratio: 2.5 })
  const back = anchoredZoomScroll({
    scrollLeft: zoomed.scrollLeft,
    scrollTop: zoomed.scrollTop,
    ...anchor,
    ratio: 1 / 2.5,
  })
  assert.ok(Math.abs(back.scrollLeft - start.scrollLeft) < 1e-9)
  assert.ok(Math.abs(back.scrollTop - start.scrollTop) < 1e-9)
})

test('anchoredZoomScroll is identity at ratio 1 and never goes negative', async () => {
  const { anchoredZoomScroll } = await loadZoomMath()
  assert.deepEqual(
    anchoredZoomScroll({ scrollLeft: 33, scrollTop: 44, originX: 10, originY: 20, ratio: 1 }),
    { scrollLeft: 33, scrollTop: 44 },
  )
  // Zooming far out near the document origin would compute a negative
  // scroll; the helper clamps at 0 (the browser clamps the upper bound).
  const out = anchoredZoomScroll({ scrollLeft: 0, scrollTop: 0, originX: 200, originY: 300, ratio: 0.5 })
  assert.deepEqual(out, { scrollLeft: 0, scrollTop: 0 })
})
