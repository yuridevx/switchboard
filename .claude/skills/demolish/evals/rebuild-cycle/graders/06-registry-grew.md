---
type: regex
pattern: "^REGISTRY-NEW ([2-9]|[1-9][0-9])"
flags: m
target:
  source: file
  path: out/check.txt
weight: 1
---

В реестре появилась новая строка «снесён».
