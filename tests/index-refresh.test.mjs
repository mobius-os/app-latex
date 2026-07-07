import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { cleanIndexPaths } from '../domain.js'

const root = dirname(fileURLToPath(import.meta.url))

test('refreshFiles has the cleanIndexPaths helper used for seeded indexes', () => {
  const source = readFileSync(join(root, '..', 'index.jsx'), 'utf8')
  assert.match(source, /cleanIndexPaths,/)
  assert.match(source, /const cleaned = cleanIndexPaths\(idx\)/)
  assert.deepEqual(cleanIndexPaths(['files/welcome.tex']), ['files/welcome.tex'])
})
