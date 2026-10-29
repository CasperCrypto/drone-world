#!/bin/sh
# Builds and runs the flight-model tests with strict warnings (Unreal treats
# shadowed variables as errors, so the tests do too).
set -e
cd "$(dirname "$0")"
OUT="${TMPDIR:-/tmp}/drone_flight_model_test"
${CXX:-g++} -std=c++17 -O2 -Wall -Wextra -Wshadow -Wconversion -Werror flight_model_test.cpp -o "$OUT"
"$OUT"
