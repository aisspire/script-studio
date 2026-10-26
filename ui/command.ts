import type { Script } from './api'

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
// Quote the Windows native command line, including empty arguments and trailing slashes.
const nativeArgument = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`

export function powershellCommand(script: Script): string {
  if (!script.path.trim()) return ''
  const ext = script.path.split('.').at(-1)?.toLowerCase() || ''
  const runner = script.runner === 'auto'
    ? ({ ps1: 'powershell', cmd: 'cmd', bat: 'cmd', py: 'python', js: 'node', cjs: 'node', mjs: 'node', exe: 'direct' } as Record<string, string>)[ext]
    : script.runner
  const prefixes: Record<string, string[]> = {
    powershell: ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'],
    python: ['python', '-u'], node: ['node'], direct: [],
  }
  if (!runner || runner === 'custom' && !script.program.trim()) return ''
  if (runner === 'cmd') {
    if (script.args.some(arg => /["\r\n]/.test(arg))) return ''
    // Match the executor's single expansion without changing the terminal's environment.
    const invocation = `""%SCRIPT_STUDIO_CMD_PATH%"${script.args.map((_, i) => ` "%SCRIPT_STUDIO_CMD_ARG_${i}%"`).join('')}"`
    const env = { SCRIPT_STUDIO_CMD_PATH: script.path, ...Object.fromEntries(script.args.map((arg, i) => [`SCRIPT_STUDIO_CMD_ARG_${i}`, arg])) }
    return `& { $start = New-Object System.Diagnostics.ProcessStartInfo; $start.FileName = 'cmd.exe'; $start.UseShellExecute = $false; $start.Arguments = ${literal(`/D /V:OFF /S /C ${invocation}`)}; ${Object.entries(env).map(([key, value]) => `$start.EnvironmentVariables[${literal(key)}] = ${literal(value)}; `).join('')}$process = [System.Diagnostics.Process]::Start($start); $process.WaitForExit(); $global:LASTEXITCODE = $process.ExitCode; $process.Dispose() }`
  }
  const prefix = runner === 'custom' ? [script.program, ...script.interpreterArgs] : prefixes[runner]
  if (!prefix) return ''
  const [program, ...args] = [...prefix, script.path, ...script.args]
  // Legacy PowerShell also misquotes whitespace paths ending in a backslash.
  if (args.some(arg => !arg || arg.includes('"') || arg.endsWith('\\'))) {
    return `Start-Process -FilePath ${literal(program!)} -ArgumentList ${literal(args.map(nativeArgument).join(' '))} -NoNewWindow -Wait`
  }
  return `& ${[program!, ...args].map(literal).join(' ')}`
}
