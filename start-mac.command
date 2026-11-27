#!/bin/sh
# Double-click to open the interface in your browser. Close the window to stop.
cd "$(dirname "$0")" || exit 1
(sleep 1; open "http://127.0.0.1:8765/") &
exec node src/cli.ts serve
