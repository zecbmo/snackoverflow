@echo off
rem Double-click to stop the local Snack Overflow test environment. Your test data is kept.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\test-env.ps1" stop
echo.
pause
