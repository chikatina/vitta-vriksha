param(
    [ValidateSet('patch', 'minor', 'major', 'code-only')]
    [string]$Type = 'patch',

    [int]$VersionCode = 0,
    [string]$VersionName = '',
    [switch]$Build
)

$ErrorActionPreference = "Stop"

$gradlePath = "app\build.gradle"
$aboutPath = "app\src\main\assets\www\js\views\about.js"

if (-not (Test-Path $gradlePath)) {
    Write-Error "Could not find $gradlePath. Please run from repository root."
    exit 1
}

# 1. Read current version from app/build.gradle
$gradleContent = Get-Content -Path $gradlePath -Raw

if ($gradleContent -notmatch 'versionCode\s+(\d+)') {
    Write-Error "Could not parse current versionCode from $gradlePath"
    exit 1
}
$currentCode = [int]$matches[1]

if ($gradleContent -notmatch 'versionName\s+"([^"]+)"') {
    Write-Error "Could not parse current versionName from $gradlePath"
    exit 1
}
$currentName = $matches[1]

# 2. Determine new versionCode
$newCode = if ($VersionCode -gt 0) { $VersionCode } else { $currentCode + 1 }

# 3. Determine new versionName
$newName = $currentName
if ($VersionName -ne '') {
    $newName = $VersionName
} elseif ($Type -eq 'code-only') {
    $newName = $currentName
} else {
    $parts = $currentName.Split('.')
    $major = if ($parts.Length -gt 0) { [int]$parts[0] } else { 1 }
    $minor = if ($parts.Length -gt 1) { [int]$parts[1] } else { 0 }
    $patch = if ($parts.Length -gt 2) { [int]$parts[2] } else { 0 }

    switch ($Type) {
        'major' {
            $major++
            $minor = 0
            $patch = 0
        }
        'minor' {
            $minor++
            $patch = 0
        }
        'patch' {
            $patch++
        }
    }
    $newName = "$major.$minor.$patch"
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Version Bump: Vitta Vriksha" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Previous: versionCode $currentCode | versionName `"$currentName`"" -ForegroundColor DarkGray
Write-Host "New:      versionCode $newCode | versionName `"$newName`"" -ForegroundColor Green

# 4. Update app/build.gradle
$updatedGradle = $gradleContent -replace 'versionCode\s+\d+', "versionCode $newCode"
$updatedGradle = $updatedGradle -replace 'versionName\s+"[^"]+"', "versionName `"$newName`""
Set-Content -Path $gradlePath -Value $updatedGradle -NoNewline
Write-Host "[+] Updated $gradlePath" -ForegroundColor Green

# 5. Update views/about.js
if (Test-Path $aboutPath) {
    $aboutContent = Get-Content -Path $aboutPath -Raw
    $updatedAbout = $aboutContent -replace '<div class="caption">Version\s+[^<]+</div>', "<div class=`"caption`">Version $newName</div>"
    Set-Content -Path $aboutPath -Value $updatedAbout -NoNewline
    Write-Host "[+] Updated $aboutPath" -ForegroundColor Green
}

# 6. Update tools/build-release.ps1 if build is requested
if ($Build) {
    Write-Host "`n=== Running Release Build ===" -ForegroundColor Cyan
    & powershell -ExecutionPolicy Bypass -File .\tools\build-release.ps1
}

Write-Host "`n[+] Version bump complete!" -ForegroundColor Green
