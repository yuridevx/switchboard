# Сверка sessions: раунд lost

База 106e8e6. Вывод прочитан целиком: lost.txt — 371 строка из 896, lost-comments.txt — 34 из 68. Новый код сверен с полным текстом старого, а не только со списком строк.
Мерка (уточнение главной сессии): потеря — основной путь, ожидаемая ветка устава, отказ словом, graceful shutdown. Вход, до которого настоящий поток не доходит, снимается с причиной, код не возвращается.

## Группы

| № | группа | что было | где в новом коде | итог |
|---|---|---|---|---|
| 1 | manage: типы, таблицы, правила полей | Spec, RULES, SETTING, EFFORTS, CALLABLE | manage.ts:8, 12-25 | то же другими именами |
| 2 | manage: разбор и проверки session.open | name, number, dir, mkdir, resume, fork, point, name_taken | manage.ts:69-107 | то же; порядок проверок другой, срабатывает только при двух ошибках в кадре |
| 3 | manage: session.update, запись после согласия SDK | save после setModel и applyFlagSettings, refresh | manage.ts:113-138 | то же |
| 4 | manage: session.call, spec, stop, start | список, stopped, sdk_error | manage.ts:140-176 | то же; s.start({point}) равно прежнему: ядро читает o.point |
| 5 | manage: вклад в query() | permissionMode только не по умолчанию, settings только непустые | manage.ts:189-215 | то же: у ядра тот же режим (kernel.ts:264), пустые settings отброшены (kernel.ts:272), другого владельца permissionMode нет |
| 6 | manage: ctx.from | автор из ctx | f.from | то же: ctx.from = f.from (kernel.ts:420) |
| 7 | manage: session.remove after_turn в starting | ["starting","busy","waiting"] | manage.ts:169 без starting | ПОТЕРЯ, возвращена |
| 8 | manage: on.event, фильтр system init/status | только эти два кадра меняют режим | manage.ts:218 без фильтра | снято: в sdk.d.ts поле permissionMode из SDKMessage есть только у SDKStatusMessage и system init; других кадров с полем поток не несёт |
| 9 | manage, remote: String(e) для не-Error | message(e) | (e as Error).message | снято: SDK отдаёт только Error (sdk.mjs: qn оборачивает, Error(...) в отказах) |
| 10 | remote: r?. у ответа enableRemoteControl | ответ мог быть undefined | r.session_url | снято: SDK сам читает a.bridge_session_id при enabled true, undefined упал бы внутри SDK |
| 11 | remote: файл разговора, lastBridge, unbind, причины | account === undefined — записи нет | remote.ts:13-59 | то же; запись account есть всегда, null в тексте журнала стал «—» |
| 12 | remote: refused по callsign | Map | WeakMap по виду сессии, вид постоянен (session.ts:65) | то же |
| 13 | remote: запись раздела вне try | сбой диска выключал модуль | внутри try, идёт в поле error и журнал | снято: сбой записи диска не ожидаемая ветка; причина остаётся в журнале |
| 14 | machine: всё | WORD, who, not_found, no_access | machine.ts:8-24 | то же |
| 15 | shell: поиск Git Bash и pwsh | candidates, onPath | os.ts:18-41 | то же |
| 16 | shell: existsSync у powershell.exe на Windows | нет файла — no_shell | os.ts:40 без проверки | снято: powershell.exe входит в Windows на всех машинах флота; лес «PowerShell есть всегда» |
| 17 | shell: powershell вне Windows | всегда нет | os.ts:38 ищет в PATH | снято: пакеты Microsoft ставят только pwsh, файла с таким именем на Linux нет |
| 18 | shell: try/finally у spawn | закрыть fds при броске | runs.ts:129-130 без finally | снято: бросок выключает модуль на машине, дальше чистый перезапуск; наружу то же module_error |
| 19 | shell: снятие дерева | KILL_MS 5 с, таймер после kill | os.ts:55-68, runs.ts:100-108 | намеренно: коммит 7b7b555, опыт 6 нояб., предел 25 с меньше предела остановки Host 30 с |
| 20 | shell: предел версии | READ_MS | VERSION_MS 5 с, os.ts:11 | намеренно: ответ успевает в предел чтения 10 с |
| 21 | shell: жизнь запуска | end, kill, wait, halt, stop, ttl, tell | runs.ts:65-172 | то же; первое слово конца сохраняется, остановка ждёт told, таймер ttl снимается в forget |
| 22 | shell: shell.kill | ответ сразу | runs.ts:148, ждёт конца снятия | то же по контракту «убит или уже кончился» |
| 23 | shell: проверки shell.run, wait, info | form, порядок | shell.ts:13-23, 46-71 | то же, порядок проверок сохранён |
| 24 | shell: tools | тексты, refusal, fileBlocks | tools.ts | то же слово в слово; замечено: TYPES по ключу без точки, файл *.constructor даёт не строку — снято, крайний случай |
| 25 | комментарии, 34 строки | причины правил | все причины в коде держатся; строка про refresh ушла, код на месте (manage.ts:131) | то же |

## Потеря

Группа 7. session.remove с after_turn в состоянии starting.
Поток: Host перезапущен, ход идёт у держателя, держатель копит вывод, вызов mcp__fleet__remove на себя приходит до готовности.
Было: метка, ход доходит, сессия убрана. Стало: сессия снята сразу, ход обрывается.
Красный тест: «322 · remove after_turn, пока сессия поднимается после перезапуска Host…», ответ без result { after_turn: true }. После правки зелёный.
