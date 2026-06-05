import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const root = dirname(fileURLToPath(import.meta.url))
const buildDir = join(root, '.build')
const bundled = join(buildDir, 'index.mjs')

async function bundle() {
  await rm(buildDir, { recursive: true, force: true })
  await mkdir(buildDir, { recursive: true })
  await execFileAsync('/home/hmzmrzx/projects/mobius/frontend/node_modules/.bin/esbuild', [
    join(root, '..', 'index.jsx'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--jsx=automatic',
    '--external:pdfjs-dist',
    `--outfile=${bundled}`,
  ])
  return import(pathToFileURL(bundled))
}

test('path guards accept only safe paths inside files/', async () => {
  const {
    isSafeRelPath,
    isSafeStoragePath,
    normalizeFileCacheSnapshot,
    pdfFromBuildStatusForDoc,
    pdfPathForTexDoc,
  } = await bundle()

  assert.equal(isSafeRelPath('chapter1.tex'), true)
  assert.equal(isSafeRelPath('notes/2026/draft.md'), true)
  assert.equal(isSafeRelPath('folder/.keep'), true)

  assert.equal(isSafeRelPath('../secret.tex'), false)
  assert.equal(isSafeRelPath('notes/../secret.tex'), false)
  assert.equal(isSafeRelPath('/absolute.tex'), false)
  assert.equal(isSafeRelPath('notes//draft.tex'), false)
  assert.equal(isSafeRelPath('notes\\draft.tex'), false)
  assert.equal(isSafeRelPath('draft with spaces.tex'), false)

  assert.equal(isSafeStoragePath('files/chapter1.tex'), true)
  assert.equal(isSafeStoragePath('files/notes/2026/draft.md'), true)
  assert.equal(isSafeStoragePath('build/status.json'), false)
  assert.equal(isSafeStoragePath('files/../secret.tex'), false)
  assert.equal(isSafeStoragePath('files/notes/../../secret.tex'), false)

  const snapshot = normalizeFileCacheSnapshot({
    index: [
      'files/z.tex',
      'files/a.tex',
      'files/../secret.tex',
      'build/status.json',
      'files/a.tex',
    ],
    contents: {
      'files/a.tex': 'a',
      'files/z.tex': 'z',
      'files/../secret.tex': 'secret',
      'files/orphan.tex': 'orphan',
    },
    lastPath: 'files/../secret.tex',
  })
  assert.deepEqual(snapshot.index, ['files/a.tex', 'files/z.tex'])
  assert.deepEqual(snapshot.contents, { 'files/a.tex': 'a', 'files/z.tex': 'z' })
  assert.equal(snapshot.lastPath, null)

  assert.equal(pdfPathForTexDoc('files/main.tex'), 'files/main.pdf')
  assert.equal(pdfPathForTexDoc('files/chapters/one.tex'), 'files/chapters/one.pdf')
  assert.equal(pdfPathForTexDoc('files/main.md'), null)
  assert.equal(pdfPathForTexDoc('build/target.tex'), null)

  assert.equal(
    pdfFromBuildStatusForDoc({
      status: 'done',
      target: 'files/main.tex',
      pdf: 'files/main.pdf',
    }, 'files/main.tex'),
    'files/main.pdf',
  )
  assert.equal(
    pdfFromBuildStatusForDoc({
      status: 'done',
      target: 'files/other.tex',
      pdf: 'files/other.pdf',
    }, 'files/main.tex'),
    null,
  )
  assert.equal(
    pdfFromBuildStatusForDoc({
      status: 'done',
      pdf: 'files/main.pdf',
    }, 'files/main.tex'),
    'files/main.pdf',
  )
  assert.equal(
    pdfFromBuildStatusForDoc({
      status: 'error',
      target: 'files/main.tex',
      pdf: 'files/main.pdf',
    }, 'files/main.tex'),
    null,
  )
  assert.equal(
    pdfFromBuildStatusForDoc({
      status: 'done',
      target: 'files/main.tex',
      pdf: 'build/main.pdf',
    }, 'files/main.tex'),
    null,
  )
})

test('file tree keeps an accessible composite keyboard contract', () => {
  const source = readFileSync(join(root, '..', 'index.jsx'), 'utf8')

  assert.match(source, /role="tree"/)
  assert.match(source, /role="treeitem"/)
  assert.match(source, /role="group"/)
  assert.match(source, /tabIndex=\{0\}/)
  assert.match(source, /tabIndex=\{-1\}/)
  assert.match(source, /data-tree-path=/)
  assert.match(source, /data-parent-path=/)
  assert.match(source, /focusSelectedOrFirst/)
  assert.match(source, /returnFocusRef/)
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft']) {
    assert.match(source, new RegExp(`event\\.key === '${key}'|e\\.key === '${key}'`))
  }
})
