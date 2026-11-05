---
type: regex
pattern: 'НДС 20% на 10 ещё раз.*(убрать|слить)'
target:
  source: file
  path: out/triage.md
weight: 1
---

Триаж: дубликат НДС убран или слит.
