# Set User Environment Variables permanently
$javaHome = "D:\Program Files\Android Studio\jbr"
$javaBin = "D:\Program Files\Android Studio\jbr\bin"
$maestroBin = "D:\Software\maestro\bin"
$platformTools = "C:\Users\sagar\AppData\Local\Android\Sdk\platform-tools"

[Environment]::SetEnvironmentVariable("JAVA_HOME", $javaHome, "User")

$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
$pathsToAdd = @($maestroBin, $javaBin, $platformTools)

$newPath = $currentPath
foreach ($p in $pathsToAdd) {
    if ($newPath -notlike "*$p*") {
        $newPath = "$p;$newPath"
    }
}
[Environment]::SetEnvironmentVariable("Path", $newPath, "User")

# Set for current process
$env:JAVA_HOME = $javaHome
$env:PATH = "$maestroBin;$javaBin;$platformTools;$env:PATH"

Write-Host "Verifying Java..." -ForegroundColor Cyan
& "$javaBin\java.exe" -version

Write-Host "`nVerifying Maestro..." -ForegroundColor Cyan
& "$maestroBin\maestro.bat" --version
