@echo off
setlocal

set "APP_DIR=C:\Users\gabno\Documents\Codex\2026-07-07\https-acestudio-ai-pdf-to-musicxml\outputs\pdf-to-musicxml-webapp"
set "APP_URL=http://localhost:4173/"

echo Zatrzymuje poprzednia wersje aplikacji, jesli dziala...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$connections = Get-NetTCPConnection -LocalPort 4173 -ErrorAction SilentlyContinue; foreach ($connection in $connections) { Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue }"

timeout /t 2 /nobreak >nul

if not exist "%APP_DIR%\server.js" (
  echo Nie znaleziono server.js w:
  echo %APP_DIR%
  echo.
  pause
  exit /b 1
)

echo Uruchamiam aplikacje PDF na MusicXML...
start "PDF na MusicXML - serwer" /D "%APP_DIR%" cmd /k node server.js
timeout /t 3 /nobreak >nul
start "" "%APP_URL%"

endlocal
