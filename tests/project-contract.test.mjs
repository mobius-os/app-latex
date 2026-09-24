import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const manifest = JSON.parse(read('mobius.json'))
const source = read('index.jsx')
const builder = read('project-builder.sh')
const guidance = read('latex-project.md')

test('LaTeX declares one first-class document project contract', () => {
  assert.equal(manifest.version, '3.0.2')
  assert.equal(manifest.embeds_agent, false)
  assert.deepEqual(manifest.source_files, [
    'latex-project.md',
    'project-builder.sh',
    'templates/main.tex',
    'latest-request.js',
  ])
  assert.equal(manifest.offline_capable, false)
  assert.deepEqual(manifest.offline, {
    reads: false,
    writes: 'none',
    execution: 'none',
  })
  assert.equal(manifest.project_templates.length, 1)
  const template = manifest.project_templates[0]
  assert.equal(template.id, 'document')
  assert.equal(template.files['main.tex'], 'templates/main.tex')
  assert.deepEqual(template.previews[0], {
    id: 'document', name: 'Document', source: 'main.tex', builder: 'latex',
  })
  assert.equal(template.artifact_types[0].script, 'project-builder.sh')
  assert.equal(template.artifact_types[0].output, '{stem}.pdf')
})

test('the launcher delegates workspace ownership to Projects', () => {
  assert.match(source, /const LOCAL_TEMPLATE_ID = 'document'/)
  assert.match(source, /window\.mobius\?\.projects/)
  for (const operation of ['templates', 'list', 'create', 'open', 'browse']) {
    assert.match(source, new RegExp(`projectApi\\??\\.${operation}`))
  }
  assert.doesNotMatch(source, /projectApi\??\.migrate/)
  assert.doesNotMatch(source, /mobius\?\.storage|mobius\.chat|localStorage/)
  assert.doesNotMatch(source, /const project = await projectApi\.create/)
  assert.match(source, /onOnlineChange/)
  assert.match(source, /retry when you reconnect/)
  assert.match(source, /--project-row-accent/)
  assert.match(source, /min-height:\s*44px/)
  assert.match(source, /:focus-visible/)
})

test('the PDF builder stays project-scoped while guidance supports standalone Pages', () => {
  for (const name of ['PROJECT_ROOT', 'PROJECT_SOURCE', 'PROJECT_OUTPUT_DIR']) {
    assert.match(builder, new RegExp(`\\$\\{${name}:\\?`))
  }
  assert.match(builder, /cd "\$PROJECT_ROOT"/)
  assert.match(builder, /tectonic "\$PROJECT_SOURCE" --outdir "\$PROJECT_OUTPUT_DIR"/)
  assert.match(guidance, /Edit source files directly under `\$PROJECT_ROOT`/)
  assert.match(guidance, /Never delete or replace unrelated Project files/)
  assert.match(guidance, /When there is no `\$PROJECT_ROOT`/)
  assert.match(guidance, /"template_id": "latex:document"/)
  assert.match(guidance, /Add to Projects/)
})
