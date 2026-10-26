import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import {launch,save,script,completed,output,temp,until,delay,binary} from './lib.mjs'

const root=await temp('runtime-check-'),dir=path.join(root,'data'),fixtures=path.join(root,'中文 scripts & %literal%!')
await mkdir(fixtures)
const file=path.join(fixtures,'fixture.mjs')
await writeFile(file,`import fs from 'node:fs';import {spawn} from 'node:child_process';
const [mode,...args]=process.argv.slice(2);
if(mode==='args'){process.stdout.write(JSON.stringify({args,cwd:process.cwd(),env:process.env.SCRIPT_STUDIO_FIXTURE})+'\\n');process.stderr.write('diagnostic\\n')}
else if(mode==='fail')process.exit(7);
else if(mode==='flood')process.stdout.write('a'.repeat(11*1024*1024));
else if(mode==='child'){const c=spawn(process.execPath,[process.argv[1],'slow'],{stdio:'inherit',detached:true});process.stdout.write('child:'+c.pid+'\\n');setTimeout(()=>process.exit(0),100)}
else if(mode==='pid'){fs.writeFileSync(args[0],String(process.pid));setInterval(()=>{},1000)}
else {process.stdout.write('started\\n');setInterval(()=>process.stdout.write('tick\\n'),200)}
`)
let app,external;const passes=[];let skipped=[]
async function check(name,fn){await fn();passes.push(name);console.log('PASS '+name)}
async function start(s){return(await app.api('run.start',{scriptId:s.id})).runId}
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}}
try{
 app=await launch(dir)
 await check('stdio-v1 handshake, authenticated status, private HTTP boundary',async()=>{
  assert.equal(app.desc.protocol,1);assert.equal(app.desc.ready,true)
  app.proc.stdin.write(JSON.stringify({action:'status'})+'\n');const status=JSON.parse(await app.line());assert.equal(status.value.instance,app.desc.instance)
  await assert.rejects(app.api('snapshot',{}, {Authorization:''}),/身份|来源/)
  await assert.rejects(app.api('snapshot',{}, {Origin:'https://untrusted.invalid'}),/身份|来源/)
  const hostStatus=await new Promise((resolve,reject)=>{const req=http.request(app.desc.origin+'/api',{method:'POST',headers:{Host:'untrusted.invalid',Authorization:`Bearer ${app.desc.token}`,'Content-Type':'application/json'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.end(JSON.stringify({action:'snapshot'}))});assert.equal(hostStatus,403)
  assert.equal((await fetch(app.desc.origin+'/config.json')).status,404)
 })
 const args=script(file,'参数与路径',['args','a b','"quoted"','&|<>%!^','中文','']);args.cwd=fixtures;args.env={SCRIPT_STUDIO_FIXTURE:'local value'};args.interpreterArgs=['--no-warnings']
 await save(app,c=>c.scripts.push(args))
 await check('literal argv, empty argument, Unicode path, cwd, environment and stderr success',async()=>{
  const id=await start(args),run=await completed(app,id),logs=await output(app,id)
  assert.equal(run.state,'succeeded');assert.equal(run.exitCode,0)
  const stdout=logs.chunks.filter(c=>c.stream==='stdout').map(c=>c.text).join('')
  const value=JSON.parse(stdout);assert.deepEqual(value.args,args.args.slice(1));assert.equal(path.resolve(value.cwd),path.resolve(fixtures));assert.equal(value.env,'local value');assert.match(logs.text,/diagnostic/)
 })
 const fail=script(file,'失败',['fail']);await save(app,c=>c.scripts.push(fail))
 await check('nonzero exit produces failed history',async()=>{const run=await completed(app,await start(fail));assert.equal(run.state,'failed');assert.equal(run.exitCode,7)})
 await check('missing script, interpreter and working directory report errors',async()=>{
  const missing=script(path.join(fixtures,'missing.mjs'),'不存在');await save(app,c=>c.scripts.push(missing));await assert.rejects(start(missing),/不存在/)
  await save(app,c=>{const x=c.scripts.find(s=>s.id===missing.id);x.path=file;x.program=path.join(fixtures,'no-runtime.exe')});const result=await completed(app,await start(missing));assert.equal(result.state,'failed');assert.match(result.error,/无法启动/)
  await save(app,c=>{const x=c.scripts.find(s=>s.id===missing.id);x.cwd=path.join(fixtures,'missing')});await assert.rejects(start(missing),/目录不存在/)
 })
 const a=script(file,'并发 A',['slow']),b=script(file,'并发 B',['slow']);await save(app,c=>c.scripts.push(a,b))
 let aid,bid
 await check('backend atomically rejects duplicate run while different scripts execute concurrently',async()=>{
  const attempts=await Promise.allSettled([start(a),start(a)]);assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);aid=attempts.find(x=>x.status==='fulfilled').value;bid=await start(b)
  assert.equal((await app.api('status')).activeRuns,2)
 })
 await check('saving settings preserves the active run snapshot and deleting active registration is rejected',async()=>{
  await save(app,c=>{c.scripts.find(s=>s.id===a.id).args=['fail'];c.scripts.find(s=>s.id===a.id).favorite=true})
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'runs',`${aid}.json`),'utf8')).snapshot.args,['slow'])
  await assert.rejects(save(app,c=>c.scripts=c.scripts.filter(s=>s.id!==a.id)),/先停止/)
  assert.equal((await app.api('status')).activeRuns,2)
 })
 await check('stop is per run and metadata removal preserves script file and history',async()=>{
  await app.api('run.stop',{runId:aid});assert.equal((await completed(app,aid)).state,'stopped');assert.equal((await app.api('snapshot')).runs.find(r=>r.id===bid).state,'running')
  await save(app,c=>c.scripts=c.scripts.filter(s=>s.id!==a.id));assert.ok((await stat(file)).isFile());assert.ok((await app.api('snapshot')).runs.some(r=>r.id===aid))
 })
 const flood=script(file,'有界输出',['flood']);await save(app,c=>c.scripts.push(flood))
 await check('large output is drained after the 10 MiB log cap',async()=>{
  const id=await start(flood),run=await completed(app,id);assert.equal(run.state,'succeeded');assert.equal(run.logTruncated,true);assert.ok((await stat(path.join(dir,'runs',`${id}.jsonl`))).size<=10*1024*1024)
  const logs=await app.api('run.logs',{runId:id,cursor:0});assert.equal(logs.truncated,true);assert.ok(logs.cursor>0);await assert.rejects(app.api('run.logs',{runId:id,cursor:1}),/边界/)
 })
 await check('external edits and corrupted config are never overwritten; active runs can still stop',async()=>{
  const snapshot=await app.api('snapshot'),configPath=path.join(dir,'config.json');await writeFile(configPath,JSON.stringify(snapshot.config)+'\n')
  await assert.rejects(app.api('save',{config:snapshot.config,revision:snapshot.revision}),/重新加载/)
  await app.api('reload');await writeFile(configPath,'broken');const bad=await app.api('reload');assert.ok(bad.configError)
  await assert.rejects(app.api('save',{config:snapshot.config,revision:bad.revision}),/不可写/);assert.equal(await readFile(configPath,'utf8'),'broken')
  await app.api('run.stop',{runId:bid});assert.equal((await completed(app,bid)).state,'stopped')
  await writeFile(configPath,JSON.stringify(snapshot.config));await app.api('reload')
 })
 if(process.platform==='win32'){
  await check('built-in Node and direct executable launchers',async()=>{
   const node={...script(file,'Node 自动识别',['args','native node']),runner:'auto'},direct={...script(binary(),'直接执行',['--help']),runner:'auto'}
   await save(app,c=>c.scripts.push(node,direct));for(const s of [node,direct]){const id=await start(s);assert.equal((await completed(app,id)).state,'succeeded')}
  })
  await check('Windows PowerShell and CMD wrappers run without a result JSON protocol',async()=>{
   const ps=path.join(fixtures,'wrapper.ps1');await writeFile(ps,'\uFEFF[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n[Console]::Write("PowerShell 中文")\nexit 0\n')
   const psScript={...script(ps,'PowerShell'),runner:'auto'};const bat=path.join(fixtures,'wrapper.cmd');await writeFile(bat,'@echo off\r\necho CMD ready\r\nexit /b 0\r\n');const cmdScript={...script(bat,'CMD'),runner:'auto'}
   await save(app,c=>c.scripts.push(psScript,cmdScript));for(const s of [psScript,cmdScript]){const id=await start(s);assert.equal((await completed(app,id)).state,'succeeded');assert.match((await output(app,id)).text,s===psScript?/PowerShell 中文/:/CMD ready/)}
   const argFile=path.join(fixtures,'arguments.ps1');await writeFile(argFile,'\uFEFF[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n[Console]::Write((ConvertTo-Json -Compress -InputObject @($args)))\nexit 0\n');const argScript={...script(argFile,'PowerShell 参数',['a b','"quoted"','中文','','&|<>%!^']),runner:'auto'};await save(app,c=>c.scripts.push(argScript));const argId=await start(argScript);assert.equal((await completed(app,argId)).state,'succeeded');assert.deepEqual(JSON.parse((await output(app,argId)).text),argScript.args)
   await save(app,c=>c.scripts.find(s=>s.id===cmdScript.id).args=['"ambiguous"']);await assert.rejects(start(cmdScript),/双引号/)
  })
  await check('Windows Job retains descendants after parent exit and only stops its owned tree',async()=>{
   external=spawn(process.execPath,[file,'slow'],{stdio:'ignore'});const child=script(file,'子进程树',['child']);await save(app,c=>c.scripts.push(child));const id=await start(child)
   const pid=await until(async()=>Number((await output(app,id)).text.match(/child:(\d+)/)?.[1]),'child PID');await delay(400);assert.equal((await app.api('snapshot')).runs.find(r=>r.id===id).state,'running')
   await app.api('run.stop',{runId:id});assert.equal((await completed(app,id)).state,'stopped');await until(()=>!alive(pid),'owned child gone');assert.equal(external.exitCode,null)
  })
  await check('abnormal backend termination closes its Job and recovery marks unfinished run interrupted',async()=>{
   const marker=path.join(root,'owned.pid'),s=script(file,'异常恢复',['pid',marker]);await save(app,c=>c.scripts.push(s));const id=await start(s),pid=await until(async()=>Number(await readFile(marker,'utf8')),'owned PID')
   app.proc.kill();await until(()=>app.proc.exitCode!==null||app.proc.signalCode!==null,'hard exit');await until(()=>!alive(pid),'Job close cleanup');app=await launch(dir)
   const run=(await app.api('snapshot')).runs.find(r=>r.id===id);assert.equal(run.state,'interrupted');assert.equal((await app.api('status')).activeRuns,0)
  })
  const wsl=spawnSync('wsl.exe',['--list','--quiet'],{encoding:'utf8',timeout:10000})
  if(wsl.status===0&&wsl.stdout.replaceAll('\0','').trim()){
   await check('Windows wrapper invokes WSL foreground command and propagates exit code',async()=>{
    const ps=path.join(fixtures,'wsl-wrapper.ps1');await writeFile(ps,'& wsl.exe -- sh -c "printf wsl-fixture; exit 6"\nexit $LASTEXITCODE\n');const s={...script(ps,'WSL 包装'),runner:'auto'};await save(app,c=>c.scripts.push(s));const id=await start(s),run=await completed(app,id);assert.equal(run.exitCode,6);assert.match((await output(app,id)).text,/wsl-fixture/)
   })
  }else skipped.push('WSL wrapper: no accessible installed distribution')
 }else skipped.push('Windows PowerShell, CMD, Job Object and WSL checks require Windows')
 await check('stdio EOF stops tasks and persisted configuration/history survive restart',async()=>{
  const id=await start(b);app.proc.stdin.end();await until(()=>app.proc.exitCode!==null||app.proc.signalCode!==null,'EOF exit');app=await launch(dir)
  const state=await app.api('snapshot');assert.equal(state.runs.find(r=>r.id===id).state,'stopped');assert.ok(state.config.scripts.some(s=>s.id===args.id));assert.equal((await app.api('status')).activeRuns,0)
 })
 await check('verified existing instance is reused and bridge EOF cleans the shared instance',async()=>{
  await app.exit();app=await launch(dir,{stdio:false})
  const bridge=await launch(dir);assert.equal(bridge.desc.instance,app.desc.instance);const id=await start(b);bridge.proc.stdin.end();await until(()=>bridge.proc.exitCode!==null||bridge.proc.signalCode!==null,'bridge EOF exit');await until(()=>app.proc.exitCode!==null||app.proc.signalCode!==null,'shared backend exit')
  app=await launch(dir);assert.equal((await app.api('snapshot')).runs.find(r=>r.id===id).state,'stopped')
 })
 await check('history retention removes oldest completed records without deleting active ones',async()=>{
  await app.exit();const files=(await readdir(path.join(dir,'runs'))).filter(f=>f.endsWith('.json'));const sample=JSON.parse(await readFile(path.join(dir,'runs',files[0]),'utf8'))
  for(let i=0;i<105;i++){const value={...sample,id:crypto.randomUUID(),startedAt:i,endedAt:i+1,state:'succeeded'};await writeFile(path.join(dir,'runs',`${value.id}.json`),JSON.stringify(value))}
  const long={...sample,id:crypto.randomUUID(),startedAt:0,endedAt:Date.now(),state:'succeeded'};await writeFile(path.join(dir,'runs',`${long.id}.json`),JSON.stringify(long))
  app=await launch(dir);const retained=(await app.api('snapshot')).runs;assert.equal(retained.length,100);assert.ok(retained.some(r=>r.id===long.id),'recently completed long task is retained by completion time');assert.equal((await readdir(path.join(dir,'runs'))).filter(f=>f.endsWith('.json')).length,100)
 })
 console.log(JSON.stringify({root,binary:binary(),passed:passes.length,skipped},null,2))
}finally{external?.kill();await app?.exit()}
