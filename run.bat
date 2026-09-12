@echo off
title ResumeLLM - Outreach & Resume Intelligence System
cd /d "%~dp0"

echo ======================================================================
echo    ResumeLLM - Outreach & Resume Intelligence Platform
echo    Founder: Shivam Gupta ^| Mastermind Research Technologies
echo ======================================================================
echo.
echo Starting server on http://127.0.0.1:8000 ...
echo Press Ctrl+C in this window to stop the server.
echo.

"%~dp0ven22\Scripts\python.exe" server.py

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Server stopped with error code %ERRORLEVEL%.
)
pause
