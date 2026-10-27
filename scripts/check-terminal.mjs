import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { binary, launch, save, script, temp, until } from './lib.mjs'

if (process.platform !== 'win32') throw Error('Run with existing Windows Node and PowerShell; no tools are installed.')
const root = await temp('terminal-check-')
const fixtures = path.join(root, "中文 terminal & ' % !")
await mkdir(fixtures)
const file = path.join(fixtures, 'fixture.mjs'), marker = path.join(fixtures, 'result.json')
await writeFile(file, `import fs from 'node:fs';
fs.writeFileSync(process.argv[2], JSON.stringify({args:process.argv.slice(3),cwd:process.cwd(),env:process.env.SCRIPT_STUDIO_FIXTURE,snapshot:process.env.SCRIPT_STUDIO_TERMINAL_SNAPSHOT,pid:process.pid,helper:process.ppid,input:!!process.stdin.isTTY,output:!!process.stdout.isTTY}));
if(process.argv.includes('wait')) setInterval(()=>{},1000);
else process.exit(7);
`)
const relocated = path.join(fixtures, 'Script Studio.exe')
await copyFile(binary(), relocated)
const app = await launch(path.join(root, 'data'), { bin: relocated })
const terminals = new Set(), children = new Set()
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
function parent(pid) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}').ParentProcessId`], { encoding: 'utf8', timeout: 20000 })
  assert.equal(result.status, 0, result.stderr)
  return Number(result.stdout.trim())
}
try {
  const args = ['a b', '"quoted"', '', "中文 &|<>%!^'$()", 'C:\\path with spaces\\', 'wait']
  const config = { ...script(file, '终端测试', [marker, ...args]), cwd: fixtures, env: { SCRIPT_STUDIO_FIXTURE: 'saved value 中文' }, interpreterArgs: ['--no-warnings'] }
  await save(app, c => c.scripts.push(config))
  const before = (await app.api('snapshot')).runs
  await assert.rejects(app.api('run.terminal', { scriptId: crypto.randomUUID() }), /不存在/)
  assert.equal((await app.api('run.terminal', { scriptId: config.id })).opened, true)
  const result = await until(async () => JSON.parse(await readFile(marker, 'utf8')), 'external terminal fixture')
  children.add(result.pid); children.add(result.helper)
  const terminal = parent(result.helper); assert.ok(terminal > 0); terminals.add(terminal)
  assert.deepEqual(result.args, args)
  assert.equal(path.resolve(result.cwd), path.resolve(fixtures))
  assert.equal(result.env, 'saved value 中文')
  assert.equal(result.snapshot, undefined, 'launch snapshot must not leak to the script')
  assert.equal(result.input, true, 'script gets external console stdin')
  assert.equal(result.output, true, 'output goes to external console')
  assert.deepEqual((await app.api('snapshot')).runs, before, 'external launch does not create managed history')
  assert.equal((await app.api('status')).activeRuns, 0)
  console.log('PASS external console uses literal argv, saved cwd/env, isolated stdio and unmanaged history')

  // Exercise the same helper without a console to inspect its output/exit code.
  const helper = spawnSync(binary(), ['terminal-run'], { env: { ...process.env, SCRIPT_STUDIO_TERMINAL_SNAPSHOT: JSON.stringify({ ...config, args: [path.join(root, 'helper.json'), ...args.slice(0, -1)] }) }, encoding: 'utf8', timeout: 20000 })
  assert.equal(helper.status, 7, helper.stderr)
  assert.match(helper.stdout, /退出码 7/)
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'helper.json'), 'utf8')).args, args.slice(0, -1))
  console.log('PASS terminal helper preserves nonzero exit code and prints completion status')

  const missing = { ...script(path.join(root, 'missing.mjs'), '缺少脚本') }
  await save(app, c => c.scripts.push(missing))
  await assert.rejects(app.api('run.terminal', { scriptId: missing.id }), /不存在/)
  const managed = await app.api('run.start', { scriptId: config.id })
  await assert.rejects(app.api('run.terminal', { scriptId: config.id }), /已经在运行/)
  await app.api('run.stop', { runId: managed.runId })
  await writeFile(path.join(root, 'data/config.json'), 'broken')
  await app.api('reload')
  await assert.rejects(app.api('run.terminal', { scriptId: config.id }), /修复配置/)
  console.log('PASS invalid paths, active managed run and unreadable configuration reject terminal launch')

  await app.exit()
  assert.equal(alive(result.pid), true)
  assert.equal(alive(terminal), true)
  process.kill(result.pid)
  await until(() => !alive(result.helper), 'terminal helper exits after script')
  assert.equal(alive(terminal), true, 'PowerShell stays open after the script ends')
  console.log('PASS external script survives backend shutdown and terminal remains open after completion')
} finally {
  await app.exit()
  for (const pid of [...children, ...terminals]) { try { process.kill(pid) } catch {} }
}
console.log(`Terminal verification artifacts: ${root}`)
