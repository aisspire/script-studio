import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {Cdp} from './cdp.mjs'
import {launch,save,script,temp,until,delay,completed} from './lib.mjs'
if(process.platform!=='win32')throw Error('Run with Windows Node and existing Edge; no browser is installed by this check.')
const root=await temp('ui-check-'),data=path.join(root,'data'),file=path.join(root,'UI 中文 fixture.mjs'),slowFile=path.join(root,'slow.mjs')
await writeFile(file,"process.stdout.write('ui-result:'+JSON.stringify(process.argv.slice(2))+'\\n');process.stderr.write('ui diagnostic\\n')")
await writeFile(slowFile,"process.stdout.write('ui-running\\n');setInterval(()=>process.stdout.write('tick\\n'),200)")
const app=await launch(data)
const edge=spawn(process.env.SCRIPT_STUDIO_EDGE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${path.join(root,'profile')}`,'about:blank'],{stdio:'ignore'})
let cdp;const errors=[],passes=[]
const shown=`el=>el.getClientRects().length>0`
async function click(text,scope='body'){await cdp.evaluate(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].filter(${shown}).find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing button '+${JSON.stringify(text)});b.click()})()`);await delay(80)}
async function aria(label){await cdp.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)});if(!el)throw Error('Missing control');el.focus();el.click()})()`);await delay(80)}
async function fill(label,value,scope='.config-form'){await cdp.evaluate(`(()=>{const l=[...document.querySelectorAll(${JSON.stringify(scope+' label')})].find(l=>l.firstChild.textContent.trim()===${JSON.stringify(label)});const el=l?.querySelector('input,select,textarea');if(!el)throw Error('Missing field '+${JSON.stringify(label)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))})()`)}
const text=()=>cdp.evaluate('document.body.textContent')
const closed=selector=>until(()=>cdp.evaluate(`!document.querySelector(${JSON.stringify(selector)})?.open`),'dialog closed')
async function shot(name){await writeFile(path.join(root,name),Buffer.from((await cdp.command('Page.captureScreenshot',{format:'png'})).data,'base64'))}
async function check(name,fn){await fn();passes.push(name);console.log('PASS '+name)}
try{
 const port=await until(async()=>Number((await readFile(path.join(root,'profile/DevToolsActivePort'),'utf8')).split('\n')[0]),'Edge CDP')
 const target=await until(async()=>(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page'),'Edge target')
 cdp=await new Cdp().connect(target.webSocketDebuggerUrl);cdp.socket.addEventListener('message',e=>{const m=JSON.parse(String(e.data));if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text)})
 await cdp.command('Runtime.enable');await cdp.command('Page.enable');await cdp.command('Emulation.setDeviceMetricsOverride',{width:1180,height:840,deviceScaleFactor:1,mobile:false});await cdp.command('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});await cdp.command('Page.navigate',{url:app.desc.pageUrl});await until(async()=>(await text()).includes('添加你的第一个脚本'),'empty state')
 await check('empty state, native dialog, Escape and focus restoration',async()=>{
  await aria('使用说明');await until(()=>cdp.evaluate(`document.querySelector('.help-dialog').open`),'help');assert.match(await cdp.evaluate(`document.querySelector('.guide').textContent`),/WSL 包装脚本/)
  await cdp.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await closed('.help-dialog');assert.equal(await cdp.evaluate(`document.activeElement.getAttribute('aria-label')`),'使用说明')
 })
 await check('add actual local path and configure per-script launch',async()=>{
  await click('添加脚本','header');await fill('脚本文件',file,'dialog[open]');await fill('脚本名称','界面任务','dialog[open]');await click('添加到工作空间','dialog[open]');await closed('dialog[open]')
  await until(()=>cdp.evaluate(`document.querySelector('.config-form input')?.value==='界面任务'`),'selected config')
  await fill('启动方式','custom');await fill('解释器',process.execPath)
  await click('＋ 添加参数','.config-form');await cdp.evaluate(`(()=>{const el=document.querySelector('[aria-label="启动参数 1"]');el.value='a b 中文';el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await fill('备注','界面与真实执行的隔离验证');await click('保存配置','.config-form');await until(()=>cdp.evaluate(`!document.querySelector('.dirty-dot')`),'configuration saved')
  const state=await app.api('snapshot');assert.equal(state.config.scripts[0].program,process.execPath);assert.deepEqual(state.config.scripts[0].args,['a b 中文'])
  await cdp.evaluate(`document.querySelector('.advanced').open=true`);await fill('环境变量','INVALID');assert.equal(await cdp.evaluate(`document.querySelector('[aria-label="环境变量"]').getAttribute('aria-invalid')`),'true');await click('放弃修改','.config-form');await fill('环境变量','SCRIPT_STUDIO_UI_TEST=ok');await click('保存配置','.config-form');await until(async()=>(await app.api('snapshot')).config.scripts[0].env.SCRIPT_STUDIO_UI_TEST==='ok','environment after discard')
 })
 await check('copy saved and draft PowerShell commands with clipboard failure feedback',async()=>{
  await cdp.command('Browser.grantPermissions',{origin:app.desc.origin,permissions:['clipboardReadWrite','clipboardSanitizedWrite']})
  const button='复制 界面任务 的 PowerShell 命令'
  await aria(button)
  const saved=await cdp.evaluate('navigator.clipboard.readText()')
  assert.ok(saved.startsWith("& '"));assert.ok(saved.includes(file));assert.ok(saved.includes("'a b 中文'"));assert.ok(!saved.includes('\\\\'))
  await fill('名称','草稿名称');await fill('脚本文件',file.replace('fixture.mjs','draft.mjs'))
  await click('复制命令','.advanced')
  assert.ok((await cdp.evaluate('navigator.clipboard.readText()')).includes('draft.mjs'))
  await aria(button);assert.equal(await cdp.evaluate('navigator.clipboard.readText()'),saved)
  await cdp.evaluate(`window.originalClipboardWrite=navigator.clipboard.writeText; navigator.clipboard.writeText=()=>Promise.reject(new Error('denied'))`)
  await aria(button);assert.match(await text(),/无法写入剪贴板/)
  await cdp.evaluate(`navigator.clipboard.writeText=window.originalClipboardWrite;delete window.originalClipboardWrite`)
  await click('放弃修改','.config-form')
 })
 await check('bottom-right notifications preserve layout, expire and pause for reading',async()=>{
  await aria('关闭错误提示')
  const geometry=()=>cdp.evaluate(`['.app-header','.workspace','.output-panel'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return [r.x,r.y,r.width,r.height]})`)
  const before=await geometry()
  await aria('复制 界面任务 的 PowerShell 命令')
  assert.deepEqual(await geometry(),before,'notification must not shift the workspace or output')
  assert.equal(await cdp.evaluate(`getComputedStyle(document.querySelector('.toast-viewport')).position`),'fixed')
  const toast=await cdp.evaluate(`(()=>{const r=document.querySelector('.toast-success').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom}})()`)
  assert.ok(toast.left>1180/2)
  assert.ok(toast.bottom<=840&&toast.bottom>=800&&toast.right<=1180)
  assert.equal(await cdp.evaluate(`document.activeElement.getAttribute('aria-label')`),'复制 界面任务 的 PowerShell 命令','notification does not steal focus')
  await shot('toast-light.png')
  await cdp.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:toast.left+20,y:toast.top+15})
  await delay(4200);assert.ok(await cdp.evaluate(`Boolean(document.querySelector('.toast-success'))`),'hover pauses dismissal')
  await cdp.evaluate(`document.querySelector('.toast-success button').focus()`)
  await cdp.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1})
  await delay(4200);assert.ok(await cdp.evaluate(`Boolean(document.querySelector('.toast-success'))`),'keyboard focus pauses dismissal')
  await cdp.evaluate(`document.querySelector('.copy-command').focus()`)
  await until(()=>cdp.evaluate(`!document.querySelector('.toast-success')`),'success automatically dismisses after leaving')
  await aria('复制 界面任务 的 PowerShell 命令')
  await aria('关闭提示')
  assert.equal(await cdp.evaluate(`document.activeElement.getAttribute('aria-label')`),'复制 界面任务 的 PowerShell 命令')
  assert.deepEqual(await geometry(),before,'dismissal must also preserve the layout')
  await aria('复制 界面任务 的 PowerShell 命令')
  await until(()=>cdp.evaluate(`!document.querySelector('.toast-success')`),'notification still expires after an earlier manual dismissal')
 })
 await check('modal errors stay visible, wrap and can close without shifting dialog content',async()=>{
  await aria('设置')
  const before=await cdp.evaluate(`document.querySelector('.recent-runs').getBoundingClientRect().top`)
  await cdp.evaluate(`window.toastOriginalFetch=window.fetch;window.fetch=()=>Promise.reject(new Error('通知验证：'+ '长错误消息与路径 '.repeat(35)))`)
  await click('重新加载配置','dialog[open]')
  await cdp.evaluate(`window.fetch=window.toastOriginalFetch;delete window.toastOriginalFetch`)
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('dialog[open] .toast-error[role="alert"]'))`),true,'notification belongs to the active modal top layer')
  assert.equal(await cdp.evaluate(`document.querySelector('.recent-runs').getBoundingClientRect().top`),before)
  assert.equal(await cdp.evaluate(`(()=>{const t=document.querySelector('.toast-error'),r=t.getBoundingClientRect(),b=t.querySelector('button').getBoundingClientRect();return t.scrollWidth<=t.clientWidth&&r.right<=innerWidth&&r.bottom<=innerHeight&&document.elementFromPoint(b.x+b.width/2,b.y+b.height/2).closest('button')===t.querySelector('button')})()`),true)
  await shot('toast-modal-error.png')
  await aria('关闭错误提示');await aria('关闭设置')
 })
 await check('dismissed connection errors do not repeat during polling and reconnect clears the notification',async()=>{
  await cdp.evaluate(`window.toastOriginalFetch=window.fetch;window.fetch=()=>Promise.reject(new Error('隔离断连提示'))`)
  await until(()=>cdp.evaluate(`Boolean(document.querySelector('.connection.offline'))`),'connection failure')
  assert.match(await cdp.evaluate(`document.querySelector('.toast-error').textContent`),/隔离断连提示/)
  await aria('关闭错误提示');await delay(3300)
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('.toast-error'))`),false,'retry does not redisplay dismissed connection error')
  await cdp.evaluate(`window.fetch=window.toastOriginalFetch;delete window.toastOriginalFetch`)
  await until(()=>cdp.evaluate(`!document.querySelector('.connection.offline')`),'connection restored')
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('.toast-error'))`),false)
 })
 await check('groups, favorites and search persist through the real API',async()=>{
  await aria('管理分组');await click('添加分组','dialog[open]');await cdp.evaluate(`(()=>{const el=document.querySelector('[aria-label="分组名称 1"]');el.value='开发辅助';el.dispatchEvent(new Event('input',{bubbles:true}))})()`);await click('保存分组','dialog[open]');await closed('dialog[open]')
  const group=(await app.api('snapshot')).config.groups[0];await fill('分组',group.id);await click('保存配置','.config-form');await until(async()=>(await app.api('snapshot')).config.scripts[0].groupId===group.id,'saved group')
  await aria('收藏 界面任务');await until(async()=>(await app.api('snapshot')).config.scripts[0].favorite,'favorite')
  await cdp.evaluate(`(()=>{const el=document.querySelector('[aria-label="搜索脚本"]');el.value='no-match';el.dispatchEvent(new Event('input',{bubbles:true}))})()`);assert.match(await text(),/没有匹配的脚本/)
  await cdp.evaluate(`(()=>{const el=document.querySelector('[aria-label="搜索脚本"]');el.value='';el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
 })
 let firstRun
 await check('script run, stdout/stderr, terminal state and history selection are real',async()=>{
  await aria('运行 界面任务');firstRun=await until(async()=>(await app.api('snapshot')).runs[0]?.id,'run ID');await completed(app,firstRun);await until(()=>cdp.evaluate(`document.querySelector('.output-body').textContent.includes('ui-result:')`),'real output');assert.match(await cdp.evaluate(`document.querySelector('.output-body').textContent`),/a b 中文/);assert.match(await cdp.evaluate(`document.querySelector('.output-body').textContent`),/ui diagnostic/)
  assert.match(await cdp.evaluate(`document.querySelector('.output-status').textContent`),/退出码 0/);assert.ok(await cdp.evaluate(`document.querySelector('[aria-label="选择运行记录"]').value`))
  await aria('清空当前输出');assert.match(await cdp.evaluate(`document.querySelector('.output-body').textContent`),/当前显示已清空/);await aria('重新读取输出');await until(()=>cdp.evaluate(`document.querySelector('.output-body').textContent.includes('ui-result:')`),'reload persisted output')
  await shot('light.png')
 })
 const slow=script(slowFile,'持续任务');await save(app,c=>c.scripts.push(slow));await until(()=>cdp.evaluate(`document.querySelectorAll('.script-card').length===2`),'new script')
 await check('unsaved draft selection requires a deliberate discard',async()=>{
  await fill('名称','未保存的名称');await cdp.evaluate(`[...document.querySelectorAll('.card-select')].find(b=>b.textContent.includes('持续任务')).click()`);await until(()=>cdp.evaluate(`document.querySelector('.confirm-dialog').open`),'discard confirmation');await click('取消','.confirm-dialog');assert.equal(await cdp.evaluate(`document.querySelector('.config-form input').value`),'未保存的名称')
  await cdp.evaluate(`[...document.querySelectorAll('.card-select')].find(b=>b.textContent.includes('持续任务')).click()`);await click('确认','.confirm-dialog');await until(()=>cdp.evaluate(`document.querySelector('.config-form input').value==='持续任务'`),'new selection')
 })
 let slowRun
 await check('page reload preserves authenticated session and keeps background task running',async()=>{
  await aria('运行 持续任务');slowRun=await until(async()=>(await app.api('snapshot')).runs.find(r=>r.scriptId===slow.id)?.id,'long run')
  await cdp.command('Page.reload');await until(async()=>(await text()).includes('1 个运行中'),'reconnected UI');assert.equal((await app.api('snapshot')).runs.find(r=>r.id===slowRun).state,'running');assert.equal(await cdp.evaluate(`location.hash`),'')
 })
 await check('light/dark and narrow drawer fit the viewport without page overflow',async()=>{
  for(const [width,height,theme,name] of [[1180,840,'light','light-populated.png'],[860,720,'dark','dark.png'],[480,780,'dark','dark-narrow.png']]){
   await cdp.command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await cdp.command('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});await delay(120)
   assert.equal(await cdp.evaluate(`document.documentElement.scrollWidth<=innerWidth`),true,`overflow ${width}`);assert.equal(await cdp.evaluate(`getComputedStyle(document.documentElement).colorScheme`),theme);await shot(name)
   if(width===480){await aria('复制 界面任务 的 PowerShell 命令');assert.equal(await cdp.evaluate(`(()=>{const r=document.querySelector('.toast-success').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`),true);await shot('toast-dark-narrow.png');await aria('关闭提示')}
   if(width<980){await click('脚本配置');assert.equal(await cdp.evaluate(`document.querySelector('.config-panel').getBoundingClientRect().right<=innerWidth`),true);assert.equal(await cdp.evaluate(`Boolean(document.activeElement.closest('.config-form'))`),true);await shot(`drawer-${width}.png`);if(width===860){await cdp.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await until(()=>cdp.evaluate(`!document.querySelector('.config-panel').classList.contains('open')`),'Escape closes drawer');assert.equal(await cdp.evaluate(`document.activeElement.classList.contains('floating-config')`),true)}else await aria('关闭脚本配置')}
  }
  await cdp.command('Emulation.setDeviceMetricsOverride',{width:1180,height:840,deviceScaleFactor:1,mobile:false})
 })
 await check('settings can view any history and stop a running task after config becomes unreadable',async()=>{
  const saved=(await app.api('snapshot')).config;await writeFile(path.join(data,'config.json'),'broken');await app.api('reload');await until(async()=>(await text()).includes('配置不可写'),'read-only config')
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('.toast-error .toast-action'))`),true,'configuration notification keeps its reload action')
  await aria('关闭配置错误提示');await delay(650)
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('.toast-error .toast-action'))`),false,'unchanged configuration error stays dismissed during polling')
  assert.equal(await cdp.evaluate(`document.querySelector('.add-button').disabled`),true);await aria('设置');await click('停止','.dialog[open]');assert.equal((await completed(app,slowRun)).state,'stopped')
  await cdp.evaluate(`[...document.querySelectorAll('.recent-runs .active-run')].find(el=>el.textContent.includes('界面任务')).querySelector('button').click()`);await until(()=>cdp.evaluate(`document.querySelector('.output-body').textContent.includes('ui-result:')`),'historical output')
  await writeFile(path.join(data,'config.json'),JSON.stringify(saved));await app.api('reload');await until(()=>cdp.evaluate(`!document.querySelector('.add-button').disabled`),'config restored')
 })
 await check('remove metadata preserves file and deleted script history remains accessible',async()=>{
  await cdp.evaluate(`[...document.querySelectorAll('.card-select')].find(b=>b.textContent.includes('界面任务')).click()`);await click('移除登记','.config-form');await click('确认','.confirm-dialog');await until(async()=>(await app.api('snapshot')).config.scripts.length===1,'removed registration');assert.match(await readFile(file,'utf8'),/ui-result/)
  await aria('设置');await cdp.evaluate(`[...document.querySelectorAll('.recent-runs .active-run')].find(el=>el.textContent.includes('界面任务')).querySelector('button').click()`);await until(()=>cdp.evaluate(`document.querySelector('.output-body').textContent.includes('ui-result:')`),'removed script history');assert.equal((await app.api('snapshot')).runs.find(r=>r.id===firstRun).state,'succeeded')
 })
 await check('completed scripts without output show a final empty state',async()=>{
  const emptyFile=path.join(root,'empty.mjs');await writeFile(emptyFile,'process.exit(0)');const empty=script(emptyFile,'无输出任务');await save(app,c=>c.scripts.push(empty));await until(()=>cdp.evaluate(`document.body.textContent.includes('无输出任务')`),'empty script card');await aria('运行 无输出任务');await until(async()=>(await app.api('snapshot')).runs.find(r=>r.scriptId===empty.id)?.state==='succeeded','empty script completes');await until(()=>cdp.evaluate(`document.querySelector('.output-body').textContent.includes('此次运行没有输出')`),'final empty output')
 })
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({root,passed:passes.length,errors},null,2))
}finally{cdp?.close();edge.kill();await app.exit()}
