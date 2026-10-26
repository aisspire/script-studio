export type Runner = 'auto' | 'powershell' | 'cmd' | 'python' | 'node' | 'direct' | 'custom'
export interface Group { id: string; name: string }
export interface Script {
  id: string; name: string; description: string; path: string; groupId: string | null; favorite: boolean
  runner: Runner; program: string; interpreterArgs: string[]; args: string[]; cwd: string | null
  env: Record<string, string>; encoding: 'utf8' | 'system'
}
export interface Config { version: number; groups: Group[]; scripts: Script[] }
export type RunState = 'running' | 'stopping' | 'succeeded' | 'failed' | 'stopped' | 'interrupted'
export interface Run {
  id: string; scriptId: string; snapshot: Pick<Script, 'name' | 'path' | 'runner'>; startedAt: number
  endedAt: number | null; state: RunState; exitCode: number | null; error: string | null; logTruncated: boolean
}
export interface Snapshot { instance: string; config: Config; revision: string; configError: string | null; dataDirectory: string; runs: Run[]; warnings: string[]; closing: boolean }
export interface Chunk { stream: string; text: string }
export interface Logs { chunks: Chunk[]; cursor: number; truncated: boolean }

let token = ''
try {
  const fragment = new URLSearchParams(location.hash.slice(1))
  token = fragment.get('token') || sessionStorage.getItem('script-studio-token') || ''
  if (fragment.has('token')) {
    sessionStorage.setItem('script-studio-token', token)
    history.replaceState(null, '', location.pathname + location.search)
  }
} catch { /* An unavailable session store still allows this page's in-memory token. */ }

export async function api<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!token) throw Error('请从 Script Studio 的启动链接重新打开页面。')
  const controller = new AbortController()
  const timer = action === 'file.pick' ? undefined : setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch('/api', { method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...args }) })
    const result = await response.json()
    if (!result.ok) throw Error(result.error || '操作失败，请重试。')
    return result.value as T
  } finally { clearTimeout(timer) }
}
export function freshScript(path = ''): Script {
  return { id: crypto.randomUUID(), name: path.split(/[\\/]/).at(-1)?.replace(/\.[^.]+$/, '') || '', description: '', path, groupId: null, favorite: false, runner: 'auto', program: '', interpreterArgs: [], args: [], cwd: null, env: {}, encoding: 'utf8' }
}
export const active = (run?: Run) => !!run && ['running', 'stopping'].includes(run.state)
export const states: Record<RunState, string> = { running: '运行中', stopping: '正在停止', succeeded: '已完成', failed: '失败', stopped: '已停止', interrupted: '已中断' }
export const runners: Record<Runner, string> = { auto: '自动识别', powershell: 'PowerShell', cmd: 'CMD', python: 'Python', node: 'Node.js', direct: '直接执行', custom: '自定义解释器' }
export function fileType(script: Script) {
  if (script.runner !== 'auto') return runners[script.runner]
  const ext = script.path.split('.').at(-1)?.toLowerCase()
  return ({ ps1: 'PowerShell', cmd: 'CMD', bat: 'CMD', py: 'Python', js: 'Node.js', cjs: 'Node.js', mjs: 'Node.js', exe: '可执行文件' } as Record<string, string>)[ext || ''] || '其他'
}
