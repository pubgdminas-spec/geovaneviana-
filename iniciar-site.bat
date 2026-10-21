@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao foi encontrado neste computador.
  echo Instale a versao LTS em https://nodejs.org/ e execute este arquivo novamente.
  pause
  exit /b 1
)
node server.js
pause
