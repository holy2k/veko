@echo off
setlocal EnableExtensions

echo [veko] RDP oturumunu konsola devretme kontrol ediliyor...

net session >nul 2>&1
if errorlevel 1 (
    echo [HATA] Bu script Yonetici [Run as Administrator] olarak calistirilmalidir.
    pause
    exit /b 1
)

if not defined SESSIONNAME (
    echo [HATA] SESSIONNAME ortam degiskeni bulunamadi.
    pause
    exit /b 1
)

if /i "%SESSIONNAME%"=="Console" (
    echo [BILGI] Oturum zaten Console uzerinde calisiyor. Islem gerekmiyor.
    exit /b 0
)

echo [BILGI] "%SESSIONNAME%" oturumu Console uzerine aktariliyor [Chrome/Edge WebRTC acik kalacak]...
"%SystemRoot%\System32\tscon.exe" "%SESSIONNAME%" /dest:console /v
if errorlevel 1 (
    echo [HATA] tscon basarisiz oldu. Windows Server uzerinde Yonetici yetkisiyle calistiginizdan emin olun.
    pause
    exit /b 1
)

exit /b 0
