---
type: regex
pattern: 'Внутри:(?:(?!Снаружи:)[\s\S])*orders-api'
target:
  source: file
  path: out/boundary.md
weight: 1
---

Берёт другую часть: заказы.
