# Execute como administrador no próprio servidor após instalar.
$ErrorActionPreference = 'Stop'
$target = Join-Path $env:ProgramData 'NexoTI\CentralOperacoes\.env'
$email = Read-Host 'E-mail de integração NXT'
$password = Read-Host 'Senha de integração NXT' -AsSecureString
$snmp = Read-Host 'Comunidade SNMP' -AsSecureString
$plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($password))
$plainSnmp = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($snmp))
try {
  foreach ($item in @($email, $plainPassword, $plainSnmp)) {
    if ($item -match '[\r\n]') { throw 'Os valores não podem conter quebras de linha.' }
  }
  $contents = "NXT_EMAIL=$email`r`nNXT_PASSWORD=$plainPassword`r`nNXT_SNMP_COMMUNITY=$plainSnmp`r`n"
  [IO.File]::WriteAllText($target, $contents, [Text.UTF8Encoding]::new($false))
  & icacls.exe $target /inheritance:r /grant:r 'SYSTEM:F' 'Administrators:F' | Out-Null
  Stop-ScheduledTask -TaskName 'NexoTICentral' -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName 'NexoTICentral'
  Write-Host 'Configuração salva. Verifique o serviço e os logs em ProgramData\NexoTI\CentralOperacoes.'
} finally {
  $plainPassword = $null
  $plainSnmp = $null
}
