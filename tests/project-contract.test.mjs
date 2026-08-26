import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const manifest = JSON.parse(read('mobius.json'))
const source = read('index.jsx')
const builder = read('project-builder.sh')
const guidance = read('latex-project.md')

test('LaTeX declares one first-class document project contract', () => {
  assert.equal(manifest.version, '3.0.0')
  assert.equal(manifest.embeds_agent, false)
  assert.deepEqual(manifest.source_files, [
    'latex-project.md',
    'project-builder.sh',
    'templates/main.tex',
  ])
  assert.deepEqual(manifest.offline, {
    reads: true,
    writes: 'none',
    execution: 'none',
  })
  assert.equal(manifest.project_templates.length, 1)
  const template = manifest.project_templates[0]
  assert.equal(template.id, 'document')
  assert.equal(template.files['main.tex'], 'templates/main.tex')
  assert.equal(template.previews[0].kind, 'pdf')
  assert.equal(template.artifact_types[0].script, 'project-builder.sh')
  assert.equal(template.artifact_types[0].output, '{stem}.pdf')
})

test('the launcher delegates workspace ownership to Projects', () => {
  assert.match(source, /const TEMPLATE_ID = 'latex:document'/)
  assert.match(source, /window\.mobius\?\.projects/)
  for (const operation of ['migrate', 'list', 'create', 'open', 'browse']) {
    assert.match(source, new RegExp(`projectApi\\??\\.${operation}`))
  }
  assert.doesNotMatch(source, /mobius\?\.storage|mobius\.chat|localStorage/)
  assert.match(source, /min-height:\s*44px/)
  assert.match(source, /:focus-visible/)
})

test('the PDF builder and agent guidance stay project-scoped', () => {
  for (const name of ['PROJECT_ROOT', 'PROJECT_SOURCE', 'PROJECT_OUTPUT_DIR']) {
    assert.match(builder, new RegExp(`\\$\\{${name}:\\?`))
  }
  assert.match(builder, /cd "\$PROJECT_ROOT"/)
  assert.match(builder, /tectonic "\$PROJECT_SOURCE" --outdir "\$PROJECT_OUTPUT_DIR"/)
  assert.match(guidance, /Edit source files directly under `\$PROJECT_ROOT`/)
  assert.match(guidance, /Never delete or replace unrelated Project files/)
})
