#!/bin/sh
# Runs every test. None of them need the network, a database or a browser, so
# this is safe to run before any commit and takes about a second.
#
#   sh tools/test_all.sh
#
# Run from the repository root.
set -e
failed=0
for t in tools/test_*.mjs; do
  printf '%-26s' "$(basename "$t")"
  if out=$(node "$t" 2>&1); then
    echo "$out" | tail -1
  else
    echo "УПАЛ"
    echo "$out" | tail -5 | sed 's/^/    /'
    failed=1
  fi
done
[ "$failed" = 0 ] && echo "\nвсе тесты прошли" || { echo "\nесть падения"; exit 1; }
