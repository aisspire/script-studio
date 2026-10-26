@echo off
"%~dp0script-studio.exe" serve --open %*
exit /b %ERRORLEVEL%
