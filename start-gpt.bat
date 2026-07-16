@echo off
cd /d %~dp0
set BACKEND=codex
set SPRITE_ENGINE=codex
set CLI_DEBUG=1
set EXCHANGE_DIR=G:\マイドライブ\AI MEGLIO\gpt-exchange
npm start
pause
