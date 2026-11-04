---
type: regex
pattern: 'Внутри:(?:(?!Снаружи:)[\s\S])*orders-store'
target:
  source: file
  path: out/boundary.md
weight: 1
---

Берёт срез заказов целиком.
