<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import UiIcon from './UiIcon.vue'

const props = defineProps<{ notice: string; error: string; configError?: string | null; dataDirectory?: string; busy: boolean }>()
const emit = defineEmits<{ closeNotice: []; closeError: []; reload: [] }>()
const target = shallowRef<HTMLElement | string>('body')
const viewport = ref<HTMLElement>()
const configDismissed = ref(false)
const hovered = ref(false), focused = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let observer: MutationObserver | undefined
let origin: HTMLElement | null = null

function stopTimer() { clearTimeout(timer) }
function scheduleDismiss() {
  stopTimer()
  if (props.notice && !hovered.value && !focused.value) timer = setTimeout(() => emit('closeNotice'), 4000)
}
function rememberOrigin() {
  const active = document.activeElement
  if (active instanceof HTMLElement && !viewport.value?.contains(active)) origin = active
}
function dismiss(kind: 'notice' | 'error' | 'config') {
  const restoreFocus = viewport.value?.contains(document.activeElement)
  if (kind === 'config') configDismissed.value = true
  else if (kind === 'notice') emit('closeNotice')
  else emit('closeError')
  if (restoreFocus) {
    focused.value = false
    void nextTick(() => { if (origin?.isConnected) origin.focus({ preventScroll: true }); scheduleDismiss() })
  }
}
function focusOut(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && viewport.value?.contains(event.relatedTarget)) return
  focused.value = false; scheduleDismiss()
}
watch(() => props.notice, () => { rememberOrigin(); scheduleDismiss() })
watch(() => props.error, rememberOrigin)
watch(() => props.configError, () => { configDismissed.value = false; rememberOrigin() })
onMounted(() => {
  // Keep notifications visible and interactive inside a modal's browser top layer.
  const syncTarget = () => { target.value = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1) || 'body' }
  observer = new MutationObserver(syncTarget)
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] })
  syncTarget(); scheduleDismiss()
})
onBeforeUnmount(() => { stopTimer(); observer?.disconnect() })
</script>

<template>
  <Teleport :to="target">
    <div ref="viewport" class="toast-viewport" aria-label="通知"
      @mouseenter="hovered = true; stopTimer()" @mouseleave="hovered = false; scheduleDismiss()"
      @focusin="focused = true; stopTimer()" @focusout="focusOut">
      <Transition name="toast">
        <div v-if="configError && !configDismissed" class="toast-card toast-error" role="alert" aria-atomic="true">
          <UiIcon name="warning" :size="18" />
          <div class="toast-content"><p>配置不可写：{{ configError }}</p><small>{{ dataDirectory }}</small><button class="toast-action" :disabled="busy" @click="emit('reload')">重新加载</button></div>
          <button class="icon-button" aria-label="关闭配置错误提示" @click="dismiss('config')"><UiIcon name="close" :size="15" /></button>
        </div>
      </Transition>
      <Transition name="toast">
        <div v-if="error" class="toast-card toast-error" role="alert" aria-atomic="true">
          <UiIcon name="warning" :size="18" /><p class="toast-content">{{ error }}</p>
          <button class="icon-button" aria-label="关闭错误提示" @click="dismiss('error')"><UiIcon name="close" :size="15" /></button>
        </div>
      </Transition>
      <Transition name="toast">
        <div v-if="notice" class="toast-card toast-success" role="status" aria-atomic="true">
          <UiIcon name="check" :size="18" /><p class="toast-content">{{ notice }}</p>
          <button class="icon-button" aria-label="关闭提示" @click="dismiss('notice')"><UiIcon name="close" :size="15" /></button>
        </div>
      </Transition>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-viewport { position: fixed; z-index: 100; right: max(12px, env(safe-area-inset-right)); bottom: max(12px, env(safe-area-inset-bottom)); width: min(372px, calc(100vw - 24px)); max-height: calc(100dvh - 88px); display: flex; flex-direction: column; gap: 8px; padding: 4px; overflow-y: auto; pointer-events: none; }
.toast-card { display: flex; align-items: flex-start; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); color: var(--text); box-shadow: 0 4px 18px #30203b24; pointer-events: auto; flex-shrink: 0; font-size: 12px; line-height: 1.6; }
.toast-card > svg { margin-top: 3px; }
.toast-success > svg { color: var(--success); }
.toast-error > svg { color: var(--danger); }
.toast-content { flex: 1; min-width: 0; margin: 0; overflow-wrap: anywhere; }
.toast-content p { margin: 0; }
.toast-content small { display: block; margin-top: 4px; color: var(--muted); font-size: 11px; }
.toast-card .icon-button { width: 26px; height: 26px; padding: 4px; margin: -2px -3px -2px 0; }
.toast-action { display: flex; padding: 4px 0 0; color: var(--accent); font-size: 11px; }
.toast-enter-active, .toast-leave-active { transition: opacity .15s, transform .15s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(6px); }
@media (prefers-color-scheme: dark) { .toast-card { box-shadow: 0 4px 18px #0005; } }
@media (prefers-reduced-motion: reduce) { .toast-enter-active, .toast-leave-active { transition: none; } }
</style>
