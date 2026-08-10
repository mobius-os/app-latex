import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { bundleModule } from './test-deps.mjs'

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
  await bundleModule({
    entry: join(root, '..', 'storage.js'),
    outfile: bundled,
    alias: { react: reactStub },
  })
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

test('shared JSON updates retry against the latest server version', async () => {
  const writes = []
  let reads = 0
  globalThis.window = {
    mobius: {
      online: true,
      storage: {
        async getWithVersion(path, format) {
          assert.equal(path, 'files-index.json')
          assert.equal(format, 'json')
          reads += 1
          return reads === 1
            ? { value: ['files/a.tex'], version: 'v1' }
            : { value: ['files/a.tex', 'files/agent.tex'], version: 'v2' }
        },
        async durableWrite(path, value, options) {
          writes.push({ path, value, options })
          if (writes.length === 1) {
            throw Object.assign(new Error('changed'), { code: 'conflict' })
          }
          return { synced: true }
        },
      },
    },
  }
  try {
    const { makeStorage } = await bundleStorage()
    const api = makeStorage('latex', 'tok')
    const result = await api.updateJSON('files-index.json', (current) => (
      [...new Set([...(current || []), 'files/local.tex'])].sort()
    ))
    assert.deepEqual(result.value, [
      'files/a.tex',
      'files/agent.tex',
      'files/local.tex',
    ])
    assert.deepEqual(writes.map(({ options }) => options), [
      { ifMatch: 'v1' },
      { ifMatch: 'v2' },
    ])
  } finally {
    delete globalThis.window
    await rm(buildDir, { recursive: true, force: true })
  }
})

test('recursive file listing uses the runtime mirror', async () => {
  const seen = []
  globalThis.window = {
    mobius: {
      storage: {
        async list(path) {
          seen.push(path)
          if (path === 'files/') return [
            { type: 'directory', path: 'files/chapters' },
            { type: 'file', path: 'files/main.tex' },
          ]
          if (path === 'files/chapters/') return [
            { type: 'file', path: 'files/chapters/one.tex' },
          ]
          return []
        },
      },
    },
  }
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('listFiles must stay on the runtime storage boundary')
  }
  try {
    const { makeStorage } = await bundleStorage()
    const api = makeStorage('latex', 'tok')
    assert.deepEqual(await api.listFiles('files/'), [
      'files/chapters/one.tex',
      'files/main.tex',
    ])
    assert.deepEqual(seen, ['files/', 'files/chapters/'])
  } finally {
    globalThis.fetch = oldFetch
    delete globalThis.window
    await rm(buildDir, { recursive: true, force: true })
  }
})
