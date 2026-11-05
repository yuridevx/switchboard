---
type: regex
pattern: 'отрицательная сумма снова.*(убрать|слить)'
target:
  source: file
  path: out/triage.md
weight: 1
---

Триаж: дубликат отказа убран или слит.
