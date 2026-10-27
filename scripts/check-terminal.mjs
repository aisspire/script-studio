import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { binary, launch, save, script, temp, until } from './lib.mjs'

if (process.platform !== 'win32') throw Error('Run with existing Windows Node and PowerShell; no tools are installed.')
const root = await temp('terminal-check-')
const fixtures = path.join(root, "中文 terminal & ' % !"), installed = path.join(root, 'plugin installation')
await mkdir(fixtures)
const file = path.join(fixtures, 'fixture.mjs')
await writeFile(file, `import fs from 'node:fs';
const marker=process.argv[2];
fs.writeFileSync(marker,JSON.stringify({args:process.argv.slice(3),cwd:process.cwd(),env:process.env.SCRIPT_STUDIO_FIXTURE,snapshot:process.env.SCRIPT_STUDIO_TERMINAL_SNAPSHOT,pid:process.pid,parent:process.ppid,input:!!process.stdin.isTTY,output:!!process.stdout.isTTY}));
process.stdout.write('FIXTURE_STARTED\\n');
if(process.argv.includes('wait'))setInterval(()=>{fs.writeFileSync(marker+'.beat',String(Date.now()));if(fs.existsSync(marker+'.release'))process.exit(7)},100);
else if(process.argv.includes('input'))process.stdin.once('data',data=>{fs.writeFileSync(marker+'.input',data.toString().trim());process.exit(0)});
else process.exit(7);
`)
const bootstrap = await readFile('src/terminal-bootstrap.ps1', 'utf8')
const probe = path.join(root, 'console-probe.ps1')
// Attach only to consoles created by this test. No foreground focus or global
// keyboard input is used; Ctrl+C cannot reach a user's existing terminal.
await writeFile(probe, `param([int]$Target,[string]$Action,[string]$OutputFile,[string]$Text)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ConsoleProbe {
 [StructLayout(LayoutKind.Sequential)] public struct Coord { public short X,Y; }
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public short L,T,R,B; }
 [StructLayout(LayoutKind.Sequential)] public struct Info { public Coord Size,Cursor; public short Attributes; public Rect Window; public Coord Max; }
 [StructLayout(LayoutKind.Explicit,Size=20)] public struct Input {
  [FieldOffset(0)] public short Type; [FieldOffset(4)] public int Down;
  [FieldOffset(8)] public short Repeat; [FieldOffset(10)] public short VirtualKey;
  [FieldOffset(14)] public char Character;
 }
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FreeConsole();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AttachConsole(uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetConsoleCtrlHandler(IntPtr handler,bool add);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint type,uint group);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetConsoleScreenBufferInfo(IntPtr handle,out Info info);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ReadConsoleOutputCharacterW(IntPtr handle,StringBuilder text,uint count,Coord at,out uint read);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool WriteConsoleInputW(IntPtr handle,Input[] input,uint count,out uint written);
 static void Check(bool result) { if(!result)throw new Win32Exception(Marshal.GetLastWin32Error()); }
 public static string Run(int pid,string action,string text) {
  FreeConsole(); Check(AttachConsole((uint)pid));
  IntPtr handle=new IntPtr(-1);
  try {
   Check(SetConsoleCtrlHandler(IntPtr.Zero,true));
   if(action=="ctrlc") { Check(GenerateConsoleCtrlEvent(0,0)); System.Threading.Thread.Sleep(150); return "sent"; }
   handle=CreateFileW(action=="input"?"CONIN$":"CONOUT$",0xC0000000,3,IntPtr.Zero,3,0,IntPtr.Zero);
   if(handle==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());
   uint count;
   if(action=="input") {
    var input=new Input[text.Length*2];
    for(int i=0;i<text.Length;i++) {
     input[i*2]=new Input {Type=1,Down=1,Repeat=1,VirtualKey=(short)(text[i]=='\\r'?13:0),Character=text[i]};
     input[i*2+1]=input[i*2];input[i*2+1].Down=0;
    }
    Check(WriteConsoleInputW(handle,input,(uint)input.Length,out count)); return "sent";
   }
   Info info;Check(GetConsoleScreenBufferInfo(handle,out info));
   int length=Math.Min((int)info.Size.X*info.Size.Y,131072);
   var output=new StringBuilder(length);
   Check(ReadConsoleOutputCharacterW(handle,output,(uint)length,new Coord(),out count));return output.ToString();
  } finally { if(handle!=new IntPtr(-1))CloseHandle(handle); FreeConsole(); }
 }
}
'@
[IO.File]::WriteAllText($OutputFile,[ConsoleProbe]::Run($Target,$Action,$Text))
`)
let probeSequence = 0
async function consoleAction(pid, action = 'read', text = '') {
  assert.ok(terminals.has(pid), 'only a fixture console may be accessed')
  const output = path.join(root, `console-${probeSequence++}.txt`)
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe, '-Target', String(pid), '-Action', action, '-OutputFile', output, '-Text', text], { encoding: 'utf8', timeout: 20000 })
  assert.ifError(run.error); assert.equal(run.status, 0, run.stderr)
  return readFile(output, 'utf8')
}
function processInfo(pid) {
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}' | Select-Object ProcessId,ParentProcessId,Name,CreationDate | ConvertTo-Json -Compress`], { encoding: 'utf8', timeout: 20000 })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout.trim() ? JSON.parse(run.stdout) : null
}
const terminals = new Map(), children = new Map(), backends = []
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
function recordTerminals() {
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${Number(app.proc.pid)} AND Name = "powershell.exe"' | Select-Object ProcessId,CreationDate) | ConvertTo-Json -Compress`], { encoding: 'utf8', timeout: 20000 })
  assert.equal(run.status, 0, run.stderr)
  const found = run.stdout.trim() ? JSON.parse(run.stdout) : []
  for (const terminal of Array.isArray(found) ? found : [found]) terminals.set(terminal.ProcessId, terminal.CreationDate)
}
async function stage(directory) {
  await mkdir(directory, { recursive: true })
  await copyFile(binary(), path.join(directory, 'script-studio.exe'))
  await cp('dist', path.join(directory, 'dist'), { recursive: true })
  for (const file of ['plugin.json', 'oriel.ps1', 'USER_GUIDE.md', 'Open-ScriptStudio.cmd']) await copyFile(file, path.join(directory, file))
}
await stage(installed)
let app = await launch(path.join(root, 'data'), { bin: path.join(installed, 'script-studio.exe'), env: { SCRIPT_STUDIO_UI_DIR: '' } })
backends.push(app)
async function open(config, marker) {
  await save(app, c => c.scripts.push(config))
  assert.equal((await app.api('run.terminal', { scriptId: config.id })).opened, true)
  recordTerminals()
  const result = await until(async () => JSON.parse(await readFile(marker, 'utf8')), 'external terminal fixture')
  const terminal = processInfo(result.parent)
  assert.equal(terminal?.Name.toLowerCase(), 'powershell.exe', 'target is directly parented by PowerShell, with no Script Studio helper')
  terminals.set(result.parent, terminal.CreationDate)
  const child = processInfo(result.pid)
  if (child) children.set(result.pid, child.CreationDate)
  return { ...result, terminal: result.parent, marker }
}
async function finished(result, code = 7) {
  await until(() => !alive(result.pid), 'fixture completion')
  await until(async () => (await consoleAction(result.terminal)).includes(`退出码 ${code}`), 'completion status in retained terminal')
  assert.equal(alive(result.terminal), true)
}
try {
  const marker = path.join(fixtures, 'result.json')
  const args = ['a b', '"quoted"', '', "中文 &|<>%!^'$()", 'C:\\path with spaces\\', 'slash\\"quote', 'wait']
  const config = { ...script(file, '终端测试', [marker, ...args]), cwd: fixtures, env: { SCRIPT_STUDIO_FIXTURE: 'saved value 中文' }, interpreterArgs: ['--no-warnings'] }
  const before = (await app.api('snapshot')).runs
  await assert.rejects(app.api('run.terminal', { scriptId: crypto.randomUUID() }), /不存在/)
  const running = await open(config, marker)
  assert.deepEqual(running.args, args)
  assert.equal(path.resolve(running.cwd), path.resolve(fixtures))
  assert.equal(running.env, 'saved value 中文')
  assert.equal(running.snapshot, undefined)
  assert.equal(running.input, true); assert.equal(running.output, true)
  assert.deepEqual((await app.api('snapshot')).runs, before)
  assert.equal((await app.api('status')).activeRuns, 0)
  console.log('PASS direct PowerShell parent, literal argv, saved cwd/env, console stdio and unmanaged history')

  // Execute the exact embedded bootstrap without -NoExit to inspect diagnostics.
  const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
  function bootstrapCheck(snapshot, code, pattern) {
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); & { ${bootstrap} }; [Console]::WriteLine('FIXTURE_EXIT:'+$global:LASTEXITCODE); if(Test-Path Env:SCRIPT_STUDIO_TERMINAL_SNAPSHOT){throw 'snapshot leaked'}`], { env: { ...process.env, SCRIPT_STUDIO_TERMINAL_SNAPSHOT: typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot) }, encoding: 'utf8', timeout: 20000 })
    assert.ifError(run.error); assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, new RegExp(`FIXTURE_EXIT:${code}`)); assert.match(run.stdout, pattern)
    assert.ok(!run.stdout.includes('snapshot-secret'))
  }
  const payload = { program: process.execPath, arguments: ['-e', 'process.exit(7)'].map(quote).join(' '), cwd: fixtures, env: { SECRET: 'snapshot-secret' }, error: null }
  bootstrapCheck(payload, 7, /退出码 7/)
  bootstrapCheck({ ...payload, arguments: ['-e', 'process.exit(0)'].map(quote).join(' ') }, 0, /退出码 0/)
  bootstrapCheck({ ...payload, program: path.join(root, 'missing.exe') }, 1, /无法启动/)
  bootstrapCheck({ ...payload, error: '找不到解释器' }, 1, /找不到解释器/)
  bootstrapCheck('broken json', 1, /无法启动/)
  console.log('PASS embedded bootstrap exit codes, missing interpreter, malformed payload and snapshot cleanup')

  for (const runner of ['auto', 'node', 'direct']) {
    const marker = path.join(fixtures, `${runner}.json`)
    const config = runner === 'direct'
      ? { ...script(process.execPath, runner, [file, marker, 'direct']), runner }
      : { ...script(file, runner, [marker, runner]), runner }
    const result = await open(config, marker)
    assert.deepEqual(result.args, [runner]); await finished(result)
  }
  const pathBin = path.join(root, 'saved PATH')
  await mkdir(pathBin); await copyFile(process.execPath, path.join(pathBin, 'fixture-node.exe'))
  const pathMarker = path.join(fixtures, 'path.json')
  const fromPath = await open({ ...script(file, 'saved PATH', [pathMarker, 'path']), program: 'fixture-node', env: { Path: pathBin } }, pathMarker)
  await finished(fromPath)
  console.log('PASS automatic/Node/direct execution and saved PATH interpreter lookup')

  const ps = path.join(fixtures, 'fixture.ps1'), psMarker = path.join(fixtures, 'powershell.json')
  await writeFile(ps, "[IO.File]::WriteAllText($args[0],(ConvertTo-Json -Compress @{pid=$PID;parent=(Get-CimInstance Win32_Process -Filter ('ProcessId = '+$PID)).ParentProcessId}));exit 7")
  await finished(await open({ ...script(ps, 'PowerShell', [psMarker]), runner: 'auto' }, psMarker))
  const cmd = path.join(fixtures, 'fixture.cmd'), cmdMarker = path.join(fixtures, 'cmd.json')
  const env = { SCRIPT_STUDIO_FIXTURE_NODE: process.execPath, SCRIPT_STUDIO_FIXTURE_SCRIPT: file }
  // Node is a child of CMD in these fixtures; record CMD's direct PowerShell parent.
  const cmdScript = { ...script(cmd, 'CMD', [cmdMarker, 'a & b %PATH% ! (x)']), runner: 'auto', env }
  async function openBatch(config, marker) {
    await save(app, c => c.scripts.push(config)); await app.api('run.terminal', { scriptId: config.id })
    recordTerminals()
    const result = await until(async () => JSON.parse(await readFile(marker, 'utf8')), 'batch fixture')
    // Completion status is on the new terminal; use the bootstrap's CMD process
    // while it waits for a fixture that explicitly stays alive until released.
    const cmd = processInfo(result.parent)
    assert.equal(cmd?.Name.toLowerCase(), 'cmd.exe')
    const terminal = processInfo(cmd.ParentProcessId)
    assert.equal(terminal?.Name.toLowerCase(), 'powershell.exe')
    terminals.set(terminal.ProcessId, terminal.CreationDate)
    for (const pid of [result.pid, result.parent]) { const info = processInfo(pid); if(info)children.set(pid,info.CreationDate) }
    await writeFile(marker + '.release', '')
    return { ...result, terminal: terminal.ProcessId, marker }
  }
  // Keep the fixture alive long enough to inspect CMD instead of racing its exit.
  await writeFile(cmd, '@echo off\r\n"%SCRIPT_STUDIO_FIXTURE_NODE%" "%SCRIPT_STUDIO_FIXTURE_SCRIPT%" "%~1" "%~2" wait\r\nexit /b %errorlevel%\r\n')
  const batch = await openBatch(cmdScript, cmdMarker)
  assert.deepEqual(batch.args, ['a & b %PATH% ! (x)', 'wait']); await finished(batch)
  const wrapper = path.join(fixtures, 'custom.cmd'), customMarker = path.join(fixtures, 'custom-batch.json')
  await writeFile(wrapper, '@echo off\r\n"%SCRIPT_STUDIO_FIXTURE_NODE%" "%~1" "%~2" "%~3" wait\r\nexit /b %errorlevel%\r\n')
  const customBatch = await openBatch({ ...script(file, '自定义 CMD', [customMarker, 'literal %PATH% & !']), program: wrapper, env }, customMarker)
  assert.deepEqual(customBatch.args, ['literal %PATH% & !', 'wait']); await finished(customBatch)
  console.log('PASS PowerShell, CMD single expansion and custom batch interpreter')

  const pythonPaths = spawnSync('where.exe', ['python.exe'], { encoding: 'utf8', timeout: 10000 })
  const python = pythonPaths.stdout?.split(/\r?\n/).find(value => value && !/\\WindowsApps\\/i.test(value))
  if (python) {
    const py = path.join(fixtures, 'fixture.py'), pyMarker = path.join(fixtures, 'python.json')
    await writeFile(py, "import json,os,sys\nwith open(sys.argv[1],'w',encoding='utf-8') as f: json.dump({'pid':os.getpid(),'parent':os.getppid(),'args':sys.argv[2:],'cwd':os.getcwd()},f)\nsys.exit(7)\n")
    const args = ['', 'a"b', '中文 & %PATH% !', 'C:\\space dir\\']
    const result = await open({ ...script(py, 'Python', [pyMarker, ...args]), runner: 'python', cwd: fixtures, env: { Path: path.dirname(python) } }, pyMarker)
    assert.deepEqual(result.args, args); assert.equal(path.resolve(result.cwd), path.resolve(fixtures))
    await finished(result)
    console.log('PASS existing Python interpreter with saved PATH, Unicode/empty/quoted argv and cwd')
  } else {
    console.log('SKIP Python interpreter unavailable (Windows Store aliases are not launched; no tools installed)')
  }

  const inputMarker = path.join(fixtures, 'input.json')
  const input = await open(script(file, 'console input', [inputMarker, 'input']), inputMarker)
  await consoleAction(input.terminal, 'input', 'hello terminal\r')
  await until(async () => (await readFile(inputMarker + '.input', 'utf8')) === 'hello terminal', 'interactive stdin')
  await finished(input, 0)
  console.log('PASS actual console input and terminal retention after successful completion')

  const missing = script(path.join(root, 'missing.mjs'), '缺少脚本')
  await save(app, c => c.scripts.push(missing))
  await assert.rejects(app.api('run.terminal', { scriptId: missing.id }), /不存在/)
  const badCwd = { ...script(file, 'missing cwd'), cwd: path.join(root, 'missing cwd') }
  await save(app, c => c.scripts.push(badCwd))
  await assert.rejects(app.api('run.terminal', { scriptId: badCwd.id }), /目录不存在/)
  const badCmd = { ...script(cmd, 'bad CMD', ['a"b']), runner: 'cmd' }
  await save(app, c => c.scripts.push(badCmd))
  await assert.rejects(app.api('run.terminal', { scriptId: badCmd.id }), /CMD 参数/)
  const large = script(file, 'large snapshot', ['x'.repeat(20000), 'y'.repeat(20000)])
  await save(app, c => c.scripts.push(large))
  await assert.rejects(app.api('run.terminal', { scriptId: large.id }), /长度限制/)
  for (const key of ['script_studio_cmd_path', 'Script_Studio_Terminal_Snapshot']) {
    await assert.rejects(save(app, c => c.scripts.push({ ...script(file, 'reserved environment'), env: { [key]: 'reserved' } })), /环境变量/)
  }
  const managed = await app.api('run.start', { scriptId: config.id })
  await assert.rejects(app.api('run.terminal', { scriptId: config.id }), /已经在运行/)
  await app.api('run.stop', { runId: managed.runId })
  const configFile = path.join(root, 'data/config.json'), saved = await readFile(configFile)
  await writeFile(configFile, 'broken'); await app.api('reload')
  await assert.rejects(app.api('run.terminal', { scriptId: config.id }), /修复配置/)
  await writeFile(configFile, saved); await app.api('reload')
  console.log('PASS invalid configuration, length limits, reserved environment and active managed run rejection')

  const heartbeat = Number(await readFile(marker + '.beat', 'utf8'))
  await app.exit()
  assert.equal(alive(running.pid), true); assert.equal(alive(running.terminal), true)
  const previous = path.join(root, 'previous installation')
  await rename(installed, previous)
  await copyFile(binary(), path.join(previous, 'script-studio.exe'))
  await writeFile(path.join(previous, 'dist/index.html'), 'replaced old frontend')
  await stage(installed)
  app = await launch(path.join(root, 'data'), { bin: path.join(installed, 'script-studio.exe'), env: { SCRIPT_STUDIO_UI_DIR: '' } }); backends.push(app)
  assert.match(await (await fetch(app.desc.origin)).text(), /<title>Script Studio<\/title>/)
  await until(async () => Number(await readFile(marker + '.beat', 'utf8')) > heartbeat, 'heartbeat survives plugin replacement')
  assert.equal(alive(running.pid), true)
  await writeFile(marker + '.release', '')
  await finished(running)
  await consoleAction(running.terminal, 'input', "Write-Output ('FIXTURE_' + 'PROMPT_READY')\r")
  await until(async () => (await consoleAction(running.terminal)).includes('FIXTURE_PROMPT_READY'), 'terminal remains usable after completion')
  console.log('PASS backend shutdown, installation rename/exe overwrite/frontend replacement/restart with uninterrupted external task')

  const ctrlMarker = path.join(fixtures, 'ctrlc.json')
  const ctrl = await open(script(file, 'Ctrl+C fixture', [ctrlMarker, 'wait']), ctrlMarker)
  await consoleAction(ctrl.terminal, 'ctrlc')
  await until(() => !alive(ctrl.pid), 'Ctrl+C stops external fixture')
  assert.equal(alive(ctrl.terminal), true)
  await consoleAction(ctrl.terminal, 'input', "Write-Output ('FIXTURE_' + 'CTRL_C_PROMPT')\r")
  await until(async () => (await consoleAction(ctrl.terminal)).includes('FIXTURE_CTRL_C_PROMPT'), 'terminal remains usable after Ctrl+C')
  console.log('PASS Ctrl+C affects only the fixture console and leaves a usable PowerShell prompt')
} finally {
  for (const backend of backends) await backend.exit()
  for (const [pid, created] of [...children, ...terminals]) {
    // A historical PID alone never authorizes cleanup, even in fixture tests.
    if (processInfo(pid)?.CreationDate === created) { try { process.kill(pid) } catch {} }
  }
}
console.log(`Terminal verification artifacts: ${root}`)
