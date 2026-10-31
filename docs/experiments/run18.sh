#!/bin/bash
# Опыт 18: claude с вводом и выводом на FIFO; контроллеры a, b, c подключаются по очереди
S="$(cd "$(dirname "$0")" && pwd)/ctl18.mjs"
D="$HOME/svyaz-exp18"
rm -rf "$D"; mkdir -p "$D"; cd "$D" || exit 1
mkfifo in.fifo out.fifo
# <> — открыть на чтение и запись: у канала всегда есть и писатель, и читатель (сам claude), конца ввода нет
setsid "$HOME/.local/bin/claude" -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages \
  --model claude-haiku-5-5 --dangerously-skip-permissions 0<>in.fifo 1<>out.fifo 2>err.log &
CPID=$!
T0=$(date +%s%3N)
echo "claude pid $CPID"
node "$S" a "$T0"; echo "a вышел, код $?"
node "$S" b "$T0"; echo "b вышел, код $?"
ps -o pid,stat,etime,rss,cmd -p "$CPID" | cut -c1-90
node "$S" c "$T0"; echo "c вышел, код $?"
ps -o pid,stat,etime -p "$CPID"
kill "$CPID"
echo "stderr claude: $(wc -c < err.log) Б"
cd ~ && rm -rf "$D"
