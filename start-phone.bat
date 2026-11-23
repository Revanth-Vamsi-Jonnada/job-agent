@echo off
rem Starts Job Agent so your phone (on the same Wi-Fi) can open it.
rem The phone address is printed below, e.g. http://192.168.1.20:5178
cd /d "%~dp0"
node server.js --phone
pause
