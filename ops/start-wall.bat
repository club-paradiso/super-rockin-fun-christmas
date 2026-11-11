@echo off
rem STUDIO SHALOM - media wall screen (Windows). Shortcut name: 미디어월 시작
rem Set the hub address in wall-hub.txt first (shown in the hub window).
chcp 65001 >nul
title STUDIO SHALOM wall
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-wall.ps1"
if errorlevel 3 (
  echo 미디어월 화면이 이미 떠 있어요. 이 창은 닫아도 돼요.
) else if errorlevel 2 (
  echo Chrome 또는 Edge 가 없어요. 기술 담당에게 알려 주세요.
)
pause
