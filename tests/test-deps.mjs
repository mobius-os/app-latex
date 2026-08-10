// Shared bundling harness for the suites that compile the app before asserting
// on it. Möbius compiles mini-apps with Rolldown, so the tests bundle the same
// way — the shell's frontend install is the only place the bundler lives, and
// keeping the invocation behind one helper stops each suite from re-encoding
// the compiler's options. CI points MOBIUS_FRONTEND_NODE_MODULES at that
// install; outside CI a local install resolves normally.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter as pathDelimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')

function pathEntries(value) {
  return value ? value.split(pathDelimiter).filter(Boolean) : []
}

function candidateNodeModules() {
  const candidates = [
    ...pathEntries(process.env.MOBIUS_FRONTEND_NODE_MODULES),
    ...pathEntries(process.env.NODE_PATH),
    join(appRoot, 'node_modules'),
  ]

  let dir = appRoot
  while (true) {
    candidates.push(join(dir, 'frontend', 'node_modules'))
    candidates.push(join(dir, 'platform', 'frontend', 'node_modules'))
    candidates.push(join(dir, 'mobius', 'frontend', 'node_modules'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return [...new Set(candidates.map((candidate) => resolve(candidate)))]
}

export function findFrontendNodeModules() {
  for (const candidate of candidateNodeModules()) {
    if (existsSync(join(candidate, 'rolldown'))) return candidate
  }
  throw new Error(
    'Could not find Rolldown. Run npm ci in mobius/frontend, run npm install in '
      + 'this app, or set MOBIUS_FRONTEND_NODE_MODULES.',
  )
}

export const frontendNodeModules = findFrontendNodeModules()

// Matches the RUNTIME_LIBS patterns the suites already carry: a plain entry
// matches that specifier only (hence the explicit `react/jsx-runtime` alongside
// `react`), and `*` matches any run of characters (`three/addons/*`).
function externalMatcher(patterns) {
  const exact = new Set(patterns.filter((pattern) => !pattern.includes('*')))
  const globs = patterns
    .filter((pattern) => pattern.includes('*'))
    .map((pattern) => new RegExp(
      `^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`,
    ))
  return (id) => exact.has(id) || globs.some((re) => re.test(id))
}

// Bundles `entry` to `outfile` the way the install compiler does and returns
// the output path. Callers import the result themselves, because the suites
// that stub externals must register their loader hook between the write and
// the import.
export async function bundleModule({ entry, outfile, alias = {}, external = [] }) {
  const requireFromFrontend = createRequire(join(frontendNodeModules, 'package.json'))
  const { rolldown } = await import(
    pathToFileURL(requireFromFrontend.resolve('rolldown')).href
  )
  const build = await rolldown({
    input: entry,
    platform: 'node',
    tsconfig: false,
    transform: { jsx: 'react-jsx' },
    external: externalMatcher(external),
    resolve: { alias, modules: [frontendNodeModules, 'node_modules'] },
  })
  await build.write({ file: outfile, format: 'es' })
  await build.close()
  return outfile
}

// The bundler emits `import { A, B } from "pkg"` for each external, and ESM
// checks those NAMED bindings at instantiate time — so a single empty stub
// would fail ("does not provide an export named 'Compartment'"). Parsing the
// named imports straight out of the emitted bundle keeps each synthetic stub in
// sync with whatever the app actually imports.
export function externalImportNames(bundleSource) {
  const exportsBySpec = {}
  const importRe = /import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g
  for (const m of bundleSource.matchAll(importRe)) {
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
  return serial
}
