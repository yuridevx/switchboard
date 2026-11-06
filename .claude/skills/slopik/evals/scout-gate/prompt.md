---
tags: [slopik]
max_turns: 60
timeout_seconds: 3600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Обойди код как хозяин модуля gate (workers/gate): его дело — пропуска и вход всех Worker'ов. Найди, что из поведения этого дела лежит не у него, в других модулях. Код только читай, ничего не меняй. Кандидаты детекторов — candidates.txt. Итог — report.md: что твоё и где лежит, что не твоё и почему.
