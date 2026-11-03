<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UiIcon from './UiIcon.vue'
import ActionMenu from './ActionMenu.vue'
import SplitRunButton from './SplitRunButton.vue'
import EnvEditor from './EnvEditor.vue'
import { highlight, logLines, parseEnvironment, runSession, readPreference, writePreference, type RunMode } from './studioState'
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
const sidebarOpen = ref(false), configOpen = ref(false), outputCollapsed = ref(true), outputMaximized = ref(false)
const ctrlHeld = ref(false)
const legacyView = readPreference('view')
const runModes = ref<Record<string, RunMode>>({})
const savedModes = readPreference('run-modes')
if (savedModes && typeof savedModes === 'object' && !Array.isArray(savedModes)) {
  for (const [id, mode] of Object.entries(savedModes)) if (mode === 'managed' || mode === 'external') runModes.value[id] = mode
}
const now = ref(Date.now())
let clockTimer: ReturnType<typeof setInterval> | undefined
const streamFilter = ref('all'), logQuery = ref(''), searchOpen = ref(false), logSearch = ref<HTMLInputElement>()
const visibleLines = computed(() => logLines(chunks.value).filter(line =>
  (streamFilter.value === 'all' || line.stream === streamFilter.value) && line.text.toLowerCase().includes(logQuery.value.toLowerCase())))
function setOutputSize(mode: 'collapsed' | 'standard' | 'maximized') {
  outputCollapsed.value = mode === 'collapsed'; outputMaximized.value = mode === 'maximized'
  if (mode === 'maximized') configOpen.value = false
}
function searchLogs() { if (outputCollapsed.value) setOutputSize('standard'); searchOpen.value = true; void nextTick(() => logSearch.value?.focus()) }
function consoleKey(event: KeyboardEvent) {
  if (document.querySelector('dialog[open]')) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); searchLogs() }
  if (event.key === 'Escape' && searchOpen.value) { event.preventDefault(); event.stopPropagation(); searchOpen.value = false; logQuery.value = ''; document.querySelector<HTMLButtonElement>('[aria-label="搜索日志"]')?.focus() }
  else if (event.key === 'Escape' && outputMaximized.value) { event.preventDefault(); event.stopPropagation(); setOutputSize('standard'); document.querySelector<HTMLButtonElement>('[aria-label="标准输出高度"]')?.focus() }
}
function navigateScripts(event: KeyboardEvent) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !(event.target as HTMLElement).matches('.card-select')) return
  event.preventDefault()
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.card-select')], index = buttons.indexOf(event.target as HTMLButtonElement)
  buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
}
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
const historyItems = computed(() => history.value.map(run => ({ id: run.id, label: `${run.snapshot.name} · ${date(run.startedAt)} · ${states[run.state]}`, icon: 'clock' })))
const outputRun = computed(() => {
  if (outputId.value) {
    return history.value.find(r => r.id === outputId.value) || data.value?.runs.find(r => r.id === outputId.value)
  }
  if (currentActive.value) {
    return currentActive.value
  }
  return undefined
})
const running = computed(() => data.value?.runs.filter(active) || [])
const types = computed(() => [...new Set(scripts.value.map(fileType))])
const currentActive = computed(() => data.value?.runs.find(r => r.scriptId === selected.value && active(r)))
const preview = computed(() => draft.value ? powershellCommand(draft.value) : '')
const duration = (r: Run) => `${Math.max(0, Math.floor(((r.endedAt ?? now.value) - r.startedAt) / 1000))} 秒`
const elapsed = (r: Run) => { const seconds = Math.max(0, Math.floor(((r.endedAt ?? now.value) - r.startedAt) / 1000)); return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}` }
const date = (value: number) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const historicalRunIds = ref(new Set<string>())
const latest = (id: string) => data.value?.runs.find(r => r.scriptId === id && (active(r) || !historicalRunIds.value.has(r.id)))

function resetDraft() { draft.value = current.value ? copy(current.value) : null; base.value = draft.value ? copy(draft.value) : null; draftRevision.value = data.value?.revision || ''; envText.value = Object.entries(draft.value?.env || {}).map(([k,v]) => `${k}=${v}`).join('\n'); envBase.value = envText.value; envError.value = '' }
watch(current, () => { if (!dirty.value || draft.value?.id !== selected.value) resetDraft() })
watch(selected, () => { outputId.value = ''; resetDraft() })
watch(() => outputRun.value?.id, () => { logGeneration++; cursor.value = 0; chunks.value = []; clipped.value = false; follow.value = true; logLoaded.value = false; outputCleared.value = false })
function install(snapshot: Snapshot) {
  if (data.value?.instance !== snapshot.instance) {
    const session = runSession(snapshot.instance, snapshot.runs, readPreference('run-session'))
    historicalRunIds.value = new Set(session.historicalRunIds)
    writePreference('run-session', session)
    outputId.value = ''; outputCollapsed.value = true; outputMaximized.value = false
  }
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
function loadHistory(run?: Run) {
  const target = run || history.value[0] || data.value?.runs.find(r => r.scriptId === selected.value)
  if (!target) return
  outputId.value = target.id
  outputCollapsed.value = false
  reloadOutput()
}
function viewHistory(run: Run) { loadHistory(run); settingsDialog.value?.close() }
function saveGroups() { void perform(async () => {
  const config = copy(data.value!.config); config.groups = copy(groupDrafts.value)
  config.scripts.forEach(s => { if (!config.groups.some(g => g.id === s.groupId)) s.groupId = null })
  await saveConfig(config); resetDraft(); groupsDialog.value?.close(); notice.value = '分组已保存'
}) }
function runScript(script: Script, mode: RunMode) {
  // Capture the chosen mode before draft confirmation; only remember successful launches.
  const external = mode === 'external'
  const remember = () => { runModes.value[script.id] = mode; writePreference('run-modes', runModes.value) }
  guard(() => void perform(async () => {
    if (external) {
      await api('run.terminal', { scriptId: script.id }); remember()
      notice.value = '已打开外部终端，运行与停止请在终端中操作'
      return
    }
    selected.value = script.id; outputCollapsed.value = false; const result = await api<{ runId: string }>('run.start', { scriptId: script.id }); remember(); await refresh(); outputId.value = result.runId
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
function escapePanel(event: KeyboardEvent) { if (event.defaultPrevented || event.key !== 'Escape' || document.querySelector('dialog[open]')) return; if (configOpen.value) closeConfig(); if (sidebarOpen.value) { sidebarOpen.value = false; document.querySelector<HTMLButtonElement>('.mobile-menu')?.focus() } }
function copyOutput() { void perform(async () => { await navigator.clipboard.writeText(visibleLines.value.map(line => line.text).join('\n')); notice.value = '当前输出已复制' }) }
function copyCommand(script: Script) { void perform(async () => {
  const command = powershellCommand(script)
  if (!command) throw Error('请检查脚本路径、启动方式及参数后再复制。')
  try { await navigator.clipboard.writeText(command) }
  catch { throw Error('无法写入剪贴板，请从配置面板的启动预览中手动复制。') }
  notice.value = 'PowerShell 启动命令已复制'
}) }
function openHelp() { void perform(async () => { const response = await fetch('/guide'); if (!response.ok) throw Error('无法读取使用说明。'); guide.value = await response.text(); helpDialog.value?.showModal() }) }
function shutdown() { confirm(`退出后台并停止全部 ${running.value.length} 个托管任务？连接到同一实例的其他页面也会断开。`, () => void perform(async () => {
  await api('shutdown'); exited.value = true; settingsDialog.value?.close(); clearTimeout(timer); notice.value = '后台已退出，可以关闭此页面。'
})) }
function updateArg(index: number, event: Event, interpreter = false) { const values = interpreter ? draft.value!.interpreterArgs : draft.value!.args; values[index] = (event.target as HTMLInputElement).value }
function setEnv(text: string) {
  envText.value = text
  const result = parseEnvironment(text)
  envError.value = Object.values(result.errors)[0] || ''
  if (!envError.value && draft.value) draft.value.env = result.values
}
const backdrop = new WeakMap<EventTarget, boolean>()
function outside(event: MouseEvent) { const el = event.currentTarget as HTMLElement, r = el.getBoundingClientRect(); return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom }
function markBackdrop(event: PointerEvent) { if (event.currentTarget) backdrop.set(event.currentTarget, outside(event)) }
function dismissBackdrop(event: MouseEvent) { if (event.currentTarget && backdrop.get(event.currentTarget) && outside(event)) (event.currentTarget as HTMLDialogElement).close() }
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }

const { studio, header, layout, viewMode, ready: layoutReady, maximum: layoutMaximum, resizingPanel, startResize, resizeKey, reset: resetPanel } = usePanelLayout(message => { error.value = message }, legacyView === 'compact' || legacyView === 'cards' ? legacyView : undefined)

onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload); window.addEventListener('keydown', consoleKey); window.addEventListener('keydown', escapePanel)
  window.addEventListener('keydown', syncControl); window.addEventListener('keyup', syncControl)
  window.addEventListener('pointermove', syncControl); window.addEventListener('blur', resetControl)
  document.addEventListener('visibilitychange', visibilityChanged); clockTimer = setInterval(() => { now.value = Date.now() }, 1000); void poll()
})
onBeforeUnmount(() => {
  disposed = true; clearTimeout(timer); clearInterval(clockTimer); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('keydown', consoleKey); window.removeEventListener('keydown', escapePanel)
  window.removeEventListener('keydown', syncControl); window.removeEventListener('keyup', syncControl)
  window.removeEventListener('pointermove', syncControl); window.removeEventListener('blur', resetControl)
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<template>
  <div ref="studio" class="studio" :class="{ 'is-resizing': resizingPanel, 'console-maximized': outputMaximized }" :style="{ '--sidebar-w': layout.sidebarWidth + 'px', '--config-w': layout.configWidth + 'px', '--output-h': (outputCollapsed ? 42 : layout.outputHeight) + 'px' }">
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
      <main class="script-list" :inert="outputMaximized">
        <div class="list-heading"><h1>{{ pageTitle }}<span>{{ visible.length }}</span></h1><select v-model="type" aria-label="筛选脚本类型"><option>全部类型</option><option v-for="item in types" :key="item">{{ item }}</option></select></div>
        <div class="list-toolbar"><label class="search"><UiIcon name="search" :size="16" /><input v-model="query" aria-label="搜索脚本" placeholder="搜索名称、路径或备注…" type="search" /></label><div class="segmented view-switch" role="group" aria-label="列表视图"><button :disabled="!layoutReady" aria-label="卡片视图" title="卡片视图" :aria-pressed="viewMode === 'cards'" @click="viewMode = 'cards'"><UiIcon name="grid" :size="16" /></button><button :disabled="!layoutReady" aria-label="紧凑列表视图" title="紧凑列表视图" :aria-pressed="viewMode === 'compact'" @click="viewMode = 'compact'"><UiIcon name="list" :size="16" /></button></div></div>
        <div class="cards" :class="{ compact: viewMode === 'compact' }" @keydown="navigateScripts">
          <div v-if="loading" class="empty">正在连接本地后台…</div>
          <article v-for="script in visible" :key="script.id" class="script-card" :class="{ 'is-selected': selected === script.id }">
            <button class="favorite icon-button" :class="{ on: script.favorite }" :aria-label="`${script.favorite ? '取消收藏' : '收藏'} ${script.name}`" :aria-pressed="script.favorite" :disabled="!writable || busy" @click="favorite(script)"><UiIcon name="star" :size="16" /></button>
            <span class="row-state run-state" :class="latest(script.id)?.state || 'idle'" :title="latest(script.id) ? states[latest(script.id)!.state] : '未运行'" :aria-label="latest(script.id) ? states[latest(script.id)!.state] : '未运行'"><i /></span>
            <button class="card-select" :aria-pressed="selected === script.id" @click="selectScript(script.id)"><strong :title="script.name">{{ script.name }}</strong><span class="filename" :title="script.path">{{ script.path.split(/[\\/]/).at(-1) }}</span><span v-if="script.description" class="description">{{ script.description }}</span></button>
            <span class="type-badge" :title="fileType(script)">{{ fileType(script) }}</span>
            <span class="row-duration" :title="latest(script.id) ? date(latest(script.id)!.startedAt) : '尚未执行'">{{ latest(script.id) ? elapsed(latest(script.id)!) : '—' }}</span>
            <div class="card-actions"><button v-if="!active(latest(script.id))" class="icon-button external-shortcut" :aria-label="`直接在外部终端运行 ${script.name}`" title="在外部 PowerShell 终端运行" :disabled="!writable || busy" @click="runScript(script, 'external')"><UiIcon name="terminal" :size="15" /></button><span v-if="active(latest(script.id))" class="running-clock" :title="states[latest(script.id)!.state]">{{ elapsed(latest(script.id)!) }}</span><button class="icon-button copy-command" :aria-label="`复制 ${script.name} 的 PowerShell 命令`" title="复制 PowerShell 命令" :disabled="busy || !powershellCommand(script)" @click="copyCommand(script)"><UiIcon name="copy" :size="16" /></button><button v-if="active(latest(script.id))" class="run-button stop" :disabled="busy || latest(script.id)?.state === 'stopping'" :aria-label="`停止 ${script.name}`" title="停止脚本" @click="stopRun(latest(script.id)!)"><UiIcon name="stop" :size="15" /></button><SplitRunButton v-else :name="script.name" :mode="runModes[script.id] || 'managed'" :ctrl-held="ctrlHeld" :disabled="!writable || busy" :copy-disabled="busy || !powershellCommand(script)" @run="runScript(script, $event)" @copy="copyCommand(script)" /></div>
            <div v-if="script.args.length" class="arg-pills"><code v-for="(arg, i) in script.args.slice(0, 3)" :key="i" :title="arg">{{ arg || '""' }}</code><span v-if="script.args.length > 3">+{{ script.args.length - 3 }}</span></div>
            <div class="card-bottom"><span class="run-state status-pill" :class="latest(script.id)?.state || 'idle'"><i />{{ latest(script.id) ? states[latest(script.id)!.state] : '未运行' }}<span v-if="latest(script.id)">· {{ elapsed(latest(script.id)!) }}</span></span></div>
          </article>
          <div v-if="!loading && !visible.length" class="empty"><UiIcon name="code" :size="32" /><strong>{{ scripts.length ? '没有匹配的脚本' : '添加你的第一个脚本' }}</strong><p>{{ scripts.length ? '调整搜索或筛选条件。' : '将常用脚本放在一处，随时运行。' }}</p><button v-if="!scripts.length" class="primary" :disabled="!writable || busy" @click="openAdd"><UiIcon name="plus" />添加脚本</button></div>
        </div>
      </main>
      <div class="resize-handle-v resize-handle-config" :inert="outputMaximized" :class="{ 'is-resizing': resizingPanel === 'config' }"
        title="拖动或方向键调整配置面板宽度，双击或 Enter 复位" aria-label="调整配置面板宽度" role="separator"
        :tabindex="layoutReady ? 0 : -1" :aria-disabled="!layoutReady" aria-controls="script-config" aria-orientation="vertical"
        :aria-valuenow="layout.configWidth" :aria-valuemin="260" :aria-valuemax="layoutMaximum.config"
        @pointerdown="startResize('config', $event)" @keydown="resizeKey('config', $event)" @dblclick="resetPanel('config')" />
      <aside id="script-config" class="config-panel" :inert="outputMaximized" :class="{ open: configOpen }" aria-label="脚本配置">
        <div class="config-heading"><h2>脚本配置<span v-if="dirty" class="dirty-dot" title="尚未保存" /></h2><button class="icon-button config-close" aria-label="关闭脚本配置" @click="closeConfig"><UiIcon name="close" /></button></div>
        <form v-if="draft" class="config-form" @submit.prevent="saveScript">
          <div class="config-fields"><fieldset :disabled="!writable || busy">
            <label>名称<input v-model="draft.name" required maxlength="80" /></label>
            <label>脚本文件<div class="input-action"><input v-model="draft.path" required placeholder="本地文件绝对路径" /><button type="button" class="icon-button" aria-label="选择脚本文件" @click="pickFile(draft)"><UiIcon name="folder" :size="16" /></button></div></label>
            <div class="field-row"><label>分组<select v-model="draft.groupId"><option :value="null">未分组</option><option v-for="group in data?.config.groups" :key="group.id" :value="group.id">{{ group.name }}</option></select></label><label>启动方式<select v-model="draft.runner"><option v-for="(label, value) in runners" :key="value" :value="value">{{ label }}</option></select></label></div>
            <template v-if="draft.runner === 'custom'"><label>解释器<input v-model="draft.program" required placeholder="例如 pwsh.exe 或完整路径" /></label><div class="argument-field"><div class="field-title">解释器参数<button type="button" @click="draft.interpreterArgs.push('')">＋ 添加</button></div><div v-for="(arg, i) in draft.interpreterArgs" :key="i" class="input-action"><input :value="arg" :aria-label="`解释器参数 ${i + 1}`" @input="updateArg(i, $event, true)" /><button type="button" class="icon-button" :aria-label="`移除解释器参数 ${i + 1}`" @click="draft.interpreterArgs.splice(i, 1)"><UiIcon name="close" :size="14" /></button></div></div></template>
            <div class="argument-field"><div class="field-title">启动参数<button type="button" @click="draft.args.push('')">＋ 添加参数</button></div><div v-if="!draft.args.length" class="field-hint">每项单独传递，空格无需加引号。</div><div v-for="(arg, i) in draft.args" :key="i" class="input-action"><input :value="arg" :aria-label="`启动参数 ${i + 1}`" placeholder="空白表示一个空参数" @input="updateArg(i, $event)" /><button type="button" class="icon-button" :aria-label="`移除启动参数 ${i + 1}`" @click="draft.args.splice(i, 1)"><UiIcon name="close" :size="14" /></button></div></div>
            <section class="launch-preview"><div class="field-title">启动预览（PowerShell）<button type="button" :disabled="busy || !preview || !!envError" @click="copyCommand(draft)"><UiIcon name="copy" :size="13" />复制命令</button></div><code class="command-preview">{{ preview || '请检查脚本路径、启动方式及参数。' }}</code><p class="field-hint">工作目录和环境变量沿用粘贴目标终端。</p></section>
            <label>工作目录<input :value="draft.cwd || ''" placeholder="默认使用脚本所在目录" @input="draft.cwd = ($event.target as HTMLInputElement).value || null" /></label>
            <label>备注<textarea v-model="draft.description" rows="2" maxlength="2000" placeholder="这个脚本做什么…" /></label>
            <EnvEditor :model-value="envText" @update:model-value="setEnv" />
            <details class="advanced"><summary>高级配置</summary><label>输出编码<select v-model="draft.encoding"><option value="utf8">UTF-8</option><option value="system">系统 OEM 代码页</option></select></label></details>
          </fieldset></div>
          <footer class="config-footer"><div class="config-actions"><button class="primary" :class="{ 'has-changes': dirty }" type="submit" :disabled="!dirty || !!envError || !writable || busy"><UiIcon name="check" :size="16" />保存配置</button><button type="button" :disabled="!dirty || busy" @click="resetDraft">放弃修改</button></div>
          <button class="danger remove-registration" type="button" :disabled="!writable || busy || !!currentActive" @click="removeScript"><UiIcon name="trash" :size="14" />移除登记</button></footer>
        </form><div v-else class="empty config-empty"><UiIcon name="settings" :size="28" /><p>选择脚本以查看配置。</p></div>
      </aside>
    </div>
    <button v-if="current && !outputMaximized" class="floating-config" @click="openConfig"><UiIcon name="settings" :size="16" />脚本配置<span v-if="dirty" class="dirty-dot" /></button>
    <section id="script-output" class="output-panel" :class="{ collapsed: outputCollapsed, maximized: outputMaximized }" aria-label="运行输出">
      <div v-if="!outputCollapsed && !outputMaximized" class="resize-handle-output" :class="{ 'is-resizing': resizingPanel === 'output' }"
        title="拖动或方向键调整输出面板高度，双击或 Enter 复位" aria-label="调整输出面板高度" role="separator"
        :tabindex="layoutReady ? 0 : -1" :aria-disabled="!layoutReady" aria-controls="script-output" aria-orientation="horizontal"
        :aria-valuenow="layout.outputHeight" :aria-valuemin="110" :aria-valuemax="layoutMaximum.output"
        @pointerdown="startResize('output', $event)" @keydown="resizeKey('output', $event)" @dblclick="resetPanel('output')" />
      <div class="output-heading"><UiIcon name="terminal" /><strong>运行输出</strong><ActionMenu v-if="outputRun" class="history-menu" label="选择运行记录" :selected="outputRun.id" :items="historyItems" @choose="loadHistory(history.find(r => r.id === $event))"><span>{{ outputRun.snapshot.name }}</span></ActionMenu><button v-else-if="history.length" class="text-button read-history-btn" :disabled="busy" @click="loadHistory()"><UiIcon name="clock" :size="13" />读取历史记录</button><span v-else class="muted">{{ current?.name || '尚未选择脚本' }}</span><span v-if="outputRun" class="console-summary run-state" :class="outputRun.state">{{ states[outputRun.state] }} {{ elapsed(outputRun) }}</span>
        <div class="output-tools"><button v-if="outputRun && active(outputRun)" class="stop-action" :disabled="busy || outputRun.state === 'stopping'" @click="stopRun(outputRun)"><UiIcon name="stop" :size="14" />停止</button><button class="icon-button" aria-label="搜索日志" title="搜索日志 (Ctrl+F)" @click="searchLogs"><UiIcon name="search" :size="15" /></button><button class="icon-button output-secondary" aria-label="复制当前输出" title="复制当前筛选输出" :disabled="!visibleLines.length || busy" @click="copyOutput"><UiIcon name="copy" :size="15" /></button><button class="icon-button output-secondary" :aria-label="outputRun ? '重新读取输出' : '读取历史记录'" title="重新读取输出" :disabled="(!outputRun && !history.length) || busy" @click="outputRun ? reloadOutput() : loadHistory()"><UiIcon name="refresh" :size="15" /></button><button class="icon-button output-secondary" aria-label="清空当前输出" title="清空当前显示，保留历史" :disabled="!outputRun && !chunks.length" @click="clearOutput"><UiIcon name="trash" :size="15" /></button>
          <ActionMenu class="console-more" label="更多输出操作" :items="[{ id: 'copy', label: '复制当前输出', icon: 'copy', disabled: !visibleLines.length || busy }, { id: 'reload', label: '重新读取输出', icon: 'refresh', disabled: (!outputRun && !history.length) || busy }, { id: 'clear', label: '清空当前输出', icon: 'trash', disabled: !outputRun && !chunks.length }]" @choose="$event === 'copy' ? copyOutput() : $event === 'clear' ? clearOutput() : outputRun ? reloadOutput() : loadHistory()"><UiIcon name="more" :size="15" /></ActionMenu>
          <div class="segmented console-sizes" role="group" aria-label="控制台高度"><button :aria-label="outputCollapsed ? '展开运行输出' : '收起运行输出'" title="折叠 / 展开" :aria-pressed="outputCollapsed" @click="setOutputSize(outputCollapsed ? 'standard' : 'collapsed')"><UiIcon name="minimize" :size="15" /></button><button aria-label="标准输出高度" title="标准高度（可拖拽）" :aria-pressed="!outputCollapsed && !outputMaximized" @click="setOutputSize('standard')"><UiIcon name="panel" :size="15" /></button><button aria-label="最大化运行输出" title="最大化 / 还原 (Esc)" :aria-pressed="outputMaximized" @click="setOutputSize(outputMaximized ? 'standard' : 'maximized')"><UiIcon name="maximize" :size="15" /></button></div>
        </div>
      </div>
      <template v-if="!outputCollapsed">
        <div class="console-toolbar"><div class="segmented stream-filter" role="group" aria-label="输出流筛选"><button v-for="item in [{ id: 'all', label: '全部' }, { id: 'stdout', label: 'stdout' }, { id: 'stderr', label: 'stderr' }]" :key="item.id" :aria-pressed="streamFilter === item.id" @click="streamFilter = item.id">{{ item.label }}</button></div><label v-if="searchOpen" class="log-search"><UiIcon name="search" :size="14" /><input ref="logSearch" v-model="logQuery" type="search" aria-label="日志关键词" placeholder="筛选日志…" /><button class="icon-button" aria-label="关闭日志搜索" @click="searchOpen = false; logQuery = ''"><UiIcon name="close" :size="13" /></button></label><span v-if="logQuery" class="match-count">{{ visibleLines.length }} 行</span><span v-if="outputRun?.exitCode != null" class="exit-code">退出码 {{ outputRun.exitCode }}</span><button v-if="!follow" class="output-jump" @click="follow = true; scrollOutput()">最新输出 ↓</button></div>
        <div v-if="clipped" class="output-status warning-text">输出已截断；清空显示不删除历史</div>
        <div ref="outputBody" class="output-body" tabindex="0" aria-label="脚本输出内容" @scroll="onOutputScroll"><pre v-if="visibleLines.length"><span v-for="(line, i) in visibleLines" :key="i" class="log-line" :class="line.stream"><span class="line-number" aria-hidden="true">{{ i + 1 }}</span><span class="line-text"><template v-for="(part, j) in highlight(line.text, logQuery)" :key="j"><mark v-if="part.match">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>{{ '\n' }}</span></span></pre><div v-else class="output-empty"><span v-if="chunks.length">没有匹配的日志，调整关键词或输出流筛选。</span><div v-else-if="!outputRun && history.length" class="history-prompt"><span>历史日志尚未读取。</span><button class="primary load-history-btn" type="button" :disabled="busy" @click="loadHistory()"><UiIcon name="refresh" :size="14" />读取历史记录</button></div><span v-else-if="!outputRun">选择一个脚本，点击运行。</span><span v-else-if="outputCleared">当前显示已清空，点击“重新读取输出”查看历史。</span><span v-else-if="!logLoaded">正在读取运行输出…</span><span v-else-if="active(outputRun)">等待输出…</span><span v-else>此次运行没有输出。</span></div><div v-if="outputRun?.error" class="run-error">{{ outputRun.error }}</div></div>
      </template>
    </section>

    <dialog ref="addDialog" class="dialog" aria-labelledby="add-title" @pointerdown="markBackdrop" @click="dismissBackdrop"><form @submit.prevent="addScript"><div class="dialog-heading"><h2 id="add-title">添加脚本</h2><button type="button" class="icon-button" aria-label="关闭添加脚本" @click="addDialog?.close()"><UiIcon name="close" /></button></div><fieldset :disabled="busy"><label>脚本文件<div class="input-action"><input v-model="newScript.path" required placeholder="例如 C:\Scripts\backup.ps1" /><button type="button" class="icon-button" aria-label="选择本地脚本" @click="pickFile(newScript)"><UiIcon name="folder" /></button></div></label><label>脚本名称<input v-model="newScript.name" required maxlength="80" placeholder="例如：数据库备份" /></label><label>分组<select v-model="newScript.groupId"><option :value="null">未分组</option><option v-for="group in data?.config.groups" :key="group.id" :value="group.id">{{ group.name }}</option></select></label></fieldset><p class="field-hint">登记本地路径，脚本文件保留在原位置。</p><div class="dialog-actions"><button type="button" @click="addDialog?.close()">取消</button><button class="primary" :disabled="busy || !writable" type="submit">添加到工作空间</button></div></form></dialog>
    <dialog ref="groupsDialog" class="dialog" aria-labelledby="groups-title" @pointerdown="markBackdrop" @click="dismissBackdrop"><form @submit.prevent="saveGroups"><div class="dialog-heading"><h2 id="groups-title">管理分组</h2><button type="button" class="icon-button" aria-label="关闭分组管理" @click="groupsDialog?.close()"><UiIcon name="close" /></button></div><p class="field-hint">移除分组后，脚本移入“未分组”。</p><div class="group-editor"><div v-for="(group, i) in groupDrafts" :key="group.id" class="input-action"><input v-model="group.name" :aria-label="`分组名称 ${i + 1}`" required maxlength="80" /><button type="button" class="icon-button danger" :aria-label="`移除分组 ${group.name}`" @click="groupDrafts.splice(i, 1)"><UiIcon name="trash" :size="16" /></button></div></div><button type="button" class="text-button" @click="addGroup"><UiIcon name="plus" :size="16" />添加分组</button><div class="dialog-actions"><button type="button" @click="groupsDialog?.close()">取消</button><button type="submit" class="primary" :disabled="busy || !writable">保存分组</button></div></form></dialog>
    <dialog ref="settingsDialog" class="dialog" aria-labelledby="settings-title" @pointerdown="markBackdrop" @click="dismissBackdrop"><div class="dialog-heading"><h2 id="settings-title">设置与运行管理</h2><button class="icon-button" aria-label="关闭设置" @click="settingsDialog?.close()"><UiIcon name="close" /></button></div><label>数据目录<code class="data-path">{{ data?.dataDirectory || '尚未连接' }}</code></label><p class="field-hint">最多保留 1 次运行历史 · 每次日志最多 10 MiB</p><button class="text-button" :disabled="busy" @click="guard(() => perform(async () => { install(await api<Snapshot>('reload')); resetDraft(); notice = '配置已重新加载' }))"><UiIcon name="refresh" :size="16" />重新加载配置</button><h3>运行中的脚本 <span class="muted">{{ running.length }}</span></h3><div v-for="run in running" :key="run.id" class="active-run"><div><strong>{{ run.snapshot.name }}</strong><small>{{ duration(run) }}</small></div><button :disabled="busy || run.state === 'stopping'" @click="stopRun(run)">{{ run.state === 'stopping' ? '正在停止' : '停止' }}</button></div><p v-if="!running.length" class="muted">没有正在运行的脚本。</p><h3>最近运行</h3><div class="recent-runs"><div v-for="run in data?.runs || []" :key="run.id" class="active-run"><div><strong>{{ run.snapshot.name }}</strong><small>{{ date(run.startedAt) }} · {{ states[run.state] }}</small></div><button @click="viewHistory(run)">查看</button></div></div><p v-for="warning in data?.warnings || []" :key="warning" class="dialog-error">{{ warning }}</p><div class="dialog-actions"><button class="danger" :disabled="busy || exited" @click="shutdown">退出后台</button><button class="primary" @click="settingsDialog?.close()">完成</button></div></dialog>
    <dialog ref="helpDialog" class="dialog help-dialog" aria-labelledby="help-title" @pointerdown="markBackdrop" @click="dismissBackdrop"><div class="dialog-heading"><h2 id="help-title">使用说明</h2><button class="icon-button" aria-label="关闭使用说明" @click="helpDialog?.close()"><UiIcon name="close" /></button></div><pre class="guide">{{ guide }}</pre></dialog>
    <dialog ref="confirmDialog" class="dialog confirm-dialog" aria-labelledby="confirm-title" @pointerdown="markBackdrop" @click="dismissBackdrop"><h2 id="confirm-title">确认操作</h2><p>{{ confirmMessage }}</p><div class="dialog-actions"><button @click="confirmDialog?.close()">取消</button><button class="primary" @click="acceptConfirm">确认</button></div></dialog>
  </div>
</template>
