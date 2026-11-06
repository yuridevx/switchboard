#!/bin/bash
S="$1"; cd <репо> || exit 9
D=~/.switchboard-dev
export FLOW_CLIENT_KEY="$(cat $D/test-flow.pass)" FLOW_DIR='~/sb-flow'
run() { n="$1"; shift; timeout 420 env "$@" node "scripts/flow-$n.ts" > "$S/f-$n.log" 2>&1; echo "flow-$n $?" >> "$S/flows.txt"; tail -1 "$S/f-$n.log" | cut -c1-120 >> "$S/flows.txt"; }
: > "$S/flows.txt"
run question FLOW_CALLSIGN=flow@win
run message FLOW_FROM=flow@win FLOW_TO=nightcheck@win
run sessions FLOW_MACHINE=win FLOW_HOST_KEY="$(cat $D/test-probe.pass)"
run shell FLOW_A=win FLOW_B=wsl
run points FLOW_FROM=flow@win FLOW_TO_MACHINE=win
cat "$S/flows.txt"
