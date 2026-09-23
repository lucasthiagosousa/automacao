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
$legacyUninstaller = Join-Path ${env:ProgramFiles(x86)} 'Nexo TI\Painel de Estoque\unins000.exe'
if (Test-Path $legacyUninstaller) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $legacyUninstaller
  $info.Arguments = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART'
  $info.UseShellExecute = $false
  $process = [System.Diagnostics.Process]::Start($info)
  if (-not $process.WaitForExit(120000)) { throw 'Desinstalacao do painel antigo excedeu dois minutos.' }
  if ($process.ExitCode -ne 0) { throw "Falha ao remover painel antigo: $($process.ExitCode)." }
}
Write-Host 'Painel antigo removido. Dados antigos preservados.'
