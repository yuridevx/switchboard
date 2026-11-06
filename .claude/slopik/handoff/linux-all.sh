#!/bin/bash
# Полный прогон ветки на чистой копии в WSL: всё во временной папке, HOME свой, живой keeper этой WSL не трогается.
T=$(mktemp -d)
trap 'chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME"
git clone -q --branch demolish3 /mnt/d/Projects/switchboard "$T/repo" || { echo "клон не вышел"; exit 3; }
cd "$T/repo" && git log --oneline -1
npm ci > "$T/ci.log" 2>&1; echo "npm ci: $?"
npx vitest run > "$T/root.log" 2>&1; echo "корень: $?"; grep -E "Tests |FAIL " "$T/root.log" | head -20
node scripts/test-packages.mjs > "$T/pk.log" 2>&1; echo "пакеты: $?"; grep -E "^(FAIL|пакетов)" "$T/pk.log"
grep -E "FAIL " "$T/pk.log" | head -20
npm run gate > /dev/null 2>&1; echo "gate: $?"
npm run typecheck > /dev/null 2>&1; echo "typecheck: $?"
