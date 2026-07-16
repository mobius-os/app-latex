import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const root = dirname(fileURLToPath(import.meta.url))
const buildDir = join(root, '.build-offline-storage')

async function bundleStorage() {
  await rm(buildDir, { recursive: true, force: true })
  await mkdir(buildDir, { recursive: true })
  const reactStub = join(buildDir, 'react-stub.mjs')
  const bundled = join(buildDir, 'storage.mjs')
  await writeFile(reactStub, [
    'export const useEffect = () => {}',
    'export const useState = (initial) => [typeof initial === "function" ? initial() : initial, () => {}]',
  ].join('\n'))
  await execFileAsync(process.env.ESBUILD_BIN || 'esbuild', [
    join(root, '..', 'storage.js'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--alias:react=${reactStub}`,
    `--outfile=${bundled}`,
  ])
  return import(`${pathToFileURL(bundled)}?v=${Date.now()}`)
}

test('offline manifest is implemented by typed Mobius storage operations', async () => {
  const manifest = JSON.parse(readFileSync(join(root, '..', 'mobius.json'), 'utf8'))
  assert.equal(manifest.offline_capable, true)
  assert.deepEqual(
    { reads: manifest.offline.reads, writes: manifest.offline.writes, execution: manifest.offline.execution },
    { reads: true, writes: 'queued', execution: 'none' },
  )

  const calls = []
  const storage = {
    get: async (path) => (calls.push(['get', path]), { cached: true }),
    getText: async (path) => (calls.push(['getText', path]), 'cached text'),
    getBlob: async (path) => (calls.push(['getBlob', path]), new Blob(['cached'])),
    getBlobFresh: async (path) => (calls.push(['getBlobFresh', path]), new Blob(['fresh'])),
    setText: async (path, value) => (calls.push(['setText', path, value]), { queued: true }),
    setBlob: async (path) => (calls.push(['setBlob', path]), { queued: true }),
    set: async (path, value) => (calls.push(['set', path, value]), { queued: true }),
    remove: async (path) => (calls.push(['remove', path]), { queued: true }),
    list: async (path) => (calls.push(['list', path]), []),
    subscribeText: (path) => (calls.push(['subscribeText', path]), () => {}),
    pendingCount: async () => 4,
  }
  const oldFetch = globalThis.fetch
  globalThis.window = { mobius: { storage } }
  globalThis.fetch = async () => {
    throw new Error('typed offline operations must not bypass the Mobius runtime')
  }
  try {
    const { makeStorage } = await bundleStorage()
    const api = makeStorage('latex', 'tok')
    assert.equal(api.hasRuntime, true)
    assert.deepEqual(await api.get('settings.json'), { cached: true })
    assert.equal(await api.get('files/paper.tex'), 'cached text')
    await api.getBlob('files/figure.png')
    await api.getBlobFresh('files/paper.pdf')
    assert.deepEqual(await api.setText('files/paper.tex', 'draft'), { queued: true })
    assert.deepEqual(await api.setBlob('files/figure.png', new Blob(['x'])), { queued: true })
    assert.deepEqual(await api.setJSON('files-index.json', []), { queued: true })
    assert.deepEqual(await api.remove('files/old.tex'), { queued: true })
    assert.deepEqual(await api.list('files/'), [])
    api.subscribeText('files/paper.tex', () => {})()
    assert.equal(await api.pendingCount(), 4)
    assert.deepEqual(calls.map(([method, path]) => [method, path]), [
      ['get', 'settings.json'],
      ['getText', 'files/paper.tex'],
      ['getBlob', 'files/figure.png'],
      ['getBlobFresh', 'files/paper.pdf'],
      ['setText', 'files/paper.tex'],
      ['setBlob', 'files/figure.png'],
      ['set', 'files-index.json'],
      ['remove', 'files/old.tex'],
      ['list', 'files/'],
      ['subscribeText', 'files/paper.tex'],
    ])
  } finally {
    globalThis.fetch = oldFetch
    delete globalThis.window
    await rm(buildDir, { recursive: true, force: true })
  }
})
