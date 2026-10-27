<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UiIcon from './UiIcon.vue'
import ToastNotifications from './ToastNotifications.vue'
import { powershellCommand } from './command'
import { usePanelLayout } from './usePanelLayout'
import { active, api, fileType, freshScript, runners, states, type Chunk, type Config, type Group, type Logs, type Run, type Script, type Snapshot } from './api'

const data = ref<Snapshot | null>(null)
const selected = ref(''), page = ref('all'), query = ref(''), type = ref('全部类型')
const draft = ref<Script | null>(null), base = ref<Script | null>(null), draftRevision = ref('')
const envText = ref(''), envBase = ref(''), envError = ref('')
const busy = ref(false), loading = ref(true), error = ref(''), notice = ref(''), offline = ref(false), exited = ref(false)
const connectionError = ref('')
const sidebarOpen = ref(false), configOpen = ref(false), outputCollapsed = ref(false)
const ctrlHeld = ref(false)
const launchHint = computed(() => ctrlHeld.value ? '在外部 PowerShell 终端运行（使用已保存配置）' : '运行脚本 · 按住 Ctrl 点击可在外部终端运行')
const outputId = ref(''), chunks = ref<Chunk[]>([]), cursor = ref(0), clipped = ref(false), follow = ref(true)
const logLoaded = ref(false), outputCleared = ref(false)
const outputBody = ref<HTMLElement>(), addDialog = ref<HTMLDialogElement>(), groupsDialog = ref<HTMLDialogElement>(), settingsDialog = ref<HTMLDialogElement>(), helpDialog = ref<HTMLDialogElement>(), confirmDialog = ref<HTMLDialogElement>()
const newScript = ref(freshScript()), groupDrafts = ref<Group[]>([]), guide = ref(''), confirmMessage = ref('')
let confirmAction: (() => void) | null = null
let timer: ReturnType<typeof setTimeout> | undefined, disposed = false, epoch = 0, logGeneration = 0
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const scripts = computed(() => data.value?.config.scripts || [])
const current = computed(() => scripts.value.find(s => s.id === selected.value))
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(base.value) || envText.value !== envBase.value)
const writable = computed(() => !!data.value && !data.value.configError && !data.value.closing && !exited.value)
const visible = computed(() => scripts.value.filter(s => {
  const match = page.value === 'all' || page.value === 'favorites' && s.favorite || page.value === 'ungrouped' && !s.groupId || s.groupId === page.value
  return match && (type.value === '全部类型' || fileType(s) === type.value) && `${s.name} ${s.path} ${s.description}`.toLowerCase().includes(query.value.toLowerCase())
}))
const pageTitle = computed(() => page.value === 'all' ? '所有脚本' : page.value === 'favorites' ? '收藏' : page.value === 'ungrouped' ? '未分组' : data.value?.config.groups.find(g => g.id === page.value)?.name || '所有脚本')
const history = computed(() => data.value?.runs.filter(r => r.scriptId === (data.value?.runs.find(r => r.id === outputId.value)?.scriptId || selected.value)) || [])
const outputRun = computed(() => history.value.find(r => r.id === outputId.value) || history.value[0])
const running = computed(() => data.value?.runs.filter(active) || [])
const types = computed(() => [...new Set(scripts.value.map(fileType))])
const currentActive = computed(() => data.value?.runs.find(r => r.scriptId === selected.value && active(r)))
const preview = computed(() => draft.value ? powershellCommand(draft.value) : '')
const duration = (r: Run) => `${Math.max(0, Math.floor(((r.endedAt || Date.now()) - r.startedAt) / 1000))} 秒`
const date = (value: number) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const latest = (id: string) => data.value?.runs.find(r => r.scriptId === id)

function resetDraft() { draft.value = current.value ? copy(current.value) : null; base.value = draft.value ? copy(draft.value) : null; draftRevision.value = data.value?.revision || ''; envText.value = Object.entries(draft.value?.env || {}).map(([k,v]) => `${k}=${v}`).join('\n'); envBase.value = envText.value; envError.value = '' }
watch(current, () => { if (!dirty.value || draft.value?.id !== selected.value) resetDraft() })
watch(selected, () => { outputId.value = ''; resetDraft() })
watch(() => outputRun.value?.id, () => { logGeneration++; cursor.value = 0; chunks.value = []; clipped.value = false; follow.value = true; logLoaded.value = false; outputCleared.value = false })
function install(snapshot: Snapshot) {
  data.value = snapshot
  if (!scripts.value.some(s => s.id === selected.value) && !dirty.value) selected.value = scripts.value[0]?.id || ''
  if (page.value !== 'all' && page.value !== 'favorites' && page.value !== 'ungrouped' && !snapshot.config.groups.some(g => g.id === page.value)) page.value = 'all'
}
async function refresh() { install(await api<Snapshot>('snapshot')); offline.value = false; connectionError.value = '' }
async function perform(action: () => Promise<void>) {
  if (busy.value || exited.value) return
  busy.value = true; epoch++; error.value = ''; notice.value = ''
  try { await action() } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { epoch++; busy.value = false }
}
function confirm(message: string, action: () => void) { confirmMessage.value = message; confirmAction = action; confirmDialog.value?.showModal() }
function acceptConfirm() { confirmDialog.value?.close(); const action = confirmAction; confirmAction = null; action?.() }
function guard(action: () => void) {
  if (dirty.value) confirm('放弃尚未保存的脚本配置？', () => { resetDraft(); action() })
  else action()
}
function selectScript(id: string) { if (selected.value !== id) guard(() => { selected.value = id; sidebarOpen.value = false }) }
async function saveConfig(config: Config, revision = data.value?.revision || '') { install(await api<Snapshot>('save', { config, revision })) }
function saveScript() { void perform(async () => {
  if (envError.value) throw Error(envError.value)
  if (!draft.value || !data.value) return
  if (!scripts.value.some(s => s.id === draft.value?.id)) throw Error('脚本已被其他页面移除，请放弃草稿并重新加载。')
  const config = copy(data.value.config), saved = copy(draft.value)
  config.scripts = config.scripts.map(s => s.id === saved.id ? saved : s)
  await saveConfig(config, draftRevision.value); resetDraft(); notice.value = '配置已保存'
}) }
function favorite(script: Script) { guard(() => void perform(async () => { const config = copy(data.value!.config); config.scripts.find(s => s.id === script.id)!.favorite = !script.favorite; await saveConfig(config); resetDraft() })) }
function removeScript() {
  if (!current.value) return
  const id = current.value.id, name = current.value.name
  confirm(`移除“${name}”的登记？原始脚本文件和运行历史会保留。`, () => void perform(async () => {
    const config = copy(data.value!.config); config.scripts = config.scripts.filter(s => s.id !== id)
    await saveConfig(config); selected.value = scripts.value[0]?.id || ''; resetDraft(); notice.value = '已移除登记'
  }))
}
function addScript() { void perform(async () => {
  const config = copy(data.value!.config); config.scripts.push(copy(newScript.value))
  await saveConfig(config); selected.value = newScript.value.id; resetDraft(); addDialog.value?.close(); configOpen.value = true; notice.value = '脚本已添加'
}) }
function openAdd() { guard(() => { newScript.value = freshScript(); if (data.value?.config.groups.some(g => g.id === page.value)) newScript.value.groupId = page.value; addDialog.value?.showModal() }) }
function pickFile(target: Script) { void perform(async () => { const result = await api<{ path: string | null }>('file.pick'); if (result.path) { target.path = result.path; if (!target.name) target.name = freshScript(result.path).name } }) }
function openGroups() { guard(() => { groupDrafts.value = copy(data.value!.config.groups); groupsDialog.value?.showModal() }) }
function addGroup() { groupDrafts.value.push({ id: crypto.randomUUID(), name: '' }) }
function viewHistory(run: Run) { outputId.value = run.id; outputCollapsed.value = false; settingsDialog.value?.close() }
function saveGroups() { void perform(async () => {
  const config = copy(data.value!.config); config.groups = copy(groupDrafts.value)
  config.scripts.forEach(s => { if (!config.groups.some(g => g.id === s.groupId)) s.groupId = null })
  await saveConfig(config); resetDraft(); groupsDialog.value?.close(); notice.value = '分组已保存'
}) }
function runScript(script: Script, event: MouseEvent) {
  // Capture the modifier before a draft confirmation or asynchronous work.
  const external = event.ctrlKey || ctrlHeld.value
  guard(() => void perform(async () => {
    if (external) {
      await api('run.terminal', { scriptId: script.id })
      notice.value = '已打开外部终端，运行与停止请在终端中操作'
      return
    }
    selected.value = script.id; outputCollapsed.value = false; const result = await api<{ runId: string }>('run.start', { scriptId: script.id }); await refresh(); outputId.value = result.runId
  }))
}
function syncControl(event: KeyboardEvent | MouseEvent) { ctrlHeld.value = event.ctrlKey }
function resetControl() { ctrlHeld.value = false }
function visibilityChanged() { if (document.hidden) resetControl() }
function stopRun(run: Run) { void perform(async () => { await api('run.stop', { runId: run.id }); await refresh() }) }
async function poll() {
  if (disposed || exited.value) return
  const generation = epoch
  try {
    if (!busy.value) {
      const snapshot = await api<Snapshot>('snapshot')
      if (generation === epoch && !disposed) install(snapshot)
      const runId = outputRun.value?.id, logEpoch = logGeneration
      if (runId) {
        const result = await api<Logs>('run.logs', { runId, cursor: cursor.value })
        if (logEpoch === logGeneration && outputRun.value?.id === runId && !disposed) {
          logLoaded.value = true
          cursor.value = result.cursor; clipped.value ||= result.truncated
          for (const chunk of result.chunks) chunks.value.push({ ...chunk, text: chunk.text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') })
          let size = chunks.value.reduce((sum, c) => sum + c.text.length, 0)
          while (size > 200000 && chunks.value.length > 1) { size -= chunks.value.shift()!.text.length; clipped.value = true }
          if (follow.value) { await nextTick(); scrollOutput() }
        }
      }
      if (generation === epoch && !disposed) { offline.value = false; connectionError.value = '' }
    }
  } catch (e) { if (!disposed && generation === epoch) { if (!offline.value) connectionError.value = e instanceof Error ? e.message : String(e); offline.value = true } }
  finally { loading.value = false; if (!disposed && !exited.value) timer = setTimeout(poll, offline.value ? 3000 : document.hidden ? 1500 : 500) }
}
function scrollOutput() { const el = outputBody.value; if (el) el.scrollTop = el.scrollHeight }
function onOutputScroll() { const el = outputBody.value; if (el) follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48 }
function clearOutput() { chunks.value = []; clipped.value = false; outputCleared.value = true }
function reloadOutput() { logGeneration++; cursor.value = 0; chunks.value = []; clipped.value = false; follow.value = true; logLoaded.value = false; outputCleared.value = false }
function openConfig() { configOpen.value = true; void nextTick(() => document.querySelector<HTMLInputElement>('.config-form input')?.focus()) }
function closeConfig() { configOpen.value = false; void nextTick(() => document.querySelector<HTMLButtonElement>('.floating-config')?.focus()) }
function escapePanel(event: KeyboardEvent) { if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return; if (configOpen.value) closeConfig(); if (sidebarOpen.value) { sidebarOpen.value = false; document.querySelector<HTMLButtonElement>('.mobile-menu')?.focus() } }
function copyOutput() { void perform(async () => { await navigator.clipboard.writeText(chunks.value.map(c => c.text).join('')); notice.value = '当前输出已复制' }) }
function copyCommand(script: Script) { void perform(async () => {
  const command = powershellCommand(script)
  if (!command) throw Error('请检查脚本路径、启动方式及参数后再复制。')
  try { await navigator.clipboard.writeText(command) }
  catch { throw Error('无法写入剪贴板，请从高级配置的启动预览中手动复制。') }
  notice.value = 'PowerShell 启动命令已复制'
}) }
function openHelp() { void perform(async () => { const response = await fetch('/guide'); if (!response.ok) throw Error('无法读取使用说明。'); guide.value = await response.text(); helpDialog.value?.showModal() }) }
function shutdown() { confirm(`退出后台并停止全部 ${running.value.length} 个托管任务？连接到同一实例的其他页面也会断开。`, () => void perform(async () => {
  await api('shutdown'); exited.value = true; settingsDialog.value?.close(); clearTimeout(timer); notice.value = '后台已退出，可以关闭此页面。'
})) }
function updateArg(index: number, event: Event, interpreter = false) { const values = interpreter ? draft.value!.interpreterArgs : draft.value!.args; values[index] = (event.target as HTMLInputElement).value }
function setEnv(event: Event) {
  const text = (event.target as HTMLTextAreaElement).value, values: Record<string, string> = {}
  envText.value = text
  for (const line of text.split('\n')) { if (!line.trim()) continue; const i = line.indexOf('='); if (i < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0,i))) { envError.value = '每行使用 NAME=value 格式，名称只含字母、数字与下划线。'; return } values[line.slice(0, i)] = line.slice(i + 1) }
  envError.value = ''; draft.value!.env = values
}
const backdrop = new WeakMap<EventTarget, boolean>()
function outside(event: MouseEvent) { const el = event.currentTarget as HTMLElement, r = el.getBoundingClientRect(); return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom }
function markBackdrop(event: PointerEvent) { if (event.currentTarget) backdrop.set(event.currentTarget, outside(event)) }
function dismissBackdrop(event: MouseEvent) { if (event.currentTarget && backdrop.get(event.currentTarget) && outside(event)) (event.currentTarget as HTMLDialogElement).close() }
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }

const { studio, header, layout, ready: layoutReady, maximum: layoutMaximum, resizingPanel, startResize, resizeKey, reset: resetPanel } = usePanelLayout(message => { error.value = message })

onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload); window.addEventListener('keydown', escapePanel)
  window.addEventListener('keydown', syncControl); window.addEventListener('keyup', syncControl)
  window.addEventListener('pointermove', syncControl); window.addEventListener('blur', resetControl)
  document.addEventListener('visibilitychange', visibilityChanged); void poll()
})
onBeforeUnmount(() => {
  disposed = true; clearTimeout(timer); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('keydown', escapePanel)
  window.removeEventListener('keydown', syncControl); window.removeEventListener('keyup', syncControl)
  window.removeEventListener('pointermove', syncControl); window.removeEventListener('blur', resetControl)
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<template>
  <div ref="studio" class="studio" :class="{ 'is-resizing': resizingPanel }" :style="{ '--sidebar-w': layout.sidebarWidth + 'px', '--config-w': layout.configWidth + 'px', '--output-h': (outputCollapsed ? 42 : layout.outputHeight) + 'px' }">
    <header ref="header" class="app-header">
      <button class="icon-button mobile-menu" aria-label="展开分组" :aria-expanded="sidebarOpen" @click="sidebarOpen = !sidebarOpen"><UiIcon name="menu" /></button>
      <div class="brand"><UiIcon name="terminal" :size="23" /><strong>Script Studio</strong><span>本地脚本</span></div>
      <span class="connection" :class="{ offline }"><i />{{ exited ? '已退出' : offline ? '连接中断' : loading ? '正在连接' : `${running.length} 个运行中` }}</span>
      <div class="header-actions"><button class="icon-button" aria-label="使用说明" title="使用说明" @click="openHelp"><UiIcon name="book" /></button><button class="icon-button" aria-label="设置" title="设置" @click="settingsDialog?.showModal()"><UiIcon name="settings" /></button><button class="primary add-button" :disabled="!writable || busy" @click="openAdd"><UiIcon name="plus" />添加脚本</button></div>
    </header>
    <ToastNotifications :notice="notice" :error="error || connectionError" :config-error="data?.configError" :data-directory="data?.dataDirectory" :busy="busy"
      @close-notice="notice = ''" @close-error="error ? error = '' : connectionError = ''"
      @reload="perform(async () => { install(await api<Snapshot>('reload')); resetDraft() })" />
    <div class="workspace">
      <aside id="script-categories" class="sidebar" :class="{ open: sidebarOpen }" aria-label="脚本分类">
        <div class="section-label">工作空间</div>
        <button class="nav-item" :class="{ selected: page === 'all' }" @click="page = 'all'; sidebarOpen = false"><UiIcon name="grid" />所有脚本<span>{{ scripts.length }}</span></button>
        <button class="nav-item" :class="{ selected: page === 'favorites' }" @click="page = 'favorites'; sidebarOpen = false"><UiIcon name="star" />收藏<span>{{ scripts.filter(s => s.favorite).length }}</span></button>
        <div class="section-label groups-label">分组<button class="icon-button" aria-label="管理分组" title="管理分组" :disabled="!writable || busy" @click="openGroups"><UiIcon name="settings" :size="14" /></button></div>
        <div class="group-list"><button v-for="group in data?.config.groups || []" :key="group.id" class="nav-item" :class="{ selected: page === group.id }" @click="page = group.id; sidebarOpen = false"><UiIcon name="folder" /><span class="group-name" :title="group.name">{{ group.name }}</span><span>{{ scripts.filter(s => s.groupId === group.id).length }}</span></button><button class="nav-item" :class="{ selected: page === 'ungrouped' }" @click="page = 'ungrouped'; sidebarOpen = false"><UiIcon name="folder" />未分组<span>{{ scripts.filter(s => !s.groupId).length }}</span></button></div>
        <div class="local-info"><i /><span>本地工作空间</span><button title="查看数据目录" @click="settingsDialog?.showModal()">配置与历史</button></div>
      </aside>
      <div class="resize-handle-v resize-handle-sidebar" :class="{ 'is-resizing': resizingPanel === 'sidebar' }"
        title="拖动或方向键调整分类栏宽度，双击或 Enter 复位" aria-label="调整分类栏宽度" role="separator"
        :tabindex="layoutReady ? 0 : -1" :aria-disabled="!layoutReady" aria-controls="script-categories" aria-orientation="vertical"
        :aria-valuenow="layout.sidebarWidth" :aria-valuemin="160" :aria-valuemax="layoutMaximum.sidebar"
        @pointerdown="startResize('sidebar', $event)" @keydown="resizeKey('sidebar', $event)" @dblclick="resetPanel('sidebar')" />
      <main class="script-list">
        <div class="list-heading"><h1>{{ pageTitle }}<span>{{ visible.length }}</span></h1><select v-model="type" aria-label="筛选脚本类型"><option>全部类型</option><option v-for="item in types" :key="item">{{ item }}</option></select></div>
        <label class="search"><UiIcon name="search" :size="16" /><input v-model="query" aria-label="搜索脚本" placeholder="搜索名称、路径或备注…" type="search" /></label>
        <div class="cards">
          <div v-if="loading" class="empty">正在连接本地后台…</div>
          <article v-for="script in visible" :key="script.id" class="script-card" :class="{ 'is-selected': selected === script.id }">
            <button class="card-select" :aria-pressed="selected === script.id" @click="selectScript(script.id)"><strong>{{ script.name }}</strong><span class="filename" :title="script.path">{{ script.path.split(/[\\/]/).at(-1) }}</span><span v-if="script.description" class="description">{{ script.description }}</span></button>
            <div class="card-actions"><button class="icon-button copy-command" :aria-label="`复制 ${script.name} 的 PowerShell 命令`" title="复制 PowerShell 命令" :disabled="busy || !powershellCommand(script)" @click="copyCommand(script)"><UiIcon name="copy" :size="16" /></button><button v-if="active(latest(script.id))" class="run-button stop" :disabled="busy || latest(script.id)?.state === 'stopping'" :aria-label="`停止 ${script.name}`" title="停止脚本" @click="stopRun(latest(script.id)!)"><UiIcon name="stop" :size="15" /></button><button v-else class="run-button" :class="{ 'external-launch': ctrlHeld }" :disabled="!writable || busy" :aria-label="ctrlHeld ? `在外部终端运行 ${script.name}` : `运行 ${script.name}`" :title="launchHint" @click="runScript(script, $event)"><UiIcon :name="ctrlHeld ? 'terminal' : 'play'" :size="16" /></button></div>
            <div class="card-bottom"><span class="run-state" :class="latest(script.id)?.state || 'idle'"><i />{{ latest(script.id) ? states[latest(script.id)!.state] : '未运行' }}</span><span class="type-badge">{{ fileType(script) }}</span><button class="favorite icon-button" :class="{ on: script.favorite }" :aria-label="`${script.favorite ? '取消收藏' : '收藏'} ${script.name}`" :aria-pressed="script.favorite" :disabled="!writable || busy" @click="favorite(script)"><UiIcon name="star" :size="16" /></button></div>
          </article>
          <div v-if="!loading && !visible.length" class="empty"><UiIcon name="code" :size="32" /><strong>{{ scripts.length ? '没有匹配的脚本' : '添加你的第一个脚本' }}</strong><p>{{ scripts.length ? '调整搜索或筛选条件。' : '将常用脚本放在一处，随时运行。' }}</p><button v-if="!scripts.length" class="primary" :disabled="!writable || busy" @click="openAdd"><UiIcon name="plus" />添加脚本</button></div>
        </div>
      </main>
      <div class="resize-handle-v resize-handle-config" :class="{ 'is-resizing': resizingPanel === 'config' }"
        title="拖动或方向键调整配置面板宽度，双击或 Enter 复位" aria-label="调整配置面板宽度" role="separator"
        :tabindex="layoutReady ? 0 : -1" :aria-disabled="!layoutReady" aria-controls="script-config" aria-orientation="vertical"
        :aria-valuenow="layout.configWidth" :aria-valuemin="260" :aria-valuemax="layoutMaximum.config"
        @pointerdown="startResize('config', $event)" @keydown="resizeKey('config', $event)" @dblclick="resetPanel('config')" />
      <aside id="script-config" class="config-panel" :class="{ open: configOpen }" aria-label="脚本配置">
        <div class="config-heading"><h2>脚本配置<span v-if="dirty" class="dirty-dot" title="尚未保存" /></h2><button class="icon-button config-close" aria-label="关闭脚本配置" @click="closeConfig"><UiIcon name="close" /></button></div>
        <form v-if="draft" class="config-form" @submit.prevent="saveScript">
          <fieldset :disabled="!writable || busy">
            <label>名称<input v-model="draft.name" required maxlength="80" /></label>
            <label>脚本文件<div class="input-action"><input v-model="draft.path" required placeholder="本地文件绝对路径" /><button type="button" class="icon-button" aria-label="选择脚本文件" @click="pickFile(draft)"><UiIcon name="folder" :size="16" /></button></div></label>
            <div class="field-row"><label>分组<select v-model="draft.groupId"><option :value="null">未分组</option><option v-for="group in data?.config.groups" :key="group.id" :value="group.id">{{ group.name }}</option></select></label><label>启动方式<select v-model="draft.runner"><option v-for="(label, value) in runners" :key="value" :value="value">{{ label }}</option></select></label></div>
            <template v-if="draft.runner === 'custom'"><label>解释器<input v-model="draft.program" required placeholder="例如 pwsh.exe 或完整路径" /></label><div class="argument-field"><div class="field-title">解释器参数<button type="button" @click="draft.interpreterArgs.push('')">＋ 添加</button></div><div v-for="(arg, i) in draft.interpreterArgs" :key="i" class="input-action"><input :value="arg" :aria-label="`解释器参数 ${i + 1}`" @input="updateArg(i, $event, true)" /><button type="button" class="icon-button" :aria-label="`移除解释器参数 ${i + 1}`" @click="draft.interpreterArgs.splice(i, 1)"><UiIcon name="close" :size="14" /></button></div></div></template>
            <div class="argument-field"><div class="field-title">启动参数<button type="button" @click="draft.args.push('')">＋ 添加参数</button></div><div v-if="!draft.args.length" class="field-hint">每项单独传递，空格无需加引号。</div><div v-for="(arg, i) in draft.args" :key="i" class="input-action"><input :value="arg" :aria-label="`启动参数 ${i + 1}`" placeholder="空白表示一个空参数" @input="updateArg(i, $event)" /><button type="button" class="icon-button" :aria-label="`移除启动参数 ${i + 1}`" @click="draft.args.splice(i, 1)"><UiIcon name="close" :size="14" /></button></div></div>
            <label>工作目录<input :value="draft.cwd || ''" placeholder="默认使用脚本所在目录" @input="draft.cwd = ($event.target as HTMLInputElement).value || null" /></label>
            <label>备注<textarea v-model="draft.description" rows="2" maxlength="2000" placeholder="这个脚本做什么…" /></label>
            <details class="advanced"><summary>高级配置</summary><label>输出编码<select v-model="draft.encoding"><option value="utf8">UTF-8</option><option value="system">系统 OEM 代码页</option></select></label><label>环境变量<textarea :value="envText" aria-label="环境变量" :aria-invalid="!!envError" aria-describedby="env-error" rows="3" placeholder="NAME=value，每行一项" @input="setEnv" /><span v-if="envError" id="env-error" class="dialog-error" role="alert">{{ envError }}</span></label><div class="field-title">启动预览（PowerShell）<button type="button" :disabled="busy || !preview || !!envError" @click="copyCommand(draft)">复制命令</button></div><code class="command-preview">{{ preview || '请检查脚本路径、启动方式及参数。' }}</code><p class="field-hint">仅复制启动命令，工作目录和环境变量沿用目标终端。</p></details>
          </fieldset>
          <div class="config-actions"><button class="primary" type="submit" :disabled="!dirty || !!envError || !writable || busy"><UiIcon name="check" :size="16" />保存配置</button><button type="button" :disabled="!dirty || busy" @click="resetDraft">放弃修改</button></div>
          <button class="danger remove-registration" type="button" :disabled="!writable || busy || !!currentActive" @click="removeScript"><UiIcon name="trash" :size="14" />移除登记</button>
        </form><div v-else class="empty config-empty"><UiIcon name="settings" :size="28" /><p>选择脚本以查看配置。</p></div>
      </aside>
    </div>
    <button v-if="current" class="floating-config" @click="openConfig"><UiIcon name="settings" :size="16" />脚本配置<span v-if="dirty" class="dirty-dot" /></button>
    <section id="script-output" class="output-panel" :class="{ collapsed: outputCollapsed }" aria-label="运行输出">
      <div v-if="!outputCollapsed" class="resize-handle-output" :class="{ 'is-resizing': resizingPanel === 'output' }"
        title="拖动或方向键调整输出面板高度，双击或 Enter 复位" aria-label="调整输出面板高度" role="separator"
        :tabindex="layoutReady ? 0 : -1" :aria-disabled="!layoutReady" aria-controls="script-output" aria-orientation="horizontal"
        :aria-valuenow="layout.outputHeight" :aria-valuemin="110" :aria-valuemax="layoutMaximum.output"
        @pointerdown="startResize('output', $event)" @keydown="resizeKey('output', $event)" @dblclick="resetPanel('output')" />
      <div class="output-heading"><UiIcon name="terminal" /><strong>运行输出</strong><select v-if="history.length" :value="outputRun?.id" aria-label="选择运行记录" @change="outputId = ($event.target as HTMLSelectElement).value"><option v-for="run in history" :key="run.id" :value="run.id">{{ run.snapshot.name }} · {{ date(run.startedAt) }} · {{ states[run.state] }}</option></select><span v-else class="muted">{{ current?.name || '尚未选择脚本' }}</span><div class="output-tools"><button v-if="outputRun && active(outputRun)" class="stop-action" :disabled="busy || outputRun.state === 'stopping'" @click="stopRun(outputRun)"><UiIcon name="stop" :size="14" />停止</button><button class="icon-button" aria-label="复制当前输出" title="复制当前输出" :disabled="!chunks.length || busy" @click="copyOutput"><UiIcon name="copy" :size="15" /></button><button class="icon-button" aria-label="重新读取输出" title="从历史重新读取当前输出" :disabled="!outputRun" @click="reloadOutput"><UiIcon name="refresh" :size="15" /></button><button class="icon-button" aria-label="清空当前输出" title="清空当前显示，保留历史" @click="clearOutput"><UiIcon name="trash" :size="15" /></button><button class="icon-button" :aria-label="outputCollapsed ? '展开运行输出' : '收起运行输出'" :aria-expanded="!outputCollapsed" @click="outputCollapsed = !outputCollapsed"><UiIcon :name="outputCollapsed ? 'plus' : 'down'" :size="17" /></button></div></div>
      <template v-if="!outputCollapsed"><div v-if="outputRun" class="output-status"><span class="run-state" :class="outputRun.state"><i />{{ states[outputRun.state] }}</span><span>{{ duration(outputRun) }}</span><span v-if="outputRun.exitCode !== null">退出码 {{ outputRun.exitCode }}</span><span v-if="clipped" class="warning-text">输出已截断；清空显示不删除历史</span><span v-if="!follow" class="output-jump"><button @click="follow = true; scrollOutput()">查看最新输出 ↓</button></span></div><div ref="outputBody" class="output-body" tabindex="0" aria-label="脚本输出内容" @scroll="onOutputScroll"><pre v-if="chunks.length"><span v-for="(chunk, i) in chunks" :key="i" :class="chunk.stream">{{ chunk.text }}</span></pre><div v-else class="output-empty">{{ !outputRun ? '选择一个脚本，点击运行。' : outputCleared ? '当前显示已清空，点击“重新读取输出”查看历史。' : !logLoaded ? '正在读取运行输出…' : active(outputRun) ? '等待输出…' : '此次运行没有输出。' }}</div><div v-if="outputRun?.error" class="run-error">{{ outputRun.error }}</div></div></template>
    </section>

    <dialog ref="addDialog" class="dialog" aria-labelledby="add-title" @pointerdown="markBackdrop" @click="dismissBackdrop"><form @submit.prevent="addScript"><div class="dialog-heading"><h2 id="add-title">添加脚本</h2><button type="button" class="icon-button" aria-label="关闭添加脚本" @click="addDialog?.close()"><UiIcon name="close" /></button></div><fieldset :disabled="busy"><label>脚本文件<div class="input-action"><input v-model="newScript.path" required placeholder="例如 C:\Scripts\backup.ps1" /><button type="button" class="icon-button" aria-label="选择本地脚本" @click="pickFile(newScript)"><UiIcon name="folder" /></button></div></label><label>脚本名称<input v-model="newScript.name" required maxlength="80" placeholder="例如：数据库备份" /></label><label>分组<select v-model="newScript.groupId"><option :value="null">未分组</option><option v-for="group in data?.config.groups" :key="group.id" :value="group.id">{{ group.name }}</option></select></label></fieldset><p class="field-hint">登记本地路径，脚本文件保留在原位置。</p><div class="dialog-actions"><button type="button" @click="addDialog?.close()">取消</button><button class="primary" :disabled="busy || !writable" type="submit">添加到工作空间</button></div></form></dialog>
    <dialog ref="groupsDialog" class="dialog" aria-labelledby="groups-title" @pointerdown="markBackdrop" @click="dismissBackdrop"><form @submit.prevent="saveGroups"><div class="dialog-heading"><h2 id="groups-title">管理分组</h2><button type="button" class="icon-button" aria-label="关闭分组管理" @click="groupsDialog?.close()"><UiIcon name="close" /></button></div><p class="field-hint">移除分组后，脚本移入“未分组”。</p><div class="group-editor"><div v-for="(group, i) in groupDrafts" :key="group.id" class="input-action"><input v-model="group.name" :aria-label="`分组名称 ${i + 1}`" required maxlength="80" /><button type="button" class="icon-button danger" :aria-label="`移除分组 ${group.name}`" @click="groupDrafts.splice(i, 1)"><UiIcon name="trash" :size="16" /></button></div></div><button type="button" class="text-button" @click="addGroup"><UiIcon name="plus" :size="16" />添加分组</button><div class="dialog-actions"><button type="button" @click="groupsDialog?.close()">取消</button><button type="submit" class="primary" :disabled="busy || !writable">保存分组</button></div></form></dialog>
    <dialog ref="settingsDialog" class="dialog" aria-labelledby="settings-title" @pointerdown="markBackdrop" @click="dismissBackdrop"><div class="dialog-heading"><h2 id="settings-title">设置与运行管理</h2><button class="icon-button" aria-label="关闭设置" @click="settingsDialog?.close()"><UiIcon name="close" /></button></div><label>数据目录<code class="data-path">{{ data?.dataDirectory || '尚未连接' }}</code></label><p class="field-hint">最近 100 次运行 · 每次日志最多 10 MiB</p><button class="text-button" :disabled="busy" @click="guard(() => perform(async () => { install(await api<Snapshot>('reload')); resetDraft(); notice = '配置已重新加载' }))"><UiIcon name="refresh" :size="16" />重新加载配置</button><h3>运行中的脚本 <span class="muted">{{ running.length }}</span></h3><div v-for="run in running" :key="run.id" class="active-run"><div><strong>{{ run.snapshot.name }}</strong><small>{{ duration(run) }}</small></div><button :disabled="busy || run.state === 'stopping'" @click="stopRun(run)">{{ run.state === 'stopping' ? '正在停止' : '停止' }}</button></div><p v-if="!running.length" class="muted">没有正在运行的脚本。</p><h3>最近运行</h3><div class="recent-runs"><div v-for="run in data?.runs || []" :key="run.id" class="active-run"><div><strong>{{ run.snapshot.name }}</strong><small>{{ date(run.startedAt) }} · {{ states[run.state] }}</small></div><button @click="viewHistory(run)">查看</button></div></div><p v-for="warning in data?.warnings || []" :key="warning" class="dialog-error">{{ warning }}</p><div class="dialog-actions"><button class="danger" :disabled="busy || exited" @click="shutdown">退出后台</button><button class="primary" @click="settingsDialog?.close()">完成</button></div></dialog>
    <dialog ref="helpDialog" class="dialog help-dialog" aria-labelledby="help-title" @pointerdown="markBackdrop" @click="dismissBackdrop"><div class="dialog-heading"><h2 id="help-title">使用说明</h2><button class="icon-button" aria-label="关闭使用说明" @click="helpDialog?.close()"><UiIcon name="close" /></button></div><pre class="guide">{{ guide }}</pre></dialog>
    <dialog ref="confirmDialog" class="dialog confirm-dialog" aria-labelledby="confirm-title" @pointerdown="markBackdrop" @click="dismissBackdrop"><h2 id="confirm-title">确认操作</h2><p>{{ confirmMessage }}</p><div class="dialog-actions"><button @click="confirmDialog?.close()">取消</button><button class="primary" @click="acceptConfirm">确认</button></div></dialog>
  </div>
</template>
