@echo off
rem STUDIO SHALOM - after the event: what is still on this laptop and the USB (Windows, read-only). Shortcut name: 삭제 확인
chcp 65001 >nul
cd /d "%~dp0.."
node scripts\event-check.mjs
pause
