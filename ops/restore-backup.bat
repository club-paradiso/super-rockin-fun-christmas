@echo off
rem FOLLOW THE LIGHTS - restore the hub from the USB backup (Windows). Shortcut name: 백업에서 복구
chcp 65001 >nul
cd /d "%~dp0.."
set /p BACKUP="USB backup folder, e.g. E:\ (USB 백업 폴더): "
node scripts\hub-restore.mjs "%BACKUP%"
pause
