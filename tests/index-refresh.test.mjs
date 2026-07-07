import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { cleanIndexPaths } from '../domain.js'

const root = dirname(fileURLToPath(import.meta.url))

// `refreshFiles()` turns the raw files-index.json array the server returns into
// the list the tree renders by running it through `cleanIndexPaths`. This tests
// that transform's actual behaviour (dedup + sort + drop-unsafe) instead of
// grepping the component source for the call site, so it stays green across a
// harmless rename and would catch a real behavioural regression in the cleaner.
test('cleanIndexPaths dedups, sorts, and drops unsafe entries from a raw index', () => {
  // The seeded happy path is a no-op.
  assert.deepEqual(cleanIndexPaths(['files/welcome.tex']), ['files/welcome.tex'])

  // A messy real-world index: out of order, duplicated, plus entries a build
  // could leave behind (managed json, a traversal attempt, a bare build path).
  const raw = [
    'files/z.tex',
    'files/a.tex',
    'files/a.tex', // duplicate
    'files/notes/intro.md',
    'files/../secret.tex', // path traversal — must be dropped
    'build/status.json', // managed build artifact, not a project file
    'files-index.json', // the index itself, not a listed file
  ]
  assert.deepEqual(cleanIndexPaths(raw), [
    'files/a.tex',
    'files/notes/intro.md',
    'files/z.tex',
  ])

  // Degenerate inputs never throw — refreshFiles hands whatever the server gave.
  assert.deepEqual(cleanIndexPaths(null), [])
  assert.deepEqual(cleanIndexPaths(undefined), [])
  assert.deepEqual(cleanIndexPaths([]), [])
})

// The original P0 high was a domain.js helper (cleanIndexPaths) that index.jsx
// USED but forgot to IMPORT, so the reference threw a ReferenceError deep inside
// a callback the render-smoke never reaches. This guards that whole class: every
// domain.js helper index.jsx actually calls must appear in its domain.js import
// list. It derives the names from domain.js's real exports (rename-safe) rather
// than asserting one magic call-site string.
test('index.jsx imports every domain.js helper it calls', () => {
  const domainSrc = readFileSync(join(root, '..', 'domain.js'), 'utf8')
  const indexSrc = readFileSync(join(root, '..', 'index.jsx'), 'utf8')

  const domainExports = [...domainSrc.matchAll(/^export function ([A-Za-z0-9_]+)/gm)].map((m) => m[1])

  const importMatch = indexSrc.match(/import\s*\{([^}]*)\}\s*from\s*["']\.\/domain\.js["']/)
  assert.ok(importMatch, 'index.jsx must import from ./domain.js')
  const imported = new Set(
    importMatch[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean),
  )

  // Ignore the import statement itself so it doesn't count as a "call".
  const body = indexSrc.replace(importMatch[0], '')
  const called = domainExports.filter(
    (name) => new RegExp(`(^|[^\\w.])${name}\\s*\\(`).test(body),
  )

  const missing = called.filter((name) => !imported.has(name))
  assert.deepEqual(missing, [], `called but not imported from domain.js: ${missing.join(', ')}`)
})
