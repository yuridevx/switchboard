#!/bin/bash
# Linux-тесты keeper во временной папке вместе с Go: живой keeper этой WSL не трогается, Go после прогона удаляется. $2 — файл полного вывода.
T=$(mktemp -d)
trap 'chmod -R u+w "$T"; rm -rf "$T"' EXIT
OUT=${2:-$T/out.txt}
curl -fsSL --max-time 120 https://go.dev/dl/go1.27.0.linux-amd64.tar.gz | tar -xz -C "$T" || { echo "Go не скачался"; exit 3; }
export GOROOT="$T/go" GOPATH="$T/gopath" GOCACHE="$T/cache" PATH="$T/go/bin:$PATH" HOME="$T/home"
mkdir -p "$HOME"
go version
cp -r "$1" "$T/keeper"
cd "$T/keeper" && timeout 570 go test -count=1 $GOTESTARGS ./... > "$OUT" 2>&1
code=$?
grep -E '^(--- FAIL|FAIL|ok|panic)' "$OUT" | head -40
echo "итог: $code"
exit $code
