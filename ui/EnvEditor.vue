<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'
import UiIcon from './UiIcon.vue'
import { parseEnvironment } from './studioState'
const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [text: string] }>()
const raw = ref(false), root = ref<HTMLElement>(), id = useId()
const lines = computed(() => props.modelValue.split('\n'))
const parsed = computed(() => parseEnvironment(props.modelValue))
const rows = computed(() => lines.value.flatMap((line, index) => {
  if (!line.trim() || line.trimStart().startsWith('#')) return []
  const split = line.indexOf('=')
  return [{ index, key: split < 0 ? line : line.slice(0, split), value: split < 0 ? '' : line.slice(split + 1) }]
}))
function update(index: number, key: string, value: string) { const next = [...lines.value]; next[index] = `${key}=${value}`; emit('update:modelValue', next.join('\n')) }
function remove(index: number) { emit('update:modelValue', lines.value.filter((_, i) => i !== index).join('\n')); void nextTick(() => root.value?.querySelector<HTMLButtonElement>('.env-add')?.focus()) }
function add() { emit('update:modelValue', props.modelValue ? `${props.modelValue}\n=` : '='); void nextTick(() => root.value?.querySelectorAll<HTMLInputElement>('.env-key').item(rows.value.length - 1)?.focus()) }
</script>
<template>
  <div ref="root" class="env-editor">
    <div class="field-title"><span>环境变量</span><button type="button" :aria-pressed="raw" @click="raw = !raw">{{ raw ? '切换表格' : '切换纯文本' }}</button></div>
    <template v-if="raw"><textarea :value="modelValue" aria-label="环境变量" :aria-invalid="Object.keys(parsed.errors).length > 0" :aria-describedby="`${id}-errors`" rows="5" placeholder="NAME=value，每行一项；支持 # 注释" spellcheck="false" @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)" /><div :id="`${id}-errors`"><p v-for="(error, line) in parsed.errors" :key="line" class="field-error">第 {{ Number(line) + 1 }} 行：{{ error }}</p></div></template>
    <template v-else><div v-for="(row, i) in rows" :key="row.index" class="env-entry"><div class="env-row"><input class="env-key" :value="row.key" :aria-label="`变量名称 ${i + 1}`" :aria-invalid="!!parsed.errors[row.index]" :aria-describedby="parsed.errors[row.index] ? `${id}-${row.index}` : undefined" placeholder="KEY" spellcheck="false" @input="update(row.index, ($event.target as HTMLInputElement).value, row.value)" /><span>=</span><input :value="row.value" :aria-label="`变量值 ${i + 1}`" placeholder="value" spellcheck="false" @input="update(row.index, row.key, ($event.target as HTMLInputElement).value)" /><button type="button" class="icon-button" :aria-label="`删除变量 ${i + 1}`" @click="remove(row.index)"><UiIcon name="close" :size="14" /></button></div><p v-if="parsed.errors[row.index]" :id="`${id}-${row.index}`" class="field-error">{{ parsed.errors[row.index] }}</p></div><p v-if="!rows.length" class="field-hint">未设置额外变量。</p><button type="button" class="text-button env-add" @click="add"><UiIcon name="plus" :size="14" />添加变量</button></template>
  </div>
</template>
