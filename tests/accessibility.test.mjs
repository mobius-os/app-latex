import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const modal = readFileSync(new URL('../ui/ModalView.jsx', import.meta.url), 'utf8')
const nav = readFileSync(new URL('../ui/FileNavPanel.jsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')

test('prompt modal gives its response field an accessible name', () => {
  assert.match(modal, /aria-label=\{state\.title\}/)
  assert.match(modal, /name="modal_response"/)
})

test('closed file navigation is inert and an empty project does not expose an invalid tree', () => {
  assert.match(nav, /inert=\{!shown \? true : undefined\}/)
  assert.match(nav, /role=\{files\.length \? 'tree' : undefined\}/)
  assert.match(nav, /tabIndex=\{files\.length \? 0 : undefined\}/)
})

test('desktop source and PDF split exposes a keyboard-operable vertical separator', () => {
  assert.match(app, /aria-label="Resize source and PDF areas"/)
  assert.match(app, /aria-orientation="vertical"/)
  assert.match(app, /onKeyDown=\{handleWorkspaceResizeKey\}/)
})
