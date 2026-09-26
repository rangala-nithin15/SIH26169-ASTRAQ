@echo off
REM Start the optional ASTRAQ FastAPI engine on port 8000.
cd /d "%~dp0server"
if not exist .venv (
  python -m venv .venv
  call .venv\Scripts\activate
  pip install -r requirements.txt
) else (
  call .venv\Scripts\activate
)
python -m uvicorn app.main:app --reload --port 8000
