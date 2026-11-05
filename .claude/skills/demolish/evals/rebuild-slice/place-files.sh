#!/usr/bin/env bash
set -eu
cp -R "$(dirname "$0")/files/." .
git init -q -b main
git config user.name eval
git config user.email eval@example.com
git add -A
git commit -qm initial
git tag initial
