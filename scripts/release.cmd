@echo off
REM Windows entry point for building and running Vitta Vriksha release builds.
REM
REM Usage:
REM   .\scripts\release.cmd         (builds, installs, launches and follows logs for release)
REM   .\scripts\release.cmd build   (assembles release APK)
REM   .\scripts\release.cmd bundle  (assembles release AAB for Play)
REM   .\scripts\release.cmd install (builds and installs release APK)

setlocal enabledelayedexpansion

set "BASH="

for %%G in (git.exe) do set "GITEXE=%%~$PATH:G"
if defined GITEXE (
  for %%D in ("!GITEXE!") do set "GITDIR=%%~dpD"
  for %%D in ("!GITDIR!..") do set "GITROOT=%%~fD"
  if exist "!GITROOT!\bin\bash.exe" set "BASH=!GITROOT!\bin\bash.exe"
)

if not defined BASH if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "BASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not defined BASH if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" set "BASH=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"

if not defined BASH (
  echo Could not find the bash that ships with Git for Windows.
  echo Install it from https://git-scm.com/download/win
  exit /b 1
)

set "SCRIPT=%~dp0dev"
set "SCRIPT=%SCRIPT:\=/%"

if "%~1"=="" (
  "%BASH%" "%SCRIPT%" run-release
) else if "%~1"=="run" (
  shift
  "%BASH%" "%SCRIPT%" run-release %*
) else if "%~1"=="install" (
  shift
  "%BASH%" "%SCRIPT%" install-release %*
) else if "%~1"=="build" (
  shift
  "%BASH%" "%SCRIPT%" release %*
) else if "%~1"=="stop" (
  shift
  "%BASH%" "%SCRIPT%" stop-release %*
) else if "%~1"=="logs" (
  shift
  "%BASH%" "%SCRIPT%" logs-release %*
) else if "%~1"=="uninstall" (
  shift
  "%BASH%" "%SCRIPT%" uninstall-release %*
) else (
  "%BASH%" "%SCRIPT%" %*
)

exit /b %ERRORLEVEL%
