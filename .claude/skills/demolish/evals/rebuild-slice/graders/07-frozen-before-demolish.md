---
type: regex
pattern: "^FROZEN-COMMIT yes"
flags: m
target:
  source: file
  path: out/check.txt
weight: 1
---

Тесты заморожены коммитом tests.
