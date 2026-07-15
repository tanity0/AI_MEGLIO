@echo off
cd /d %~dp0
REM ============================================================
REM  Quick-gen wizard with Gemini image engine (Section 53)
REM  1. Get a free API key: https://aistudio.google.com/apikey
REM  2. Paste it after the = below (no spaces, no quotes)
REM  3. Double-click this file, then open:
REM     http://localhost:8787/autosprite.html
REM ============================================================
set GEMINI_API_KEY=
REM Optional: model override (default: gemini-2.5-flash-image)
REM set GEMINI_MODEL=gemini-2.5-flash-image
npm start
pause
