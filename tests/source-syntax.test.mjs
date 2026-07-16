import test from 'node:test'
import assert from 'node:assert/strict'

import { sourceKind, sourceTokens } from '../source-syntax.js'

test('recognises LaTeX source and highlights commands, math, comments, and numbers', () => {
  assert.equal(sourceKind('files/main.tex'), 'tex')
  const tokens = sourceTokens('files/main.tex', '\\section{Hello} $x + 2$ % note')
  assert.deepEqual(tokens.map((token) => token.className), [
    'cm-syn-command', 'cm-syn-string', 'cm-syn-comment',
  ])
})

test('leaves unknown files unstyled', () => {
  assert.deepEqual(sourceTokens('files/image.bin', 'const value = 2'), [])
})
