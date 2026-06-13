// Unit tests for the chat-pane resize bound (clampChatRatio). The helper lives
// in index.jsx inside the `chat-bounds:begin` / `chat-bounds:end` fence as
// plain dependency-free JS, so this test extracts that exact block and runs it
// directly — no esbuild bundle, no react/pdfjs resolution (the whole-bundle
// import path is what keeps path-guards' first test red in this environment).
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

// Own scratch dir — node --test runs files in parallel processes, so a shared
// dir both sides rm -rf would race.
const root = dirname(fileURLToPath(import.meta.url))
const buildDir = join(root, '.build-chat-bounds')

async function loadChatBounds() {
  const source = readFileSync(join(root, '..', 'index.jsx'), 'utf8')
  const begin = source.indexOf('/* chat-bounds:begin')
  const end = source.indexOf('/* chat-bounds:end */')
  assert.ok(begin !== -1 && end > begin, 'chat-bounds fence found in index.jsx')
  // Strip the `export` keyword so the extracted block runs as a plain module.
  const block = source.slice(begin, end).replace('export function', 'function')
    + '\nexport { clampChatRatio }\n'
  await rm(buildDir, { recursive: true, force: true })
  await mkdir(buildDir, { recursive: true })
  const out = join(buildDir, 'chat-bounds.mjs')
  await writeFile(out, block)
  return import(pathToFileURL(out))
}

const MIN = 74 // CHAT_PANE_MIN_PX (pill 64 + divider 10) — keep in sync with index.jsx

test('clampChatRatio collapses to exactly the pill floor, never smaller', async () => {
  const { clampChatRatio } = await loadChatBounds()
  const total = 800
  // Dragging all the way down (desiredPx <= 0) floors the pane at the pill.
  assert.equal(clampChatRatio(0, total, MIN), MIN / total)
  assert.equal(clampChatRatio(-500, total, MIN), MIN / total)
  // Just below the floor still snaps up to exactly the floor.
  assert.equal(clampChatRatio(MIN - 1, total, MIN), MIN / total)
})

test('clampChatRatio caps the other end so the editor keeps a pill', async () => {
  const { clampChatRatio } = await loadChatBounds()
  const total = 800
  // Dragging all the way up (desiredPx >= total) caps the pane at total - pill.
  assert.equal(clampChatRatio(total, total, MIN), (total - MIN) / total)
  assert.equal(clampChatRatio(total + 500, total, MIN), (total - MIN) / total)
})

test('clampChatRatio passes mid-range values through unchanged', async () => {
  const { clampChatRatio } = await loadChatBounds()
  const total = 800
  assert.equal(clampChatRatio(400, total, MIN), 0.5)
  assert.equal(clampChatRatio(200, total, MIN), 0.25)
})

test('clampChatRatio falls back to 50/50 when the body cannot hold two pills', async () => {
  const { clampChatRatio } = await loadChatBounds()
  // total < 2 * MIN → no room for both floors → even split rather than clip.
  assert.equal(clampChatRatio(10, 100, MIN), 0.5)
  assert.equal(clampChatRatio(90, 100, MIN), 0.5)
  // Degenerate total → safe default.
  assert.equal(clampChatRatio(50, 0, MIN), 0.5)
  assert.equal(clampChatRatio(50, -1, MIN), 0.5)
})
