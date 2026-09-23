Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$config = Join-Path $env:ProgramData 'NexoTI\CentralOperacoes\.env'
$port = '3000'
if (Test-Path $config) {
  $line = Get-Content $config | Where-Object { $_ -match '^PORT=\d+$' } | Select-Object -First 1
  if ($line) { $port = $line.Substring(5) }
}
$url = "http://localhost:$port/login.html"
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Application
$icon.Text = 'Nexo TI - Central de Operacoes'
$icon.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Abrir Central de Operacoes')
$open.add_Click({ Start-Process $url })
$status = $menu.Items.Add('Verificar servidor')
$status.add_Click({
  try {
    $response = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 3
    $message = if ($response.StatusCode -eq 200) { 'Servidor ativo.' } else { 'Servidor indisponivel.' }
  } catch { $message = 'Servidor indisponivel. Consulte os logs em C:\ProgramData\NexoTI\CentralOperacoes\logs.' }
  [System.Windows.Forms.MessageBox]::Show($message, 'Nexo TI') | Out-Null
})
$exit = $menu.Items.Add('Fechar icone')
$exit.add_Click({ $icon.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$icon.ContextMenuStrip = $menu
$icon.add_DoubleClick({ Start-Process $url })
try { [System.Windows.Forms.Application]::Run() }
finally { $icon.Dispose(); $menu.Dispose() }
