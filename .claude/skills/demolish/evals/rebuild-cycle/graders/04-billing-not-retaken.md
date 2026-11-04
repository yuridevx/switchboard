---
type: regex
pattern: "^BILLING-TOUCHED no"
flags: m
target:
  source: file
  path: out/check.txt
weight: 1
---

Снесённые счета не взяты повторно, хотя они крупнее.
