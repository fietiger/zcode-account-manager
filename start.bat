@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)

node server\index.js
if errorlevel 1 pause
