# Раунд lost, граница journal: сверка с 106e8e6

`lost`: 874 строки старого кода, пропало 390, вывод 438 строк. `--comments`: 78, пропал 41, вывод 69 строк. Прочитано всё. Старый и новый код всех пяти частей прочитаны рядом целиком.

Мерка (уточнение главной сессии): потеря — основной путь, ожидаемая ветка устава, отказ словом, graceful shutdown. Вход, до которого настоящий поток не доходит, — снято с причиной.

## workers/ledger

| группа | что было | где теперь | итог |
|---|---|---|---|
| L1 span, presence | пороги 60 с, 60 мин, 48 ч; текст по прежней записи | index.ts:25-40 | то же; SQL с bind вместо литерала |
| L2 add | ev, callsign, machine из callsign, PRESENCE только от relay, text | index.ts:42-59 | то же |
| L3 from в записи | `f.from ?? ""` | index.ts:57 `String(f.from)` | снято: from ставят все входы — entrance (gate/src/entrance.ts:39) и три привязки (relay fleet.ts:267, points registry.ts:47, releases fleet.ts:61). Без from настоящий поток не приходит |
| L4 read | страницы, вперёд новыми сначала, more | index.ts:61-76 | то же |
| L5 фильтр machine | `text(f.machine)`: "" = без фильтра | index.ts:66 `typeof === "string"` | снято: потребители шлют machine только непустым (journal `m ? {machine}`; machines, points — имя машины) |
| L6 line, frame, answer | строка журнала, ответ, отказ | index.ts:19, 79-99 | то же; класс Refusal вместо объекта |
| L7 rec только у ledger.add со строкой ev | условие | index.ts:96 `rec: f.ev` | снято: намеренно, коммит 49acd07; текста записи в строке нет, тест 223 |
| L8 слова why | «в ledger.add нет ev» и др. | index.ts:44, 51, 54, 63 | то же другими словами; разбора текста нигде нет, слово bad_frame то же |
| L9 Participant.fetch, default = класс | вход одним классом | index.ts:101-109 | то же: все привязки с entrypoint Participant, зовут только .frame; fetch — default |
| L10 env, vitest.config | объявления | env.ts, vitest.config.ts | то же |

## host/modules/journal

| группа | что было | где теперь | итог |
|---|---|---|---|
| J1 api_retry | поле error в строке | journal.ts:30 | ПОТЕРЯ, исправлено |
| J2 чтение файлов | readdir, readFile с ctx.signal | journal.ts:67+ | ПОТЕРЯ, исправлено |
| J3 init один раз на процесс | сброс в on.close | journal.ts:102 сброс в on.open | не воспроизвелось, см. ниже |
| J4 сортировка | общая в конце | по дню, journal.ts:87 | то же: имя файла — день UTC и у host (kernel.ts:125 t.slice), и у keeper (journal.go:4) |
| J5 lines.ts: init, status, permission_denied, worker_shutting_down, informational, result, rate_limit, auth_status | таблица | journal.ts:13-52 | то же, поля сверены построчно |
| J6 слова отказа machine.journal | свои тексты, since в тексте | journal.ts:69-71 | то же другими словами; слово bad_frame то же, потребители (parts, card) читают слово |
| J7 строка kind note | note() | journal.ts:111 `kind: "note", ...l` | то же |

J3, опыт на настоящем claude 0.3.311 (пустая папка входа, без API):

```
     1 initialize sent
  1667 out control_response success
  5011 user sent
  5130 out system/init
```

system/init приходит только после первого ввода, ввод идёт после open() в boot; on.open стоит в том же такте. Сброс в on.open и в on.close равны. Код не тронут.

## host/modules/incidents

| группа | что было | где теперь | итог |
|---|---|---|---|
| I1 приём: метод, путь, Host, Content-Type, предел, разбор | readBody, parseAppeal | incidents.ts:22-48, 121 | то же; слова те же, тесты 307; why через e.message содержит слово и причину |
| I2 attachments [] на диске | всегда поле | incidents.ts:47 только если есть | то же: чтение `?? []`; старые записи читаются |
| I3 esc(id) в теге | id экранировался | incidents.ts:14 | снято: id только randomUUID |
| I4 wrap, rule, типы из контракта | экспорт | убраны | снято: потребителей нет |
| I5 release: снять адрес до новой сессии | release() | deliver | ПОТЕРЯ, исправлено |
| I6 on.state stopped | release обращений сессии | был close: drain | ПОТЕРЯ, исправлено: у сессии в failed close не приходит |
| I7 отказ shutting_down всей очереди | deliver для каждого | drain молча пропускал | ПОТЕРЯ, исправлено |
| I8 guard на диск в on.event | some() до update | update на каждый user_message_uuids | ПОТЕРЯ, исправлено |
| I9 open только своих обращений | filter callsign | drain всех на каждом open и close | ПОТЕРЯ, исправлено (нашлось опытом I8) |
| I10 flush по типу и ключу на POST | только тот же ключ | drain всех | то же по контракту: «ждёт следующего обращения»; шире старого, оставлено |
| I11 queued | дедуп очереди | проверка на своём ходу | то же для доставки; дубль отказа закрыт условием в drain |
| I12 tails.delete | чистка хвоста очереди | chains не чистится | снято: одна выполненная цепочка на ключ, снаружи не видно, вреда нет |
| I13 opened(), Promise ready | ждали ready | флаг ready, drain без него пуст | то же: тест 3100 |
| I14 start, stop, opening, session, fields, pending | | incidents.ts | то же |

## web/pult/modules/journal

| группа | что было | где теперь | итог |
|---|---|---|---|
| W1 чтение при открытии вне зависимости от состава | эффект на mount | fleetOf "" при пустом составе | ПОТЕРЯ, исправлено |
| W2 setPage(START) при смене машины | записи сняты | не снимались | ПОТЕРЯ, исправлено |
| W3 PageHead title только на широком | app.wide | title всегда | снято: web/pult/src/options.ts:5 wide: true, модуль только в пульте; ветки нет |
| W4 dayName, Row, поиск, older, дочитывание, отмена опоздавшего | | module.tsx | то же, тесты 4159, 6931-6936, 6521, 7290 |
| W5 value={query} | управляемое поле | неуправляемое | то же: тест «поиск переживает смену машины» |
| W6 div display:contents | обёртка | Fragment | то же: в journal.css нет селекторов по структуре |
| W7 чтение при закрытой связи | отказ на экране | ждёт связи | снято: намеренно, тест «связь вернулась — отказа нет» |

## web/pult/modules/incidents

| группа | что было | где теперь | итог |
|---|---|---|---|
| P1 head экрана | head: title | нет | то же: bar.tsx:39 `h?.title ?? s.def.nav`, nav = «Инциденты» |
| P2 find по склейке полей | одна строка | по полям | снято: запрос поперёк полей без держателя; поиск по типу, ключу, адресу работает |
| P3 фильтр s.incident | | i?.type | то же: Host всегда пишет type |
| P4 machineOf | | slice по @ | то же: callsign всегда с @ |
| P5 since, midnight | | module.tsx:66 | то же |
| P6 LostRow, SessionRow, store | | module.tsx | то же, тесты 5405, 5406, 6907 |
| P7 экспорт createIncidents, createJournal из contract | | убран | снято: потребителей нет, default остался |
