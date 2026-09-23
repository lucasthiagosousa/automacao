$ErrorActionPreference = 'Stop'
$legacyRoot = Join-Path $env:ProgramData 'NexoTI\PainelEstoque'
foreach ($name in @('NexoTI-PainelEstoque', 'NexoTI-PainelEstoque-Bandeja')) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
  }
}
$legacyServer = Join-Path $legacyRoot 'app\server.js'
$legacyTray = Join-Path $legacyRoot 'Bandeja.ps1'
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and ($_.CommandLine.Contains($legacyServer) -or $_.CommandLine.Contains($legacyTray))
} | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Host 'Tarefas do painel antigo removidas. Dados antigos preservados.'
