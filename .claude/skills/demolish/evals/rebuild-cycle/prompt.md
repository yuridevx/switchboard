---
tags: [skill-run]
max_turns: 120
timeout_seconds: 1500
allowed_tools: [Skill, Read, Write, Edit, Glob, Grep, Bash]
---

Найди, что в этом репо снести, и сделай одну итерацию.

Пользователя не будет, спросить не у кого. Выпуска в этом репо нет: итог работы — слияние в ветку main. Последний шаг, уже в main и в корне репо: `mkdir -p out && node check.mjs > out/check.txt`. Файл check.mjs не правь. Рабочие файлы boundary.md и requirements.md положи в out/ (в git не добавляй).
