@echo off
rem Double-click to start a local Snack Overflow test environment and open it in your browser.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\test-env.ps1" start
echo.
pause
