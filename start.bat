@echo off
cd /d "%~dp0"
echo.
echo  Trench Shock
echo  Open http://127.0.0.1:8080 if the browser does not.
echo.
start "" cmd /c "ping -n 2 127.0.0.1 >nul & start http://127.0.0.1:8080"
python serve.py
if errorlevel 1 py serve.py
pause
