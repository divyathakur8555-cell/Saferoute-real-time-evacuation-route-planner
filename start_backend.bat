@echo off
cd /d "%~dp0backend"
python -m pip install -r requirements.txt
echo Starting SafeRoute on http://localhost:8000 ...
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
pause
