---
type: regex
pattern: 'Внутри:(?:(?!Снаружи:)[\s\S])*billing-store'
target:
  source: file
  path: out/boundary.md
weight: 1
---

Жадность: внутри хранилище счетов, которым больше никто не пользуется.
