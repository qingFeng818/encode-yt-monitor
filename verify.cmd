@echo off
cd /d "%~dp0"
call npx vitest run > verify-vitest.txt 2>&1
echo VITEST_EXIT=%ERRORLEVEL% >> verify-vitest.txt
call npx tsc --noEmit > verify-tsc.txt 2>&1
echo TSC_EXIT=%ERRORLEVEL% >> verify-tsc.txt
echo DONE > verify-done.txt
