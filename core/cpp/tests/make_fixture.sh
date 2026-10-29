#!/bin/sh
# Regenerates core/fixtures/trajectory.json from the C++ model.
set -e
cd "$(dirname "$0")"
OUT="${TMPDIR:-/tmp}/drone_trajectory"
${CXX:-g++} -std=c++17 -O2 -Wall -Wextra -Wshadow -Werror trajectory.cpp -o "$OUT"
"$OUT" > ../../fixtures/trajectory.json
echo "wrote core/fixtures/trajectory.json"
