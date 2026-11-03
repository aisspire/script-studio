import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { api } from './api'
import { clamp, defaultLayout, fitLayout, keyboardSize, minimum, outputMaximum, panelField, type ListView, type Panel, type PanelLayout } from './panelLayout'

export function usePanelLayout(reportError: (message: string) => void, legacyView?: ListView) {
  const studio = ref<HTMLElement>(), header = ref<HTMLElement>()
  const preferred = ref<PanelLayout>({ ...defaultLayout })
  const viewport = ref({ width: window.innerWidth, height: Math.max(420, window.innerHeight), header: window.innerWidth <= 620 ? 56 : 64 })
  const ready = ref(false), resizingPanel = ref<Panel | null>(null)
  const layout = computed(() => fitLayout(preferred.value, viewport.value.width, viewport.value.height, viewport.value.header))
  const viewMode = computed<ListView>({
    get: () => preferred.value.viewMode || legacyView || 'cards',
    set: value => {
      // Re-selecting the current view also retries a previously failed save.
      if (!ready.value) return
      preferred.value = { ...preferred.value, viewMode: value }; persist()
    },
  })
  const maximum = computed(() => ({
    sidebar: Math.min(360, viewport.value.width - 240 - layout.value.configWidth),
    config: Math.min(520, viewport.value.width - 240 - layout.value.sidebarWidth),
    output: outputMaximum(viewport.value.height, viewport.value.header),
  }))
  let observer: ResizeObserver | undefined, stopDrag: (() => void) | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined, saveQueue = Promise.resolve(), disposed = false

  function measure() {
    if (studio.value && header.value) viewport.value = { width: studio.value.clientWidth, height: studio.value.clientHeight, header: header.value.offsetHeight }
  }
  function persist() {
    clearTimeout(saveTimer); saveTimer = undefined
    const saved = { ...preferred.value }
    saveQueue = saveQueue.then(async () => { await api('ui.layout.save', { layout: saved }) }).catch(e => {
      if (!disposed) reportError(`界面偏好未保存，请重试：${e instanceof Error ? e.message : String(e)}`)
    })
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 180) }
  function update(panel: Panel, value: number) {
    preferred.value = { ...preferred.value, [panelField[panel]]: clamp(value, minimum[panel], maximum.value[panel]) }
  }
  function reset(panel: Panel) {
    if (!ready.value) return
    preferred.value = { ...preferred.value, [panelField[panel]]: defaultLayout[panelField[panel]] }
    persist()
  }
  function resizeKey(panel: Panel, event: KeyboardEvent) {
    if (!ready.value || resizingPanel.value) return
    if (event.key === 'Enter') { event.preventDefault(); reset(panel); return }
    const value = keyboardSize(panel, event.key, layout.value[panelField[panel]], minimum[panel], maximum.value[panel], event.shiftKey)
    if (value === undefined) return
    event.preventDefault()
    update(panel, value); scheduleSave()
  }
  function startResize(panel: Panel, event: PointerEvent) {
    if (event.button !== 0 || !ready.value || resizingPanel.value) return
    event.preventDefault()
    const target = event.currentTarget as HTMLElement, pointerId = event.pointerId
    target.focus(); target.setPointerCapture(pointerId)
    resizingPanel.value = panel
    const start = panel === 'output' ? event.clientY : event.clientX, size = layout.value[panelField[panel]]
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      const delta = (panel === 'output' ? e.clientY : e.clientX) - start
      update(panel, size + (panel === 'sidebar' ? delta : -delta))
    }
    const finish = (e: PointerEvent) => { if (e.pointerId === pointerId) stopDrag?.() }
    stopDrag = () => {
      stopDrag = undefined; resizingPanel.value = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', blur)
      target.removeEventListener('lostpointercapture', finish)
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      persist()
    }
    const blur = () => stopDrag?.()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', blur)
    target.addEventListener('lostpointercapture', finish)
  }
  onMounted(() => {
    measure(); observer = new ResizeObserver(measure)
    if (studio.value) observer.observe(studio.value)
    if (header.value) observer.observe(header.value)
    void api<PanelLayout>('ui.layout').then(saved => {
      if (disposed) return
      preferred.value = saved
      if (!saved.viewMode && legacyView) {
        preferred.value = { ...saved, viewMode: legacyView }; persist()
      }
    }).catch(e => {
      if (!disposed) reportError(`面板布局读取失败：${e instanceof Error ? e.message : String(e)}`)
    }).finally(() => { if (!disposed) ready.value = true })
  })
  onBeforeUnmount(() => {
    observer?.disconnect(); stopDrag?.()
    if (saveTimer !== undefined) persist()
    disposed = true
  })
  return { studio, header, layout, viewMode, ready, maximum, resizingPanel, startResize, resizeKey, reset }
}
