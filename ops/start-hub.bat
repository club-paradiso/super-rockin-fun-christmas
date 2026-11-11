@echo off
rem STUDIO SHALOM - hub + booth screen (Windows). Desktop shortcut name: 허브와 부스 시작
rem Keep this window open while the event runs. Closing it stops the hub.
chcp 65001 >nul
cd /d "%~dp0.."
title STUDIO SHALOM hub
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Ask the tech lead. ^(Node.js 가 설치되지 않았어요.^)
  pause
  exit /b 1
)
node scripts\hub-start.mjs %*
echo.
echo The hub has stopped. ^(허브가 꺼졌어요.^)
pause
