@echo off
cd /d %~dp0
set BACKEND=codex
set CLI_DEBUG=1
npm start
pause
