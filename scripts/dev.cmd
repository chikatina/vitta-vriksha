@echo off
REM Windows entry point for scripts/dev.
REM
REM The real script is bash, so there is one implementation to keep correct rather than
REM two that drift. Git for Windows ships the bash it needs, so if git works, so does this.

setlocal enabledelayedexpansion

set "BASH="

REM Derive bash from git itself. That finds Git wherever it was installed, which a list of
REM guessed directories does not. Note that the bash.exe in System32 is WSL, which cannot
REM see Windows drive paths, so it is deliberately not used.
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

REM Backslashes are escape characters to bash, so hand it a forward slash path.
set "SCRIPT=%~dp0dev"
set "SCRIPT=%SCRIPT:\=/%"

"%BASH%" "%SCRIPT%" %*
exit /b %ERRORLEVEL%
