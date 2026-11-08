@echo off
setlocal
title AI Roundtable
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found.
  echo   Please install the LTS version from https://nodejs.org and then run start.bat again.
  echo.
  pause
  exit /b 1
)
node server.js %*
if errorlevel 1 (
  echo.
  echo   AI Roundtable stopped because of an error. See the message above.
  echo.
  pause
)
