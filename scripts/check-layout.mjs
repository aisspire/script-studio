// Cross-platform numeric boundaries and isolated private-API persistence checks.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { launch, temp } from './lib.mjs'

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' })
try {
  const { defaultLayout, fitLayout, keyboardSize } = await vite.ssrLoadModule('/ui/panelLayout.ts')
  const preferred = { ...defaultLayout, sidebarWidth: 360, configWidth: 520, outputHeight: 900 }
  for (const width of [981, 1000, 1024, 1180, 1600]) {
    for (const height of [420, 480, 600, 900, 1400]) {
      const fitted = fitLayout(preferred, width, height, 64)
      assert.ok(fitted.sidebarWidth >= 160 && fitted.configWidth >= 260)
      assert.ok(fitted.sidebarWidth + fitted.configWidth + 240 <= width)
      assert.ok(fitted.outputHeight >= 110 && fitted.outputHeight + 64 + 130 <= height)
    }
  }
  assert.equal(fitLayout(preferred, 1000, 600, 64).outputHeight, 406)
  assert.deepEqual(fitLayout(preferred, 1600, 1400, 64), preferred, 'temporary viewport constraints preserve preferences')
  for (const [panel, grow, shrink, initial, minimum, maximum] of [
    ['sidebar', 'ArrowRight', 'ArrowLeft', 200, 160, 360],
    ['config', 'ArrowLeft', 'ArrowRight', 312, 260, 520],
    ['output', 'ArrowUp', 'ArrowDown', 240, 110, 406],
  ]) {
    assert.equal(keyboardSize(panel, grow, initial, minimum, maximum), initial + 8)
    assert.equal(keyboardSize(panel, shrink, initial, minimum, maximum, true), initial - 32)
    assert.equal(keyboardSize(panel, 'Home', initial, minimum, maximum), minimum)
    assert.equal(keyboardSize(panel, 'End', initial, minimum, maximum), maximum)
    assert.equal(keyboardSize(panel, grow, maximum, minimum, maximum), maximum)
    assert.equal(keyboardSize(panel, 'Tab', initial, minimum, maximum), undefined)
  }
  console.log('PASS viewport boundaries, preference restoration and keyboard directions/limits')

  const root = await temp('layout-check-'), directory = path.join(root, 'data')
  let app
  try {
    app = await launch(directory)
    const before = await app.api('snapshot')
    assert.deepEqual(await app.api('ui.layout'), defaultLayout)
    await assert.rejects(app.api('ui.layout.save', { layout: preferred }, { Authorization: '' }), /身份|来源/)
    await app.api('ui.layout.save', { layout: preferred })
    assert.equal((await app.api('snapshot')).revision, before.revision)
    await assert.rejects(app.api('ui.layout.save', { layout: { ...preferred, sidebarWidth: 900 } }), /尺寸无效/)
    assert.deepEqual(await app.api('ui.layout'), preferred)
    const origin = app.desc.origin
    await app.exit()
    app = await launch(directory)
    assert.notEqual(app.desc.instance, before.instance)
    assert.deepEqual(await app.api('ui.layout'), preferred)
    // A different data directory must not inherit this instance's preference.
    const other = await launch(path.join(root, 'other'))
    try { assert.deepEqual(await other.api('ui.layout'), defaultLayout) } finally { await other.exit() }
    const damaged = '{"version":999}'
    await writeFile(path.join(directory, 'ui-layout.json'), damaged)
    await assert.rejects(app.api('ui.layout'), /布局/)
    await assert.rejects(app.api('ui.layout.save', { layout: defaultLayout }), /布局/)
    assert.equal(await readFile(path.join(directory, 'ui-layout.json'), 'utf8'), damaged)
    assert.equal((await app.api('snapshot')).configError, null)
    console.log(`PASS authenticated layout API, restart (${origin} → ${app.desc.origin}), data isolation and damaged-file preservation`)
  } finally { await app?.exit() }
} finally { await vite.close() }
