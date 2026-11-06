# lost, раунд 2, граница sessions (manage, remote, machine, shell)

База 106e8e6. `lost` — 370 строк из 896 (файл 386 строк с заголовками), `--comments` — 34 из 68 (файл 46). Прочитано всё, плюс старые файлы целиком, дифф тестов границы (818 строк) и ядро, куда идут вызовы (kernel.ts, session.ts, gate.ts, contract.ts). Строки файла — на ветке demolish3-lost-sessions2.

Опыт разницы: один и тот же вход старому коду (git show 106e8e6) и новому на одном стенде. manage — 29 кадров, разниц 6: exp4.txt; shell — exp3.txt; двери — exp1.txt, exp2.txt. Опыты были временными файлами, удалены.

## machine

1. machine.ts, 8 строк: WORD, who, проверки, readdir, разбор кода — то же другими именами, machine.ts:8,14-23. Слова и порядок те же.

## manage

2. Типы и постоянные (Spec, DEFAULT_MODE, LIVE, EFFORTS, CALLABLE, RULES, SETTING): manage.ts:8-25. CALLS — те же 21 метод, сверено по одному. SETTINGS добавил effort → effortLevel вместо ветки в update, ключи те же.
3. message(e) для не-Error: снято. s.sdk и host.open бросают Error; SDK отказывает `Error`, ядро тоже (session.ts:156,167).
4. sdk(), starting(): manage.ts:37-52 (raising). Слова те же.
5. ledger, session, taken, firstFree, forget: manage.ts:59-78. Занятость — та же проверка.
6. opening: manage.ts:185-189. typeof req.from заменён на проверку значения; from на этом пути всегда строка (kernel.ts:463 и relay).
7. session(): manage.ts:190-216. Всегда permissionMode и settings: {} — итог query() тот же: kernel.ts:264 ставит тот же режим, kernel.ts:272 пустые settings не передаёт; других владельцев permissionMode нет (поиск по host/modules). Опыт: разницы в options нет.
8. fields: manage.ts:180-183.
9. on.event: снят фильтр type=system и subtype init/status. Снято: permissionMode несут только SDKSystemMessage и SDKStatusMessage (sdk.d.ts:6198,6236); поиск по claude.exe закреплённой версии других кадров с этим полем не вернул. Другого входа нет.
10. on.state: manage.ts:223-226.
11. session.open, порядок проверок. Отличие без вреда, запись: при двух ошибках сразу слово другое (занято раньше папки, спецификация раньше папки). Вывод опыта: «старый bad_dir: папки ~/нет нет / новый name_taken: site@laptop уже есть». Кадр отказан в обоих случаях, ничего не создано.
12. session.open, файл на месте папки с mkdir: то же слово bad_dir, причина короче. Запись.
13. session.open, number и плохая папка: в причине n-2@laptop вместо n@laptop. Запись.
14. mkdir: !there заменён на f.mkdir: core mkdirSync recursive на существующей папке ничего не делает. Опыт: разницы нет.
15. resume: "" || undefined заменён на сырой "": kernel.ts:507-512 считает "" как отсутствие. Опыт: spawn в обоих.
16. opening: {...req, from: ctx.from} заменён на f: ctx.from и есть f.from (kernel.ts:420, в своём Host kernel.ts:463).
17. session.update: manage.ts:113-138. Запись после согласия SDK сохранена, refresh, now, title — те же. В одном месте запись повторяется (merge после setModel и общий merge): значение то же.
18. session.call синхронный вместо async: бросок ловит kernel.ts:443 в try.
19. session.spec, session.stop, session.start, session.remove: manage.ts:150-177. start({point: undefined}) — session.ts:349 читает o.point, то же.

## remote

20. Типы, transcriptOf, lastBridge: remote.ts:8-32.
21. Причина снятия: remote.ts:40-46. account === undefined заменён на «раздела нет»: раздел без account не пишется нигде.
22. Снятие привязки: remote.ts:48-59. Строка своей строкой — улучшение спорного места круга 3 (4c60053).
23. r?.session_url заменён на r.session_url внутри try. Снято: ответ undefined на enabled=true не бывает. В claude.exe ветка remote_control: kt(q,Di(wn,Po)), kt(q,Di(ht,Be)) или lt(q,…) с ошибкой; kt(q) без тела только у выключения.
24. Аккаунт считается до await, а не после: отличие без вреда, запись. Смена слота за время включения — не ветка потока; новое значение ближе к тому, что было при старте моста.
25. refused: Map по callsign заменён на WeakMap по сессии: session.ts:65-89 отдаёт модулю один объект на сессию, поле и on.open видят один ключ. Плюс: убранная и заново открытая сессия не наследует старый отказ.

## shell

26. Поиск шелла: os.ts:18-41. besideGit, CLAUDE_CODE_GIT_BASH_PATH — те же.
27. powershell на Windows без проверки файла. Опыт с подменой SystemRoot: «старый {"info":["bash"],"ok":false,"error":"no_shell"} / новый {"info":["bash","powershell"],"ok":true,"state":"exit","code":null}». Снято: воспроизводится только подменой; System32\WindowsPowerShell\v1.0 есть на всех машинах флота, лес границы так и называет: «PowerShell есть всегда» (boundary.test.ts:661, был и на базе). Предел: Windows без этого файла (Nano Server) получит пустой exit вместо no_shell.
28. powershell на Linux: старый список пуст, новый ищет в PATH. Отличие без вреда, запись: файла с таким именем нет — no_shell как было; есть — запустится как PowerShell.
29. shellVersion: предел READ_MS (10 с) заменён на 5 с. Намеренно, os.ts:10: с 10 с опоздавший шелл ронял весь info по пределу чтения.
30. startShell: разложен на scriptOf, argsOf и runs.ts:125-130. try/finally у spawn снят: при синхронном броске spawn дескрипторы остаются до конца процесса Host. Снято: не ветка устава, модуль при таком броске и так выключается, опыта нет.
31. killTree: промис и 25 с вместо 5 с — названо в 7b7b555, os.ts:12.
32. MEDIA заменён на TYPES без точки. Отличие без вреда, запись: файл `x.constructor` даёт media_type = функция объекта, по кадру null, вместо application/octet-stream. Вывод: «старый ["x.constructor","application/octet-stream"] / новый ["x.constructor",null]». У модели подпись `(undefined)`, содержимое на месте; других потребителей поля нет.
33. class Run заменён на тип и функции: runs.ts:26-44,85-114. Порядок finish и tell поменялся, told присваивается в том же такте: close видит его (runs.ts:96,170).
34. Предел после kill 5 с заменён концом снятия: runs.ts:100-108. На Linux конец запуска — сразу после SIGKILL, а не по exit: отличие без вреда, запись. Файлы вывода уже на диске.
35. wait, halt, stop: runs.ts:154-172. ttl у stopped теперь ставится и снимается в forget: итог тот же.
36. shell.run, проверки: shell.ts:13-23. NaN проходит новую проверку timeout. Снято: JSON его не несёт, zod инструмента отвергает.
37. arm до проверки кадра: сигнал один на Host, подписка раньше ни на что не влияет.
38. shell.kill ждёт конца запуска (до 25 с) вместо мгновенного ответа. Отличие без вреда, запись: предел запроса 120 с, ответ правдивее описания инструмента.
39. tools.ts: текст, параметры, слова отказов сверены; слово в слово держит лес. Строки lost здесь — другое написание тех же значений.
40. Литералы .png…: ключи TYPES без точки.

## Комментарии (34)

41. Перенесены или переписаны: 22. Исчезли: 12. Поведение за исчезнувшими на месте: refresh (manage.ts:131), transcriptOf, appendFileSync без перехвата, start === "attach" (remote.ts:64), detached (runs.ts:129), конец снятия (группа 34), файлы в ROOT (tools.ts:48), existsSync (runs.ts:52), Esc (tools.ts:83), отказы и текст файла в tools.ts.

## Двери

42. Кадр session.* без callsign. Не потеря: старый код ведёт себя так же. Опыт: «старый {"type":"session.stop","machine":"laptop"} → module_error, затем session.spec: module_error, выключен [на машине]», новый — то же. Relay доставляет такой кадр по machine (fleet.ts:32-41), полей не читает. Дверь: исправлено, 75b0e83, 6 красных до правки, 6 зелёных после. Слово bad_spec.
43. session.open с dir, на котором statSync бросает: NUL и UNC. Опыт: «новый session.open dir \\\\nohost\\share → module_error, host-manage выключен [на машине]»; старый так же. Не правил: лес 3016 с источником «слово пользователя (устав)» закрепляет незнакомую ошибку ОС как ошибку модуля. Развилка в отчёте. EACCES на Linux (dir: /root/x) — по коду Node бросает так же, опыт не поставлен: wsl в этой изоляции закрыт.
44. machine.dirs с UNC: `\\nohost\share` → UNKNOWN → host-machine выключен на машине. Старый так же. Лес 3016 держит это поведение, менять нельзя.
46. id запуска — имя устройства Windows. Не воспроизвелось: «новый run NUL {"ok":true,"state":"exit"} / новый run CON {"ok":true,"state":"exit"}», старый так же. Кода не трогал.
45. Скрипт стёр папку запуска целиком: снимок читает stdout → ENOENT → module_error, host-shell выключен на машине. Старый так же. Снято как крайний случай: скрипт сам ломает свою папку.
