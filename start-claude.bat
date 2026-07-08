@echo off
cd /d %~dp0
set BACKEND=cli
set CLI_PATH=C:\Users\tanity\AppData\Local\Microsoft\WinGet\Packages\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\claude.exe
set CLI_DEBUG=1
set EXCHANGE_DIR=G:\マイドライブ\AI MEGLIO\gpt-exchange
npm start
pause
