@echo off
setlocal EnableExtensions

echo [veko] RDP oturumunu konsola devretme kontrol ediliyor...

net session >nul 2>&1
if errorlevel 1 (
    echo [HATA] Bu script Yonetici [Run as Administrator] olarak calistirilmalidir.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$sid = [Diagnostics.Process]::GetCurrentProcess().SessionId; if ($sid -le 0) { Write-Host '[HATA] Aktif oturum ID gecersiz.'; exit 1 }; $sys = Join-Path $env:SystemRoot 'System32'; $q = & (Join-Path $sys 'query.exe') session 2>$null; if ($q -match '^\s*>console\b') { Write-Host ('[BILGI] Oturum zaten Console uzerinde calisiyor [ID ' + $sid + ']. Islem gerekmiyor.'); exit 0 }; Write-Host ('[BILGI] Oturum [ID ' + $sid + '] Console uzerine aktariliyor [Chrome/Edge WebRTC acik kalacak]...'); & (Join-Path $sys 'tscon.exe') $sid /dest:console /v; exit $LASTEXITCODE"
if errorlevel 1 (
    echo [HATA] tscon basarisiz oldu. Windows Server uzerinde Yonetici yetkisiyle calistiginizdan emin olun.
    pause
    exit /b 1
)

exit /b 0
