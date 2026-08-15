$ErrorActionPreference = "Stop"

$targetDir = "D:\Software\maestro"
if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}

$zipFile = "D:\Software\maestro\maestro.zip"
$downloadUrl = "https://github.com/mobile-dev-inc/Maestro/releases/download/cli-2.8.0/maestro.zip"

Write-Host "Downloading Maestro CLI via curl to $zipFile..." -ForegroundColor Cyan
curl.exe -L -o "$zipFile" "$downloadUrl"

Write-Host "Extracting Maestro to $targetDir..." -ForegroundColor Cyan
Expand-Archive -Path $zipFile -DestinationPath $targetDir -Force
Remove-Item $zipFile -Force

# Configure Environment Variables (User PATH and JAVA_HOME)
$binPath = "D:\Software\maestro\bin"
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$binPath*") {
    Write-Host "Adding $binPath to User PATH..." -ForegroundColor Yellow
    [Environment]::SetEnvironmentVariable("Path", "$currentPath;$binPath", "User")
}

$javaHome = "D:\Program Files\Android Studio\jbr"
Write-Host "Setting JAVA_HOME to $javaHome..." -ForegroundColor Yellow
[Environment]::SetEnvironmentVariable("JAVA_HOME", $javaHome, "User")
$env:JAVA_HOME = $javaHome
$env:PATH = "$env:PATH;$binPath"

Write-Host "Testing Maestro installation..." -ForegroundColor Cyan
& "$binPath\maestro.bat" --version
