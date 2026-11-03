<script setup lang="ts">
import UiIcon from './UiIcon.vue'
import ActionMenu from './ActionMenu.vue'
import type { RunMode } from './studioState'
const props = defineProps<{ name: string; mode: RunMode; ctrlHeld: boolean; disabled: boolean; copyDisabled: boolean }>()
const emit = defineEmits<{ run: [mode: RunMode]; copy: [] }>()
function choose(id: string) { if (id === 'copy') emit('copy'); else emit('run', props.ctrlHeld ? 'external' : id as RunMode) }
</script>
<template>
  <div class="split-run">
    <button class="run-button" :class="{ 'external-launch': ctrlHeld, 'external-mode': mode === 'external' }" :disabled="disabled" :aria-label="ctrlHeld || mode === 'external' ? `在外部终端运行 ${name}` : `运行 ${name}`" :title="`${ctrlHeld || mode === 'external' ? '在外部 PowerShell 终端运行' : '托管运行'}（已保存配置） · 按住 Ctrl 强制外部运行`" @click="emit('run', $event.ctrlKey || ctrlHeld ? 'external' : mode)"><UiIcon :name="ctrlHeld || mode === 'external' ? 'terminal' : 'play'" :size="16" /></button>
    <ActionMenu :label="`${name} 的运行方式`" :selected="mode" :items="[{ id: 'managed', label: '托管运行', icon: 'play', disabled }, { id: 'external', label: '在外部 PowerShell 终端运行', icon: 'terminal', disabled }, { id: 'copy', label: '复制启动命令', icon: 'copy', disabled: copyDisabled }]" @choose="choose" />
  </div>
</template>
