---
type: regex
pattern: 'Внутри:(?:(?!Снаружи:)[\s\S])*reports'
match: not_contains
target:
  source: file
  path: out/boundary.md
weight: 1
---

Отчёты, чужой потребитель, остаются снаружи.
