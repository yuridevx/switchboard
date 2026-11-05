---
type: regex
pattern: 'Внутри:(?:(?!Снаружи:)[\s\S])*billing-store'
match: not_contains
target:
  source: file
  path: out/boundary.md
weight: 1
---

Снесённые счета не взяты повторно.
