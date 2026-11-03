import type { Chunk } from './api'
export type RunMode = 'managed' | 'external'
export function readPreference(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(`script-studio:${key}`) || 'null') } catch { return null }
}
export function writePreference(key: string, value: unknown) {
  try { localStorage.setItem(`script-studio:${key}`, JSON.stringify(value)) } catch { /* Session state remains usable when storage is unavailable. */ }
}
export function parseEnvironment(text: string) {
  const values: Record<string, string> = Object.create(null), errors: Record<number, string> = {}, seen = new Set<string>()
  text.split('\n').forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return
    const split = line.indexOf('='), key = line.slice(0, split)
    if (split < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) errors[index] = '名称须以字母或下划线开头，且仅含字母、数字、下划线。'
    else if (seen.has(key.toUpperCase())) errors[index] = '变量名称重复（Windows 不区分大小写）。'
    else { seen.add(key.toUpperCase()); values[key] = line.slice(split + 1).replace(/\r$/, '') }
  })
  return { values, errors }
}
// Reassemble each stream before splitting: HTTP chunks are not log lines.
export function logLines(chunks: Chunk[]) {
  const lines: { stream: string; text: string }[] = [], pending = new Map<string, { stream: string; text: string }>()
  for (const chunk of chunks) {
    const pieces = chunk.text.split('\n')
    pieces.forEach((piece, index) => {
      if (!piece && index === pieces.length - 1) return
      let line = pending.get(chunk.stream)
      if (!line) { line = { stream: chunk.stream, text: '' }; lines.push(line); pending.set(chunk.stream, line) }
      line.text += piece
      if (index < pieces.length - 1) pending.delete(chunk.stream)
    })
  }
  return lines
}
export function highlight(text: string, query: string) {
  if (!query) return [{ text, match: false }]
  const result: { text: string; match: boolean }[] = [], lower = text.toLowerCase(), needle = query.toLowerCase()
  let start = 0, index = lower.indexOf(needle)
  while (index >= 0) {
    if (index > start) result.push({ text: text.slice(start, index), match: false })
    result.push({ text: text.slice(index, index + query.length), match: true })
    start = index + query.length; index = lower.indexOf(needle, start)
  }
  if (start < text.length) result.push({ text: text.slice(start), match: false })
  return result
}
