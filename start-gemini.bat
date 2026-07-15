@echo off
cd /d %~dp0
REM ============================================================
REM  Quick-gen wizard with Gemini image engine (Section 53)
REM  The API key is asked at launch and is NEVER saved to a file
REM  (kept only in this window's environment until you close it).
REM  Get a free key: https://aistudio.google.com/apikey
REM  After start, open: http://localhost:8787/autosprite.html
REM ============================================================
if not "%GEMINI_API_KEY%"=="" goto run
set /p GEMINI_API_KEY=Paste GEMINI_API_KEY and press Enter (not saved to disk):
:run
npm start
pause
