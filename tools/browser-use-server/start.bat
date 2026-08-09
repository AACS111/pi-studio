@echo off
rem Start the browser-use control sidecar (127.0.0.1:17865)
setlocal
cd /d "%~dp0"
set "PY=%~dp0.venv\Scripts\python.exe"
if not exist "%PY%" (
  echo [ERROR] venv not found. Run: uv venv .venv --python 3.12 ^&^& uv pip install --python .venv/Scripts/python.exe browser-use fastapi "uvicorn[standard]"
  exit /b 1
)
rem Skip if already listening on 17865
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 17865 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if %errorlevel%==0 (
  echo browser-use sidecar already running on 127.0.0.1:17865
  exit /b 0
)
start "pi-browser-use" /min "%PY%" server.py
echo started browser-use sidecar on 127.0.0.1:17865 (log: tools/browser-use-server/server.log)
