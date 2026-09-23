param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:ProgramData 'NexoTI\CentralOperacoes'
$logs = Join-Path $root 'logs'
$null = New-Item -ItemType Directory -Force -Path $root, (Join-Path $root 'dados'), $logs
$runner = Join-Path $root 'run-server.cmd'
$task = 'NexoTICentral'
$lines = @(
  '@echo off',
  'set "ELECTRON_RUN_AS_NODE=1"',
  'set "ELECTRON_NO_ATTACH_CONSOLE=1"',
  ':again',
  '"' + $Executable + '" "' + (Join-Path (Split-Path $Executable) 'resources\app.asar\desktop.js') + '" --nexo-server 1>>"' + (Join-Path $logs 'NexoTICentral.out.log') + '" 2>>"' + (Join-Path $logs 'NexoTICentral.err.log') + '"',
  'timeout /t 5 /nobreak >nul',
  'goto again'
)
[IO.File]::WriteAllLines($runner, $lines, [Text.Encoding]::ASCII)
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument ('/d /c "' + $runner + '"')
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Get-NetFirewallRule -DisplayName 'Central de Operações de TI' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Central de Operações de TI' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Domain,Private | Out-Null
Start-ScheduledTask -TaskName $task
