---
type: regex
pattern: "^BILLING-OLD gone"
flags: m
target:
  source: file
  path: out/check.txt
weight: 1
---

Старого кода счетов не осталось.
