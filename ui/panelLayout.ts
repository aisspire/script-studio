export interface PanelLayout { version: number; sidebarWidth: number; configWidth: number; outputHeight: number }
export type Panel = 'sidebar' | 'config' | 'output'
export const defaultLayout: PanelLayout = { version: 1, sidebarWidth: 200, configWidth: 312, outputHeight: 240 }
export const clamp = (value: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, value)))

// Keep the saved preference intact when the available viewport temporarily shrinks.
export function fitLayout(preferred: PanelLayout, width: number, height: number, headerHeight: number): PanelLayout {
  const sidebarWidth = clamp(preferred.sidebarWidth, 160, Math.min(360, width - 240 - 260))
  const configWidth = clamp(preferred.configWidth, 260, Math.min(520, width - 240 - sidebarWidth))
  return { version: 1, sidebarWidth, configWidth, outputHeight: clamp(preferred.outputHeight, 110, outputMaximum(height, headerHeight)) }
}
export const outputMaximum = (height: number, headerHeight: number) => Math.max(110, Math.min(4096, Math.floor(height - headerHeight - 130)))
export const panelField = { sidebar: 'sidebarWidth', config: 'configWidth', output: 'outputHeight' } as const
export const minimum = { sidebar: 160, config: 260, output: 110 }

export function keyboardSize(panel: Panel, key: string, value: number, min: number, max: number, shift = false): number | undefined {
  const grow = panel === 'sidebar' ? 'ArrowRight' : panel === 'config' ? 'ArrowLeft' : 'ArrowUp'
  const shrink = panel === 'sidebar' ? 'ArrowLeft' : panel === 'config' ? 'ArrowRight' : 'ArrowDown'
  if (key === 'Home') return min
  if (key === 'End') return max
  if (key === grow || key === shrink) return clamp(value + (key === grow ? 1 : -1) * (shift ? 32 : 8), min, max)
}
