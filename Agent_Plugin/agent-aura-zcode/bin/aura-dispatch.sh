#!/bin/sh
# AgentAura /agent-aura-zcode:aura command dispatcher.
# Usage: aura-dispatch.sh <plugin-root> [on|off|status|cmd <raw>|<state>]
ROOT="$1"
shift 2>/dev/null
BIN="$ROOT/bin/agent-aura-zcode.js"
sub="$1"
shift 2>/dev/null

case "$sub" in
  on)
    exec node "$BIN" enable
    ;;
  off)
    exec node "$BIN" disable
    ;;
  status | "")
    exec node "$BIN" status --probe
    ;;
  cmd)
    exec node "$BIN" command "$*"
    ;;
  *)
    exec node "$BIN" test "$sub"
    ;;
esac
