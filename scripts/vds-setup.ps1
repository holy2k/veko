<#
.SYNOPSIS
  Windows VDS kurulum ve ortam hazirlama scripti (veko).
.DESCRIPTION
  - Node.js 22+ ve Edge/Chrome kurulumunu dogrular.
  - npm bagimliliklarini yukler, .env yoksa .env.example dosyasindan kopyalar.
  - RemoteDesktop_SuppressWhenMinimized = 2 kayit defteri ayarini uygular (RDP kucultulunce Chrome/Edge durmaz).
  - Istege bagli olarak PM2 kurar (-InstallPm2) veya etkilesimli Windows Gorev Zamanlayicisi kaydi ekler (-RegisterScheduledTask).
#>
[CmdletBinding()]
param(
  [switch]$InstallPm2,
  [switch]$RegisterScheduledTask,
  [string]$TaskName = 'Veko'
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Write-Host "[veko] Proje dizini: $ProjectRoot" -ForegroundColor Cyan

# 1. Node.js >= 22 kontrolu
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw 'Node.js bulunamadi. Lutfen Node.js 22 LTS veya uzeri kurun: https://nodejs.org/'
}

$nodeVersionRaw = (& node -v).Trim()
if ($nodeVersionRaw -notmatch '^v?(\d+)\.') {
  throw "Node.js surumu okunamadi: $nodeVersionRaw"
}
$nodeMajor = [int]$Matches[1]
if ($nodeMajor -lt 22) {
  throw "Node.js >= 22 gerekli (bulunan: $nodeVersionRaw). Lutfen guncelleyin."
}
Write-Host "[OK] Node.js $nodeVersionRaw ($($nodeCmd.Source))" -ForegroundColor Green

# 2. Chrome / Edge kontrolu
$browserPaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:LocalAppData\Microsoft\Edge\Application\msedge.exe"
)
$foundBrowser = $browserPaths | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($foundBrowser) {
  Write-Host "[OK] Tarayici bulundu: $foundBrowser" -ForegroundColor Green
} else {
  Write-Warning 'Sistemde Chrome veya Edge standart yolda bulunamadi. .env icinde CHROME_EXECUTABLE_PATH belirtmeniz gerekebilir.'
}

# 3. npm bagimliliklari ve veri klasoru
Push-Location $ProjectRoot
try {
  Write-Host '[veko] npm install calistiriliyor...' -ForegroundColor Cyan
  & npm install
  if ($LASTEXITCODE -ne 0) {
    throw "npm install hata koduyla cikti: $LASTEXITCODE"
  }

  $dataDir = Join-Path $ProjectRoot 'data'
  if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  }

  $envPath = Join-Path $ProjectRoot '.env'
  $envExamplePath = Join-Path $ProjectRoot '.env.example'
  if (-not (Test-Path $envPath) -and (Test-Path $envExamplePath)) {
    Copy-Item -Path $envExamplePath -Destination $envPath
    Write-Host '[BILGI] .env dosyasi .env.example uzerinden olusturuldu. Lutfen OWNER_PHONE ve GEMINI_API_KEY alanlarini doldurun.' -ForegroundColor Yellow
  } elseif (Test-Path $envPath) {
    Write-Host '[OK] Mevcut .env korundu.' -ForegroundColor Green
  }

  if ($InstallPm2) {
    Write-Host '[veko] PM2 kuruluyor...' -ForegroundColor Cyan
    & npm install -g pm2
    if ($LASTEXITCODE -ne 0) {
      throw "PM2 kurulumu basarisiz: $LASTEXITCODE"
    }
    Write-Host '[OK] PM2 kuruldu. Baslatmak icin: pm2 start src/index.js --name veko' -ForegroundColor Green
  }
}
finally {
  Pop-Location
}

# 4. RDP kucultme koruma kaydi (RemoteDesktop_SuppressWhenMinimized = 2)
function Set-RdpSuppressKey {
  param([string]$RegistryPath)
  if (-not (Test-Path $RegistryPath)) {
    New-Item -Path $RegistryPath -Force | Out-Null
  }
  New-ItemProperty `
    -Path $RegistryPath `
    -Name 'RemoteDesktop_SuppressWhenMinimized' `
    -Value 2 `
    -PropertyType DWord `
    -Force | Out-Null
}

Set-RdpSuppressKey -RegistryPath 'HKCU:\Software\Microsoft\Terminal Server Client'
Write-Host '[OK] HKCU RemoteDesktop_SuppressWhenMinimized = 2 ayarlandi.' -ForegroundColor Green

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
  Set-RdpSuppressKey -RegistryPath 'HKLM:\SOFTWARE\Microsoft\Terminal Server Client'
  if (Test-Path 'HKLM:\SOFTWARE\Wow6432Node') {
    Set-RdpSuppressKey -RegistryPath 'HKLM:\SOFTWARE\Wow6432Node\Microsoft\Terminal Server Client'
  }
  Write-Host '[OK] HKLM RemoteDesktop_SuppressWhenMinimized = 2 ayarlandi.' -ForegroundColor Green
} else {
  Write-Warning 'HKLM kayit defteri ayari icin PowerShelli Yonetici (Administrator) olarak calistirabilirsiniz.'
}

# 5. Istege bagli Task Scheduler gorevi (Interactive session, Chrome Headless=false uyumlu)
if ($RegisterScheduledTask) {
  if (-not $isAdmin) {
    Write-Warning 'Zamanlanmis gorev (-RegisterScheduledTask) kaydetmek icin PowerShelli Yonetici (Run as Administrator) olarak calistirmaniz gerekir. Lutfen Yonetici PowerShell acip komutu tekrar calistirin.'
  } else {
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction `
      -Execute $nodeCmd.Source `
      -Argument 'src/index.js' `
      -WorkingDirectory $ProjectRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -RestartCount 5 `
      -RestartInterval (New-TimeSpan -Minutes 1) `
      -ExecutionTimeLimit (New-TimeSpan -Days 3650)

    Register-ScheduledTask `
      -TaskName $TaskName `
      -Action $action `
      -Trigger $trigger `
      -Settings $settings `
      -User $currentUser `
      -RunLevel Limited `
      -Force | Out-Null

    Write-Host "[OK] Zamanlanmis gorev kaydedildi: $TaskName (Kullanici: $currentUser)" -ForegroundColor Green
  }
}

Write-Host ''
Write-Host '=== Sonraki Adimlar ===' -ForegroundColor Cyan
Write-Host "1. $ProjectRoot\.env dosyasini kontrol edin (OWNER_PHONE, GEMINI_API_KEY, ASSISTANT_NAME, CHROME_HEADLESS=false)."
Write-Host '2. Ilk calistirmada QR okutmak icin: npm start'
Write-Host '3. RDP baglantisini tarayiciyi dondurmadan kapatmak icin scripts\disconnect-rdp.bat dosyasini Yonetici olarak calistirin.'
Write-Host '   PM2 kullaniyorsaniz: pm2 start src/index.js --name veko'
