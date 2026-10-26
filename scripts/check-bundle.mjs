import assert from 'node:assert/strict'
import {cp,readFile,access} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import path from 'node:path'
import {launch,temp,until} from './lib.mjs'
const source=path.resolve(process.env.SCRIPT_STUDIO_BUNDLE||'release/ScriptStudio-0.1.0-windows'),root=await temp('bundle-check-'),moved=path.join(root,'移动后的目录 with spaces')
await cp(source,moved,{recursive:true})
const manifest=JSON.parse(await readFile(path.join(moved,'plugin.json'),'utf8'))
assert.equal(manifest.schemaVersion,2);assert.equal(manifest.entries[0].presentation,'application');assert.equal(manifest.lifecycle.entrypoint,'oriel.ps1');assert.equal(manifest.entries[0].service,manifest.id)
for(const file of ['script-studio.exe','dist/index.html',manifest.documentation,manifest.lifecycle.entrypoint,'Open-ScriptStudio.cmd'])await access(path.join(moved,file))
let app
try{
 app=await launch(path.join(root,'data'),{bin:path.join(moved,'script-studio.exe'),env:{SCRIPT_STUDIO_UI_DIR:''}})
 const page=await(await fetch(app.desc.origin)).text();assert.match(page,/<title>Script Studio<\/title>/)
 for(const src of [...page.matchAll(/(?:src|href)="(\/assets\/[^"\s]+)"/g)].map(m=>m[1]))assert.equal((await fetch(app.desc.origin+src)).status,200)
 assert.match(await(await fetch(app.desc.origin+'/guide')).text(),/WSL 包装脚本/)
 assert.equal((await app.api('status')).instance,app.desc.instance);await app.exit()
 if(process.platform==='win32'){
  const wrapper=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(moved,'oriel.ps1'),'-DataDir',path.join(root,'wrapper-data')],{stdio:['pipe','pipe','inherit']})
  let text='';wrapper.stdout.on('data',b=>text+=b);const descriptor=await until(()=>{try{return JSON.parse(text.split('\n')[0])}catch{}},'moved wrapper readiness')
  assert.equal(descriptor.ready,true);wrapper.stdin.end();await until(()=>wrapper.exitCode!==null||wrapper.signalCode!==null,'wrapper EOF')
 }
 console.log(JSON.stringify({passed:process.platform==='win32'?4:3,root,checks:['manifest and complete bundle','moved executable and relative frontend','same guide and authenticated readiness',...(process.platform==='win32'?['moved PowerShell wrapper EOF']:[])]},null,2))
}finally{await app?.exit()}
