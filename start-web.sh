#!/usr/bin/env bash
# Start the ASTRAQ web app (includes the in-browser simulation engine).
set -e
cd "$(dirname "$0")/web"
[ -d node_modules ] || npm install
npm run dev
