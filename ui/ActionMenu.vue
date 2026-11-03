<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import UiIcon from './UiIcon.vue'
export interface MenuItem { id: string; label: string; icon?: string; disabled?: boolean }
defineOptions({ inheritAttrs: false })
const props = defineProps<{ label: string; items: MenuItem[]; selected?: string; disabled?: boolean }>()
const emit = defineEmits<{ choose: [id: string] }>()
const id = useId(), open = ref(false), trigger = ref<HTMLButtonElement>(), menu = ref<HTMLElement>()
const position = ref({ left: '0px', top: '0px', maxHeight: '320px' })
function close(restore = false) { open.value = false; if (restore) trigger.value?.focus() }
async function show(last = false) {
  if (props.disabled) return
  open.value = true
  await nextTick()
  if (!open.value || !trigger.value || !menu.value) return
  const anchor = trigger.value.getBoundingClientRect(), panel = menu.value
  const above = innerHeight - anchor.bottom < Math.min(panel.scrollHeight, 260) && anchor.top > innerHeight / 2
  position.value = {
    left: `${Math.max(8, Math.min(anchor.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8))}px`,
    top: `${above ? Math.max(8, anchor.top - Math.min(panel.scrollHeight, anchor.top - 16) - 6) : anchor.bottom + 6}px`,
    maxHeight: `${Math.max(60, above ? anchor.top - 16 : innerHeight - anchor.bottom - 16)}px`,
  }
  const buttons = panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
  if (buttons.length) buttons[last ? buttons.length - 1 : 0]?.focus()
  else panel.focus()
}
function choose(item: MenuItem) { close(true); emit('choose', item.id) }
function keys(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
  if (event.key === 'Tab') { close(true); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = [...menu.value!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
}
function outside(event: Event) { if (!menu.value?.contains(event.target as Node) && !trigger.value?.contains(event.target as Node)) close() }
function reposition() { if (open.value) close(true) }
function removeListeners() { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', reposition); document.removeEventListener('scroll', outside, true) }
watch(open, value => { if (value) { document.addEventListener('pointerdown', outside); window.addEventListener('resize', reposition); document.addEventListener('scroll', outside, true) } else removeListeners() })
onBeforeUnmount(removeListeners)
</script>
<template>
  <button v-bind="$attrs" ref="trigger" type="button" class="menu-trigger" :disabled="disabled" :aria-label="label" :title="label" aria-haspopup="menu" :aria-expanded="open" :aria-controls="open ? id : undefined" @click="open ? close() : show()" @keydown.down.prevent="show()" @keydown.up.prevent="show(true)"><slot /><UiIcon name="down" :size="13" /></button>
  <Teleport to="body"><div v-if="open" :id="id" ref="menu" tabindex="-1" class="action-menu" :style="position" role="menu" :aria-label="label" @keydown="keys"><button v-for="item in items" :key="item.id" type="button" :role="selected !== undefined && item.id !== 'copy' ? 'menuitemradio' : 'menuitem'" :aria-checked="selected !== undefined && item.id !== 'copy' ? selected === item.id : undefined" :disabled="item.disabled" @click="choose(item)"><UiIcon v-if="item.icon" :name="item.icon" :size="16" /><span>{{ item.label }}</span><UiIcon v-if="selected === item.id" name="check" :size="14" /></button></div></Teleport>
</template>
