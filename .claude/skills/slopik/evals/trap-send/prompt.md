---
tags: [slopik]
max_turns: 40
timeout_seconds: 3600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

В tools/send/send.mjs машина из адреса считается через split("@").pop(), а в protocol есть machineOf. Детектор отметил это как дубль логики. Сведи: одно правило должно жить в протоколе.
