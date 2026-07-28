import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'

// Render smoke test. The other suites bundle index.jsx only to check import
// wiring and exercise PURE exported helpers — none of them ever CALLS the
// default-exported App component, so a render-time crash (a missing import that
// throws, or a `const` read in the temporal dead zone) is invisible while the
// suite still shows all-green. This test closes that blind spot: it bundles the
// app the way the install compiler does, stubs `react` with minimally-functional
// hooks (enough to run one initial render), then invokes App({ appId, token })
// and asserts it does not throw. It catches BOTH classes at once — the original
// missing `cleanIndexPaths` import (App's index-load path referenced an
// undefined binding) and the `mainBuildError`-before-declaration TDZ.

const execFileAsync = promisify(execFile)
const root = dirname(fileURLToPath(import.meta.url))
const buildDir = join(root, '.build-render')
const bundled = join(buildDir, 'app.mjs')

// Mirror the platform's canonical RUNTIME_LIBS (backend/app/runtime_libs.py).
// The install compiler externalizes exactly this set; the test bundler must
// too, or esbuild tries to resolve bare specifiers it has no node_modules for
// and the bundle fails. Keep this list in sync with runtime_libs.py.
const RUNTIME_LIBS = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
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
  '@openai/apps-sdk-ui/components/Icon',
]

// React specifiers get real (if shallow) hook behaviour so the App body can run;
// everything else stays a self-returning Proxy that harmlessly absorbs the
// top-level runtime-lib expressions (e.g. CodeMirror's `EditorView.theme(...)`).
const REACT_SPEC = 'react'
const JSX_SPECS = new Set(['react/jsx-runtime', 'react/jsx-dev-runtime'])

async function bundleAndImport() {
  await rm(buildDir, { recursive: true, force: true })
  await mkdir(buildDir, { recursive: true })
  await execFileAsync(process.env.ESBUILD_BIN || 'esbuild', [
    join(root, '..', 'index.jsx'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--jsx=automatic',
    ...RUNTIME_LIBS.map((lib) => `--external:${lib}`),
    `--outfile=${bundled}`,
  ])

  // Discover which named/default bindings the bundle imports from each external
  // so every synthetic stub module provides exactly those exports (a missing
  // named export fails ESM instantiation with "does not provide an export
  // named X"). Same parse the path-guards suite uses.
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
  await writeFile(hook, HOOK_SOURCE.replace('__EXPORTS__', JSON.stringify(serial)))
  const { register } = await import('node:module')
  register(pathToFileURL(hook))
  return import(pathToFileURL(bundled))
}

// The loader hook, serialized to disk. Serves each externalized runtime lib as a
// synthetic module. `react` gets minimally-functional hooks; the JSX runtime
// gets element-factory no-ops; every other lib gets the self-returning Proxy.
const HOOK_SOURCE = `
const EXPORTS = __EXPORTS__
const REACT_SPEC = ${JSON.stringify(REACT_SPEC)}
const JSX_SPECS = ${JSON.stringify([...JSX_SPECS])}

// Absorbs any property access / call / construct and yields itself, so a
// top-level \`Lib.foo({...})\` in a bundled module evaluates without throwing.
const PROXY = 'const stub = new Proxy(function () {}, {'
  + ' get: (t, p) => (p === Symbol.toPrimitive || p === Symbol.iterator ? undefined : stub),'
  + ' apply: () => stub, construct: () => stub })\\n'

// Minimally-functional hooks — enough to execute a component body once (the
// initial render). useState runs a lazy initializer and returns a noop setter;
// useMemo runs its factory (React does on first render); useCallback returns the
// fn unchanged; effects never fire during render, so useEffect is a no-op.
const REACT_FN = [
  'export const useState = (init) => [typeof init === "function" ? init() : init, () => {}]',
  'export const useRef = (init) => ({ current: init === undefined ? null : init })',
  'export const useMemo = (factory) => factory()',
  'export const useCallback = (fn) => fn',
  'export const useEffect = () => {}',
  'export const useLayoutEffect = () => {}',
  'export const useId = () => "smoke-id"',
  'export const useReducer = (r, init, initFn) => [typeof initFn === "function" ? initFn(init) : init, () => {}]',
  'export const useContext = () => null',
  'export const createElement = () => ({})',
  'export const Fragment = "Fragment"',
]
const REACT_DEFINED = new Set(['useState','useRef','useMemo','useCallback','useEffect','useLayoutEffect','useId','useReducer','useContext','createElement','Fragment'])

const JSX_FN = [
  'export const jsx = () => ({})',
  'export const jsxs = () => ({})',
  'export const jsxDEV = () => ({})',
  'export const Fragment = "Fragment"',
]
const JSX_DEFINED = new Set(['jsx','jsxs','jsxDEV','Fragment'])

export async function resolve(spec, ctx, next) {
  if (Object.prototype.hasOwnProperty.call(EXPORTS, spec)) {
    return { url: 'runtime-lib-stub:' + encodeURIComponent(spec), shortCircuit: true }
  }
  return next(spec, ctx)
}

export async function load(url, ctx, next) {
  if (!url.startsWith('runtime-lib-stub:')) return next(url, ctx)
  const spec = decodeURIComponent(url.slice('runtime-lib-stub:'.length))
  const names = EXPORTS[spec] || []
  let lines
  if (spec === REACT_SPEC) {
    const extra = names.filter((n) => n !== 'default' && !REACT_DEFINED.has(n)).map((n) => 'export const ' + n + ' = stub')
    lines = [...REACT_FN, ...extra, 'export default { useState, useRef, useMemo, useCallback, useEffect, useLayoutEffect, useId, useReducer, useContext, createElement, Fragment }']
  } else if (JSX_SPECS.includes(spec)) {
    const extra = names.filter((n) => n !== 'default' && !JSX_DEFINED.has(n)).map((n) => 'export const ' + n + ' = stub')
    lines = [...JSX_FN, ...extra, 'export default {}']
  } else {
    lines = names.map((n) => (n === 'default' ? 'export default stub' : 'export const ' + n + ' = stub'))
  }
  return { format: 'module', shortCircuit: true, source: PROXY + (lines.join('\\n') || 'export {}') }
}
`

// A no-op-ish DOM/runtime surface. useEffect never fires under the react stub,
// so nothing here needs real behaviour — the App body only reads a few guarded
// globals at render time. Everything is defensive against a stray access.
function installGlobals() {
  const noop = () => {}
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  }
  // `navigator` is a getter-only global in modern Node, so plain assignment
  // throws. Node's built-in navigator has no `onLine` anyway (so useOnline's
  // `navigator.onLine !== false` already reads true); override it defensively.
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true }, configurable: true, writable: true,
    })
  } catch { /* keep Node's built-in navigator */ }
  const mobius = {
    signal: noop,
    storage: null, // absent → makeStorage falls back to fetch; render never calls it
    nav: { open: () => ({ ready: Promise.resolve(), close: noop }), close: noop },
    chat: { open: noop, close: noop },
  }
  globalThis.window = {
    mobius,
    addEventListener: noop,
    removeEventListener: noop,
    location: { origin: 'http://localhost' },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  }
  globalThis.document = {
    addEventListener: noop,
    removeEventListener: noop,
    visibilityState: 'visible',
  }
}

test('App() renders without throwing (render smoke)', async () => {
  installGlobals()
  const mod = await bundleAndImport()
  const App = mod.default
  assert.equal(typeof App, 'function', 'index.jsx must default-export the App component')

  // The whole point: invoking App runs the component body top-to-bottom. A
  // missing import or a const read before its declaration throws HERE, where the
  // pure-helper suites never look. A clean return proves the render path holds.
  let rendered
  assert.doesNotThrow(() => {
    rendered = App({ appId: 1, token: 'smoke-token' })
  }, 'App() threw during initial render')
  assert.ok(rendered !== undefined && rendered !== null, 'App() returned nothing')
})
