@echo off
setlocal

set "APP_DIR=C:\Users\gabno\Documents\Codex\2026-07-07\https-acestudio-ai-pdf-to-musicxml\outputs\pdf-to-musicxml-webapp"
set "APP_URL=http://localhost:4173/"

if not exist "%APP_DIR%\package.json" (
  echo Nie znaleziono aplikacji w:
  echo %APP_DIR%
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Nie znaleziono Node.js. Zainstaluj Node.js albo sprawdz PATH.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri 'http://localhost:4173/api/engine' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
  echo Uruchamiam aplikacje PDF na MusicXML...
  start "PDF na MusicXML - serwer" /D "%APP_DIR%" cmd /k node server.js
  timeout /t 3 /nobreak >nul
) else (
  echo Aplikacja juz dziala.
)

start "" "%APP_URL%"
endlocal
