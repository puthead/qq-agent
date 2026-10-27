<#
  启停本机的 QQ agent 伴随服务。

  用法：
    pwsh -File tools/companion-control.ps1 -Action status
    pwsh -File tools/companion-control.ps1 -Action start
    pwsh -File tools/companion-control.ps1 -Action stop

  约定：仓库根目录 = 本脚本的上一级；入口 server-src/index.js；配置 config.json；
  日志写 logs/companion.log；进程号写 data/companion.pid；健康检查 127.0.0.1:17861/health。
#>
param([ValidateSet('status', 'start', 'stop')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $root 'server-src\index.js'
$config = Join-Path $root 'config.json'
$dataDir = Join-Path $root 'data'
$logDir = Join-Path $root 'logs'
$logFile = Join-Path $logDir 'companion.log'
$pidFile = Join-Path $dataDir 'companion.pid'
$healthUrl = 'http://127.0.0.1:17861/health'

function Get-CompanionProcess {
    if (Test-Path -LiteralPath $pidFile) {
        $id = (Get-Content -LiteralPath $pidFile -Raw).Trim()
        if ($id) {
            $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
            if ($proc) { return $proc }
        }
    }
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) } |
        ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
}

switch ($Action) {
    'status' {
        $proc = @(Get-CompanionProcess) | Where-Object { $_ } | Select-Object -First 1
        if ($proc) {
            Write-Output ("进程在跑：PID " + $proc.Id + "，启动于 " + $proc.StartTime)
        }
        else {
            Write-Output '进程不在。'
        }
        try {
            Invoke-RestMethod $healthUrl -TimeoutSec 5 | ConvertTo-Json -Depth 6
        }
        catch {
            Write-Output ('健康检查不可用（' + $healthUrl + '）：' + $_.Exception.Message)
            exit 1
        }
    }
    'start' {
        if (-not (Test-Path -LiteralPath $config)) {
            throw "缺少 $config。先把 config.example.json 复制成 config.json 并填好 apiKey / onebot。"
        }
        if (@(Get-CompanionProcess) | Where-Object { $_ }) {
            Write-Output '服务已经在跑，没有重复启动。'
            exit 0
        }
        New-Item -ItemType Directory -Force -Path $dataDir, $logDir | Out-Null
        $proc = Start-Process -FilePath 'node' `
            -ArgumentList @($entry, '--config', $config) `
            -WorkingDirectory $root -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $logFile -RedirectStandardError ($logFile + '.err')
        Set-Content -LiteralPath $pidFile -Value $proc.Id -Encoding ascii
        Write-Output ("已启动：PID " + $proc.Id + "，日志 " + $logFile)
    }
    'stop' {
        $procs = @(Get-CompanionProcess) | Where-Object { $_ }
        if (-not $procs) {
            Write-Output '进程不在，无需停止。'
            Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
            exit 0
        }
        $procs | ForEach-Object { Stop-Process -Id $_.Id -Force }
        Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
        Write-Output ('已停止：' + ($procs.Id -join ', '))
    }
}
