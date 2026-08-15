@echo off
setlocal
if not defined JAVA_HOME set "JAVA_HOME=D:\Program Files\Android Studio\jbr"
set "PATH=D:\Software\maestro\bin;D:\Program Files\Android Studio\jbr\bin;C:\Users\sagar\AppData\Local\Android\Sdk\platform-tools;%PATH%"

call "D:\Software\maestro\bin\maestro.bat" %*
endlocal
