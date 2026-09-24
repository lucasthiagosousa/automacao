$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$raiz = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $raiz

Write-Host ""
Write-Host "Central de Operações de TI - Build local do instalador" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""

function Executar([string]$Comando, [string[]]$Argumentos) {
    Write-Host "> $Comando $($Argumentos -join ' ')" -ForegroundColor DarkGray
    & $Comando @Argumentos
    if ($LASTEXITCODE -ne 0) {
        throw "Comando falhou com código $LASTEXITCODE - $Comando"
    }
}

$node = Get-Command node.exe -ErrorAction Stop
$npm = Get-Command npm.cmd -ErrorAction Stop
$npx = Get-Command npx.cmd -ErrorAction Stop

$nodeVersion = (& $node.Source --version).Trim()
if ($nodeVersion -notmatch '^v(\d+)\.') {
    throw "Não foi possível identificar a versão do Node.js: $nodeVersion"
}

if ([int]$Matches[1] -lt 20) {
    throw "Node.js 20 ou superior é obrigatório. Versão encontrada: $nodeVersion"
}

Write-Host "Node.js detectado: $nodeVersion" -ForegroundColor Green

$winsw = "build\CentralOperacoesTI-Service.exe"
$winswUrl = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe"

Write-Host "Baixando o host do serviço Windows..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $winswUrl -OutFile $winsw -UseBasicParsing

if (-not (Test-Path $winsw)) {
    throw "O host do serviço Windows não foi baixado."
}

if (-not (Test-Path "build\CentralOperacoesTI-Service.xml")) {
    throw "A configuração CentralOperacoesTI-Service.xml não foi encontrada."
}

Executar $npm.Source @("ci")
Executar $npm.Source @(
    "install",
    "--no-save",
    "--package-lock=false",
    "electron@39.2.7",
    "electron-builder@26.0.12"
)

Executar $node.Source @("--check", "server.js")
Executar $node.Source @("--check", "service.js")
Executar $node.Source @("--check", "desktop.js")

Write-Host "Gerando Setup.exe..." -ForegroundColor Cyan
Executar $npx.Source @(
    "electron-builder",
    "--config",
    "electron-builder.yml",
    "--win",
    "nsis"
)

$setup = Get-ChildItem "dist\*Setup*.exe" -ErrorAction Stop |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $setup) {
    throw "O Setup.exe não foi encontrado na pasta dist."
}

$hash = (Get-FileHash $setup.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -Path ($setup.FullName + ".sha256") -Value ($hash + "  " + $setup.Name) -Encoding ASCII

Write-Host ""
Write-Host "Build concluído com sucesso." -ForegroundColor Green
Write-Host "Instalador:" -ForegroundColor Green
Write-Host $setup.FullName -ForegroundColor White
Write-Host "SHA256: $hash" -ForegroundColor White
Write-Host ""
Write-Host "Após a instalação, o serviço esperado é: CentralOperacoesTI" -ForegroundColor DarkGray
Write-Host "Painel de saúde local: http://127.0.0.1:3000/api/health" -ForegroundColor DarkGray
