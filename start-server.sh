#!/usr/bin/env bash
# Start the optional ASTRAQ FastAPI engine on port 8000.
set -e
cd "$(dirname "$0")/server"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  . .venv/bin/activate
  pip install -r requirements.txt
else
  . .venv/bin/activate
fi
python -m uvicorn app.main:app --reload --port 8000
