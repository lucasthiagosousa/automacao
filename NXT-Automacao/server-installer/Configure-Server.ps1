param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$Port,

  [string]$DataRoot = "$env:ProgramData\NexoTI\CentralOperacoes",

  [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"
$firewallRuleName = "Nexo TI - Central de Operacoes"

if ($VerifyOnly) {
  $url = "http://127.0.0.1:$Port/login.html"
  $lastError = $null

  for ($attempt = 1; $attempt -le 12; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
        Write-Host "Servidor validado em $url"
        exit 0
      }
    }
    catch {
      $lastError = $_
      Start-Sleep -Seconds 2
    }
  }

  $logPath = Join-Path $DataRoot "logs"
  throw "O serviço foi instalado, mas não respondeu na porta $Port. Consulte os logs em $logPath. Erro: $lastError"
}

$directories = @(
  $DataRoot,
  (Join-Path $DataRoot "dados"),
  (Join-Path $DataRoot "logs")
)

foreach ($directory in $directories) {
  New-Item -Path $directory -ItemType Directory -Force | Out-Null
}

# Somente SYSTEM e administradores locais acessam banco, credenciais e logs.
& icacls.exe $DataRoot /inheritance:r /T /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Não foi possível remover permissões herdadas em $DataRoot." }
& icacls.exe $DataRoot /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Não foi possível configurar permissões da pasta $DataRoot." }
& icacls.exe $DataRoot /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F" /T /C | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Não foi possível proteger a pasta de dados $DataRoot."
}

Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue

New-NetFirewallRule -DisplayName $firewallRuleName -Direction Inbound -Action Allow -Enabled True -Profile Domain,Private -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet | Out-Null

Write-Host "Pasta persistente: $DataRoot"
Write-Host "Firewall da rede corporativa liberado na porta: $Port"

$trayName = "NexoTI-Central-Bandeja"
$trayPath = Join-Path $PSScriptRoot "Bandeja-Central.ps1"
$oldTray = Get-ScheduledTask -TaskName $trayName -ErrorAction SilentlyContinue
if ($oldTray) { Unregister-ScheduledTask -TaskName $trayName -Confirm:$false }
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ('-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "' + $trayPath + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -GroupId "S-1-5-32-545" -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $trayName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
if ([Environment]::UserInteractive -and (Get-Process -Id $PID).SessionId -gt 0) {
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-WindowStyle", "Hidden", "-File", ('"' + $trayPath + '"'))
}
Write-Host "Icone da Central configurado para sessoes de usuario."
