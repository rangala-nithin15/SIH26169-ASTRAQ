@echo off
REM Start the ASTRAQ web app (includes the in-browser simulation engine).
cd /d "%~dp0web"
if not exist node_modules call npm install
call npm run dev
