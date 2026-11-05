---
type: regex
pattern: 'Внутри:(?:(?!Снаружи:)[\s\S])*shared-http'
match: not_contains
target:
  source: file
  path: out/boundary.md
weight: 1
---

Общая библиотека не втянута.
