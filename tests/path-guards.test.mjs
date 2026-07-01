import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
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

// Mirror the platform's canonical RUNTIME_LIBS (backend/app/runtime_libs.py).
// The install compiler externalizes exactly this set; the test bundler must
// too, or esbuild tries to resolve bare specifiers (react, @codemirror/*, etc.)
// it has no node_modules for and the bundle fails — masking the path guards we
// actually want to assert on. Keep this list in sync with runtime_libs.py.
const RUNTIME_LIBS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'recharts',
  'date-fns',
  'three',
  'three/addons/*',
  'pdfjs-dist',
  'codemirror',
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/lang-markdown',
  '@lezer/highlight',
  'katex',
]

async function bundle() {
  await rm(buildDir, { recursive: true, force: true })
  await mkdir(buildDir, { recursive: true })
  // Faithfully mirror the install compiler: externalize EXACTLY the canonical
  // RUNTIME_LIBS (backend/app/runtime_libs.py). esbuild then leaves those bare
  // imports unresolved in the bundle instead of choking on a missing package.
  await execFileAsync('/home/hmzmrzx/projects/mobius/frontend/node_modules/.bin/esbuild', [
    join(root, '..', 'index.jsx'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--jsx=automatic',
    ...RUNTIME_LIBS.map((lib) => `--external:${lib}`),
    `--outfile=${bundled}`,
  ])
  // The path-guard exports under test are pure — they never touch react,
  // @codemirror/*, pdfjs-dist, etc., so those packages need not be installed.
  // esbuild emits 'import { A, B } from "pkg"' for each external, and ESM checks
  // those NAMED bindings at instantiate time — so a single empty stub would fail
  // ("does not provide an export named 'Compartment'"). We parse the named
  // imports straight out of the emitted bundle and register a loader hook that
  // serves each RUNTIME_LIB specifier as a synthetic module exporting exactly
  // those names, so the stub stays in sync with whatever index.jsx imports.
  const bundleSrc = readFileSync(bundled, 'utf8')
  const exportsBySpec = {}
  const importRe = /import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g
  for (const m of bundleSrc.matchAll(importRe)) {
    const [, dflt, named, spec] = m
    const set = (exportsBySpec[spec] ||= new Set())
    if (dflt) set.add('default')
    if (named) {
      for (const piece of named.split(',')) {
        const name = piece.trim().split(/\s+as\s+/).pop().trim()
        if (name) set.add(name)
      }
    }
  }
  const serial = {}
  for (const [spec, names] of Object.entries(exportsBySpec)) serial[spec] = [...names]
  const hook = join(buildDir, 'runtime-lib-hook.mjs')
  // Each stub member must be callable AND chainable: index.jsx runs CodeMirror
  // calls at MODULE TOP LEVEL (e.g. `const t = EditorView.theme({...})`,
  // `keymap.of([...])`), which execute the moment we import the bundle. A plain
  // {} would throw "EditorView.theme is not a function". A self-returning
  // callable Proxy absorbs any property access or call and yields itself, so
  // every top-level runtime-lib expression evaluates harmlessly. The pure
  // path-guard exports we actually test never read those values.
  const stubHeader =
    'const stub = new Proxy(function () {}, {' +
    ' get: (t, prop) => (prop === Symbol.toPrimitive || prop === Symbol.iterator ? undefined : stub),' +
    ' apply: () => stub, construct: () => stub })\n'
  await writeFile(hook, [
    'const EXPORTS = ' + JSON.stringify(serial),
    'const STUB_HEADER = ' + JSON.stringify(stubHeader),
    'export async function resolve(spec, ctx, next) {',
    "  if (Object.prototype.hasOwnProperty.call(EXPORTS, spec)) return { url: 'runtime-lib-stub:' + encodeURIComponent(spec), shortCircuit: true }",
    '  return next(spec, ctx)',
    '}',
    'export async function load(url, ctx, next) {',
    "  if (url.startsWith('runtime-lib-stub:')) {",
    "    const spec = decodeURIComponent(url.slice('runtime-lib-stub:'.length))",
    '    const names = EXPORTS[spec] || []',
    "    const lines = names.map((n) => (n === 'default' ? 'export default stub' : 'export const ' + n + ' = stub'))",
    "    return { format: 'module', shortCircuit: true, source: STUB_HEADER + (lines.join('\\n') || 'export {}') }",
    '  }',
    '  return next(url, ctx)',
    '}',
  ].join('\n') + '\n')
  const { register } = await import('node:module')
  register(pathToFileURL(hook))
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
  const source = [
    readFileSync(join(root, '..', 'index.jsx'), 'utf8'),
    readFileSync(join(root, '..', 'ui', 'FileNavPanel.jsx'), 'utf8'),
    readFileSync(join(root, '..', 'ui', 'FileNode.jsx'), 'utf8'),
  ].join('\n')

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
