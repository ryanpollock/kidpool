#!/bin/bash
# Runs playwright tests in background, writes results to /tmp/pw-result.txt
# Usage: ./scripts/run-playwright-bg.sh <specs...>
# Then: check /tmp/pw-result.txt when done
SPECS="$@"
RESULT_FILE=/tmp/pw-result.txt
LOG_FILE=/tmp/pw-$(date +%s).log

echo "RUNNING" > "$RESULT_FILE"
TEST_DB_TARGET=local npx playwright test $SPECS --retries=1 > "$LOG_FILE" 2>&1
EXIT_CODE=$?
echo "DONE exit=$EXIT_CODE log=$LOG_FILE" > "$RESULT_FILE"
