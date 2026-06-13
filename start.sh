#!/bin/bash
set -e

# Kill any existing processes on our ports
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
lsof -ti:5173 | xargs kill -9 2>/dev/null || true

echo "🚀 Starting Paper Trading Bot..."

# Start backend
echo "  ⚙️  Backend on :3000"
BTC_5MIN_ONLY=true POLL_INTERVAL_MS=10000 npx tsx watch src/index.ts &
BACK_PID=$!

# Start frontend
echo "  🖥️  Dashboard on :5173"
cd dashboard && npx vite --host &
FRONT_PID=$!

# Wait for either to exit
trap "kill $BACK_PID $FRONT_PID 2>/dev/null; exit" INT TERM
wait
