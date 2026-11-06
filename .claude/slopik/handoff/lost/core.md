# Раунд lost: граница core (host/core)

База 106e8e6. Вывод: lost.txt — 1070 строк файла (962 пропавших литерала из 1851), comments.txt — 167 строк (133 из 251). Прочитано всё. Старый код читался целиком: вывод режет строки на 200 знаках.

Мерка — бриф и уточнение главной сессии: потеря — основной путь, ожидаемая ветка устава, отказ словом, graceful shutdown. Вход, до которого настоящий поток не доходит, снимается с причиной.

## Потери: возвращено

| № | что было | где сейчас | коммит |
|---|---|---|---|
| 1 | aboutSession: сессия запроса — callsign или адрес to | serve искал только callsign; kernel.ts about() | f53ecaf |
| 2 | строка refuse: id, from, why ?? `тип: слово` | kernel.ts serve | 8a86cd6 |
| 3 | try/catch вокруг query(): ended + отказ | session.ts boot | b6cde89 |
| 4 | отказ `процесс вышел до initialize — причина` | session.ts boot, words(exit) | df78e29 |

## Снято с причиной

| группа | что было | почему не потеря |
|---|---|---|
| initialize отказал, процесс жив | terminate в catch | опыт на claude 0.3.311: второй initialize — success; хуки в форме Host (матчер строкой, без матчера, чужое событие) — success. Отказ только на негодной форме (hooks: 5), её Host не шлёт. Ожидание run.done без предела на этом входе осталось: факт в отчёте |
| handled() у s.sdk | отказ q[name] не поднимался | все вызовы модулей с await внутри своей async-функции: chat, manage, points, remote |
| known в stray | нарушение договора вне контекста — true | вне контекста модуля и обычная ошибка выходит чистым перезапуском; в контексте покрыто тестом 755 |
| seen шире known | одна и та же ошибка в двух сессиях | общий отказ двум сессиям нужен кэшированный промис или объект ошибки; поиск по форме `x = load|init|ready|connect(…)` в модулях пуст, поиск узкий |
| catch у inflight | бросок при отправке ответа | send на открытом соединении не бросает; JSON.stringify бросит только на результате с циклом, таких нет |
| claudeCli резолв по таймеру | не ждать close | единственный вызов host.cli — auth status, у logins свой предел READ_MS; таймер всё равно убивает |
| package.json внутри try | модуль failed, а не падение выпуска | 14 из 14 модулей с package.json; без него --check отказывает до подмены |
| modulesStarted | stop() только после start() | start() синхронен до первого await, сигнал раньше не придёт |
| typeof f.id у файлов procs | проверка поля | keeper пишет id всегда (hold.go:167) |
| point сброшен на resume | info.point | читателей в src нет, только тест manage при start({point}) |
| TURN_OF ?? turn | неизвестное состояние | тип SDK закрыт: idle, running, requires_action; версия закреплена |
| getSessionInfo отказал | aim на старте | опыт: без файла и без папки — undefined, не отказ |
| q.close дважды у пробы | delete как страж | опыт: повторный close без броска |
| known.has(undefined) в relink | logicalParentUuid && | граница без ссылки возможна, только если до сжатия нет сообщений, а сжимать тогда нечего; на файлах разговоров не проверялось. Ссылка в никуда покрыта 5534 |
| field() отдаёт Promise | fieldOf → undefined | асинхронных полей нет |
| хвостовой undefined в s.sdk | args[before] | вызовы: renameSession с заголовком, опции объектом |
| кадр: владелец и слушатели | return после handler | on.frame читают только roster; question никто другой не слушает |
| now.mod === mod в violation | место нарушения | чужой фасад в чужом контексте не вызывается |
| records ?.sessions ?? [] | пустой core.json | файл всегда пишется с sessions |
| workers ?? {} | build.json без workers | BuildList требует workers |
| tildePath normalize | `..` в пути | только показ dir; путь верен |

## То же другими именами (найдено в новом коде)

calls.ts → gate.ts CALLS, CORE_CALLS, SESSION_FNS; все 38 методов на месте. parts.ts → gate.ts mergeParts, coreOption. journal.ts → kernel.ts write. trap.ts → kernel.ts run, bounded, fail, switchOff, outside, violate, stray. Held → Hold (terminate → destroy, drop → detach, open → connect). InputQueue → stream(run). phase и turn → state. aim, fresh → plan. prepare → parts. listed → sessions.get === this. ownEnv → Kernel.ownEnv. realSdk → main.ts. limit → within. Stores → Disk. Литералы с кусками шаблонов и импорты — те же строки.

## Намеренные расхождения

- Ничьи процессы убиваются параллельно с relay и подъёмом, а не до них: relay не ждёт 30 с. Опасность одна: open с именем ничьего процесса в те миллисекунды.
- Держатель остановленной сессии теперь ничей и снимается: старый оставлял процесс без хозяина.
- rec.state пишет все состояния; attach читает только busy и waiting.
- Ввод идёт после готовности: настоящий SDK и так пишет его после initialize.
- Конфликт вкладов при перезапуске — сразу failed, без одного resume: повтор дал бы тот же конфликт.
- killed у Hold всегда false: на выходе main.ts снимает соединения раньше SDK, stdin.end и kill тогда ничего не делают (тест «Host упал: ввод процесса не закрыт»).
- s.input пишет запись на каждый ввод с from, а не при смене: то же содержимое файла.
- Строки guest_* в журнале только для open, closed, stopped.
