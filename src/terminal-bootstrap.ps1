$ErrorActionPreference = 'Stop'
$process = $null
try {
    $json = [Environment]::GetEnvironmentVariable('SCRIPT_STUDIO_TERMINAL_SNAPSHOT', 'Process')
    [Environment]::SetEnvironmentVariable('SCRIPT_STUDIO_TERMINAL_SNAPSHOT', $null, 'Process')
    if ([string]::IsNullOrEmpty($json)) { throw '缺少外部终端启动配置。' }
    $launch = ConvertFrom-Json -InputObject $json
    $json = $null
    if ($launch.error) { throw $launch.error }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $false
    $start.FileName = $launch.program
    $start.Arguments = $launch.arguments
    $start.WorkingDirectory = $launch.cwd
    foreach ($entry in $launch.env.PSObject.Properties) {
        $start.EnvironmentVariables[$entry.Name] = [string]$entry.Value
    }
    $start.EnvironmentVariables.Remove('SCRIPT_STUDIO_TERMINAL_SNAPSHOT')
    $process = [System.Diagnostics.Process]::Start($start)
    $launch = $null
    $start = $null
    while (-not $process.WaitForExit(100)) { }
    $global:LASTEXITCODE = $process.ExitCode
    Write-Host ''
    Write-Host ('脚本已结束，退出码 {0}。可继续使用此终端。' -f $global:LASTEXITCODE)
} catch {
    $global:LASTEXITCODE = 1
    Write-Host ('Script Studio：无法启动或等待脚本，请检查解释器与文件路径：{0}' -f $_.Exception.Message) -ForegroundColor Red
} finally {
    [Environment]::SetEnvironmentVariable('SCRIPT_STUDIO_TERMINAL_SNAPSHOT', $null, 'Process')
    if ($null -ne $process) { $process.Dispose() }
    $launch = $null
    $json = $null
    $start = $null
}
