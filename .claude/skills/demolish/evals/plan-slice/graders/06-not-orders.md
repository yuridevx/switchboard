---
type: regex
pattern: 'Внутри:(?:(?!Снаружи:)[\s\S])*orders-'
match: not_contains
target:
  source: file
  path: out/boundary.md
weight: 1
---

Заказы — другое дело.
