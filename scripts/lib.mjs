import {spawn} from 'node:child_process'
import {mkdir,mkdtemp} from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
export const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
export async function until(fn,label='condition',timeout=20000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const value=await fn();if(value)return value}catch(e){last=e}await delay(50)}throw Error(`Timeout: ${label}${last?`: ${last.message}`:''}`)}
export async function temp(prefix){await mkdir('target',{recursive:true});return mkdtemp(path.resolve('target',prefix))}
export const binary=()=>path.resolve(process.env.SCRIPT_STUDIO_BIN||(process.platform==='win32'?'target/windows/debug/script-studio.exe':'target/debug/script-studio'))
export async function launch(dir,{bin=binary(),stdio=true,env={},args=[]}={}){
 const proc=spawn(bin,['serve','--data-dir',dir,...(stdio?['--oriel-stdio']:[]),...args],{env:{...process.env,SCRIPT_STUDIO_UI_DIR:path.resolve('dist'),...env},stdio:['pipe','pipe','pipe']})
 let diagnostic='';proc.stderr.on('data',b=>diagnostic+=b)
 proc.on('error',e=>diagnostic+=e.message)
 const lines=[],waiters=[]
 readline.createInterface({input:proc.stdout}).on('line',line=>{if(waiters.length)waiters.shift()(line);else lines.push(line)})
 const line=()=>new Promise((resolve,reject)=>{if(lines.length)return resolve(lines.shift());let done=false;const accept=s=>{if(!done){done=true;clearTimeout(timeout);resolve(s)}};const timeout=setTimeout(()=>{done=true;const i=waiters.indexOf(accept);if(i>=0)waiters.splice(i,1);reject(Error(`Backend did not respond: ${diagnostic}`))},20000);waiters.push(accept)})
 let desc
 try{desc=JSON.parse(await line())}catch(e){proc.kill();throw e}
 const request=async(action,args={},headers={})=>{const response=await fetch(`${desc.origin}/api`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${desc.token}`,...headers},body:JSON.stringify({action,...args}),signal:AbortSignal.timeout(20000)});const result=await response.json();if(!result.ok)throw Error(result.error);return result.value}
 return {proc,desc,line,api:request,diagnostics:()=>diagnostic,async exit(){if(proc.exitCode===null&&proc.signalCode===null){try{await request('shutdown')}catch{proc.stdin.end()}await until(()=>proc.exitCode!==null||proc.signalCode!==null,'backend exit',20000)}}}
}
export async function save(app,mutate){const snapshot=await app.api('snapshot');const config=structuredClone(snapshot.config);mutate(config);return app.api('save',{config,revision:snapshot.revision})}
export function script(file,name,args=[]){return{id:crypto.randomUUID(),name,description:'隔离测试脚本',path:file,groupId:null,favorite:false,runner:'custom',program:process.execPath,interpreterArgs:[],args,cwd:null,env:{},encoding:'utf8'}}
export async function completed(app,runId){return until(async()=>{const run=(await app.api('snapshot')).runs.find(r=>r.id===runId);return run&&!['running','stopping'].includes(run.state)&&run},'run completion')}
export async function output(app,runId){let cursor=0,text='',chunks=[];for(;;){const result=await app.api('run.logs',{runId,cursor});chunks.push(...result.chunks);text+=result.chunks.map(c=>c.text).join('');if(result.cursor===cursor)return{text,chunks,truncated:result.truncated,cursor};cursor=result.cursor}}
