---
type: regex
pattern: "^DEMOLISH-COMMIT yes"
flags: m
target:
  source: file
  path: out/check.txt
weight: 1
---

Снос был отдельным шагом после заморозки, а не правкой поверх.
