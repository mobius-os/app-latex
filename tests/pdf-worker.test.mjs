import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PDF_WORKER_PATH,
  configurePdfJsWorker,
  resolvePdfWorkerUrl,
} from '../pdf/worker.js'

test('resolves the PDF worker to an absolute URL from a sandbox frame route', () => {
  assert.equal(
    resolvePdfWorkerUrl('https://mobius.example/api/apps/63/frame?v=build-1'),
    `https://mobius.example${PDF_WORKER_PATH}`,
  )
})

test('keeps non-default deployment ports in the absolute worker URL', () => {
  assert.equal(
    resolvePdfWorkerUrl('http://localhost:8000/api/apps/63/frame'),
    `http://localhost:8000${PDF_WORKER_PATH}`,
  )
})

test('configures PDF.js with an absolute worker URL for its fallback import', () => {
  const pdfjs = { GlobalWorkerOptions: { workerSrc: '' } }
  assert.equal(
    configurePdfJsWorker(pdfjs, 'https://mobius.example/apps/latex/'),
    pdfjs,
  )
  assert.equal(
    pdfjs.GlobalWorkerOptions.workerSrc,
    `https://mobius.example${PDF_WORKER_PATH}`,
  )
})

test('rejects non-network bases that would recreate the blob-resolution bug', () => {
  assert.throws(
    () => resolvePdfWorkerUrl('blob:https://mobius.example/build-id'),
    /Could not resolve the PDF worker from this app frame/,
  )
})

test('fails clearly when the imported PDF.js module has no worker options', () => {
  assert.throws(
    () => configurePdfJsWorker({}, 'https://mobius.example/app/63'),
    /worker options are unavailable/,
  )
})
