@echo off
setlocal
cd /d "%~dp0"
title POSPOINT RX5000 TEST BRIDGE V3 - CANCEL RETAIL

set "JAVA_EXE="

if exist "%~dp0runtime\java\bin\java.exe" set "JAVA_EXE=%~dp0runtime\java\bin\java.exe"
if not defined JAVA_EXE if exist "%~dp0..\runtime\java\bin\java.exe" set "JAVA_EXE=%~dp0..\runtime\java\bin\java.exe"
if not defined JAVA_EXE if exist "C:\Program Files\Java\jdk-17\bin\java.exe" set "JAVA_EXE=C:\Program Files\Java\jdk-17\bin\java.exe"
if not defined JAVA_EXE (
  where java >nul 2>nul
  if not errorlevel 1 set "JAVA_EXE=java"
)

if not defined JAVA_EXE (
  echo.
  echo FOUT: Java 11 of hoger niet gevonden.
  echo Plaats Java onder runtime\java\bin\java.exe of installeer Java 11 of hoger.
  echo.
  pause
  exit /b 1
)

set "PATH=%CD%\lib;%PATH%"
set "CTEP=9000"
set "HTTP=3210"
if defined WORLDLINE_CTEP_PORT set "CTEP=%WORLDLINE_CTEP_PORT%"
if defined WORLDLINE_CTEP_HTTP_PORT set "HTTP=%WORLDLINE_CTEP_HTTP_PORT%"

echo ============================================================
echo POSPOINT RX5000 TEST BRIDGE V3 - CANCEL RETAIL
echo ============================================================
echo HTTP : http://127.0.0.1:%HTTP%
echo C-TEP: 0.0.0.0:%CTEP%
echo Java : %JAVA_EXE%
echo.
echo BELANGRIJK:
echo - Sluit eerst de oude Worldline bridge.
echo - RX5000 moet naar het IP van deze PC op poort %CTEP%.
echo - Testtool gebruikt HTTP poort %HTTP%.
echo.
echo Bridge wordt gestart...
echo.

"%JAVA_EXE%" -Djava.library.path="%CD%\lib" -cp ".;lib\JEasyCTEP-3.4.0.jar" WorldlineCtepBrowserBridge --mode tcp --ctep-port %CTEP% --http-port %HTTP%

echo.
echo Bridge gestopt.
pause
