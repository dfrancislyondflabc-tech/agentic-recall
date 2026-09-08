@echo off
REM Double-click this. It works out where you put this folder, checks that Node actually runs
REM here, and opens a page with the exact text to paste into Claude's config.
REM
REM ONE ENTRY POINT, BOTH DOWNLOADS (MEM-70). The portable zip bundles runtime\node.exe; the
REM plain zip does not and uses the Node already on this machine. Everything after that is
REM identical, so there is one thing to double-click and one page at the end of it. The zips
REM used to also carry dist\setup.cmd, which cd'd into dist\ (no package.json there) and ran
REM a dependency install that could only fail -- two Windows testers followed it, five months
REM apart, before either found this file.
setlocal
cd /d "%~dp0"
echo.
echo   Setting up the Memory server for Claude...
echo.
set "NODE=%~dp0runtime\node.exe"
if exist "%NODE%" goto :haveNode
where node >nul 2>nul && set "NODE=node" && goto :haveNode
echo   ERROR: this download does not bundle a Node runtime, and Node is not installed.
echo   Install Node 20 or newer from https://nodejs.org, then run this again.
echo   ^(The portable download needs nothing installed - it carries its own runtime.^)
pause
exit /b 1
:haveNode
"%NODE%" "%~dp0packaging\setup-page.mjs"
set RC=%ERRORLEVEL%
echo.
if %RC% NEQ 0 (
  echo   The check FAILED. SETUP.html explains what went wrong.
) else (
  echo   Ready. Opening SETUP.html...
)
start "" "%~dp0SETUP.html"
echo.
pause
