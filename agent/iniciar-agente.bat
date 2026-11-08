@echo off
title Agente de impresion - Restaurante Loryand
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Falta Node.js. Descargalo de https://nodejs.org ^(version LTS^), instalalo y vuelve a abrir este archivo.
  pause
  exit /b 1
)
:loop
node agente.mjs
echo El agente se ha detenido. Se reinicia en 5 segundos...
timeout /t 5 >nul
goto loop
