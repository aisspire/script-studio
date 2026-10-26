import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { temp, script } from './lib.mjs'

if (process.platform !== 'win32') throw Error('Run with Windows Node and existing Windows PowerShell; only isolated fixtures are executed.')
const root = await temp('command-check-')
const compiled = path.join(root, 'command.mjs')
await writeFile(compiled, ts.transpileModule(await readFile('ui/command.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText)
const { powershellCommand } = await import(pathToFileURL(compiled))
const file = path.join(root, "中文 space ' $ ` fixture.mjs"), result = path.join(root, 'result.json')
await writeFile(file, "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))")
function execute(command) {
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'; ${command}`, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20000 })
  assert.ifError(run.error)
  assert.equal(run.status, 0, run.stderr)
}
const cases = [
  ['custom', ['a b 中文', "it's", '$env:PATH', '`tick', 'a&b', '%PATH%', 'x!y', 'C:\\space dir\\']],
  ['custom', ['', 'a"b', 'slash\\"quote', 'C:\\space dir\\']],
  ['auto', ['a b', "it's", '$value']],
]
for (const [runner, args] of cases) {
  const config = { ...script(file, 'fixture', [result, ...args]), runner }
  execute(powershellCommand(config))
  assert.deepEqual(JSON.parse(await readFile(result, 'utf8')), args)
  console.log(`PASS ${runner}: ${JSON.stringify(args)}`)
}
const psFile = path.join(root, "中文 space ' $ fixture.ps1"), psResult = path.join(root, 'ps-result.txt')
await writeFile(psFile, '\uFEFFparam([string]$OutputFile)\n[System.IO.File]::WriteAllText($OutputFile, "powershell-ok")')
execute(powershellCommand({ ...script(psFile, 'ps', [psResult]), runner: 'auto' }))
assert.equal(await readFile(psResult, 'utf8'), 'powershell-ok')
console.log('PASS auto PowerShell path with spaces, apostrophe, dollar and Chinese')
const cmdFile = path.join(root, "中文 space ' fixture.cmd"), cmdResult = path.join(root, 'cmd-result.txt')
await writeFile(cmdFile, '@echo off\r\n> "%~1" echo "%~2"\r\n')
execute(powershellCommand({ ...script(cmdFile, 'cmd', [cmdResult, 'a & b %PATH% ! (x)']), runner: 'auto' }))
assert.equal((await readFile(cmdResult, 'utf8')).trim(), '"a & b %PATH% ! (x)"')
assert.equal(powershellCommand({ ...script(cmdFile, 'bad', ['a"b']), runner: 'cmd' }), '')
assert.equal(powershellCommand({ ...script('C:\\unknown.ext', 'unknown'), runner: 'auto' }), '')
assert.equal(powershellCommand({ ...script(file, 'custom'), program: '' }), '')
console.log('PASS CMD literal arguments and unsupported configurations')
console.log(`Artifacts: ${root}`)
