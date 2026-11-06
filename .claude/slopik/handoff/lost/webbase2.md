# Сверка webbase, раунд 2: web/packages/core, ui, view

База 106e8e6. lost.txt — 1142 строки вывода (1076 пропавших из 2791); lost-comments.txt — 287 строк (227 пропавших из 419). Прочитано всё. Сверх брифа: старый boundary.test обеих частей прогнан на новом коде (core 171 тест: 3 красных; ui 104: 5 красных), новые тесты — на старом коде.

Файлы новых мест — от web/packages/core/src, если не сказано иначе.

## Потери (2, обе с красным тестом, красный на новом коде и зелёный на старом)

1. **Возврат на экран дважды за один уход.** Было: флаг hidden пропускал один comeBack. Стало: show ждал `leaving` без сверки, оба ждущих проходили. Снаружи: скрыл, показал, скрыл, показал, пока уход ждёт запрос — on.show дважды, два hello, второй fleet заменяет первый без close: первый живёт, пингует, переподключается до перезагрузки. Правка start.ts `show`. Тест «вернулись, ушли и снова вернулись…». Коммит 0aff334.
2. **Уход ставил closed вместо connecting.** Было: `core.link = "connecting"`, без on.link. Стало: `close("hidden")` → closed. Снаружи: на каждом возвращении до roster шапка «нет связи» красным и «данные на ЧЧ:ММ», on.show видит closed. Слово пользователя 3 нояб. о мигании. Правка start.ts `leave`. Тест «возвращение на экран: пока связь собирается…». Коммит ae48cdb.

## Группы

| № | группа | что было | где сейчас |
|---|---|---|---|
| 1 | build.ts: загрузка | broken, partOf, предел | build.ts 18-33 — то же |
| 2 | core.ts: состояние, bus, reuse | Core, createBus, reuse | page.ts 12-23, 47-108 — то же |
| 3 | gate.ts | definitionErrors, secondOwners | gate.ts 8-35 — то же, слова те же |
| 4 | link.ts: сбор флота | whole, settle, onRoster, list | link.ts settle/publish/onState — ветки сверены по одной |
| 5 | modules.ts: реестр и app | entries, fail, trap, ownerIn | modules.ts, app.ts |
| 6 | pass.ts | inviteIn, redeem, keyId | pass.ts |
| 7 | route.ts и адрес из start.ts | parseHash, toHash, masterOf, open, back | route.ts |
| 8 | start.ts: уход и возвращение | hide, comeBack, drained | start.ts leave/hide/show — две потери |
| 9 | start.ts: запуск и остановка | boot, stop, fell, accept | start.ts boot/stop/fell, pass.ts enter |
| 10 | store.ts | idbStore, memoryStore | store.ts — то же, база и таблица те же |
| 11 | view/bar | headOf, Bar, Off | view/bar.tsx |
| 12 | view/nav | sectionRows, Column, Tabs, Ribbon | view/nav.tsx |
| 13 | view/place | Catch, Off, Place, slotFor | view/place.tsx |
| 14 | view/search | hits, Box, Search | view/search.tsx |
| 15 | view/shell | pageCss, View, Top, Toast | view/shell.tsx, start.ts boot (page.css) |
| 16 | view/stops | stopScreen, Paste, Replace, Connecting | view/stops.tsx, pass.ts — слова сверены |
| 17 | ui: hooks и load | useNow, useOutcome, useLoad, useMachineLoad | ui/src/hooks.ts |
| 18 | ui: labels, time, sessions | stateLabel, lamp, plural, ago | ui/src/labels.ts, time.ts, sessions.ts |
| 19 | ui: machines, personal, store | machineAnswers, personal, createStore | те же файлы, то же |
| 20 | ui: parts | part(), Btn…PickOne, CommitIn | ui/src/parts.tsx |
| 21 | ui: md | CodeBlock, CopyButton, HtmlFrame, Markdown, highlight | те же файлы; POLICY, SCHEMA, safeHref, e.source, img — без изменений |

Строки «типы, импорты, разбитые литералы» (generic-хвосты вида `string[], first: Array`, `./core.ts`) — разрез инструмента, поведения нет.

## Снято с причиной

- `decodeURIComponent` в inviteIn: ссылку строит только pult `#invite=${invite}`, приглашение — `${kid}.${secret}` из gate, символов под экранирование нет: декодировать нечего. Негодный `%` отказывается и там, и там.
- `Hint`, `OptsInline`, `LIVE`, `textOfNode`, `framed`, `nameInKey`: потребителей в web, workers, tools, scripts нет (поиск). Все 5 красных ui-тестов старого файла на новом коде — эти имена.
- `r.error ?? "gate_unavailable"` в redeem: gate отвечает `fail` со словом, падение Worker'а — не JSON и уходит в UNREACHED.
- `gone` при unmount и `core.stopped` в openLink: unmount зовёт только стенд (поиск по web), после остановки open не вызывается: boot до связи не доходит, show проверяет page.stop, «Сейчас» скрыта.
- `e instanceof Error` в fell: броски ядра — Error; IDB отдаёт DOMException.
- owner-фильтр `off(guest)` в placed: у всех вставок есть show (board.pin, board.unpin, board.assign, session.points), а show выключенного через call даёт undefined и скрывает. Вставка без show настоящим потоком не встречается.
- порядок placed «по модулю» → «экраны, затем команды»: card.menu и open.after — только команды board, card.tab — только экран points; смешанных мест нет.
- `s.place !== "top"` → `!s.place` в разделах: экранов с nav и местом нет.

## Отличается на достижимом пути без вреда (запись, не правка)

- Клик по домашнему разделу при пустом адресе: route.open сверяет адрес, а не экран — одна лишняя запись истории `#дом`, первое «назад» остаётся на том же экране. Повторно не копится.
- Те же параметры в другом порядке: адрес другой, экран начат заново. Вызовов с разным порядком нет.
- `console.error` модуля без объекта ошибки: причина строкой есть, стека нет.
- Слова места сбоя: «упал на связи», «на переходе», «на roster», «на показе» вместо «на смене связи» и т. п.
- on.link("stopped") при остановке до связи (no_key, gate, install) и on.link("connecting") при уходе: потребители читают только open.
- Полоса «Нет связи» переживает уход до нового исхода: в старом core.lost снимался без bus.changed, на стенде полоса тоже стояла (проверено: тест на старом коде красный). Текст «подключаюсь» честный.
- page.started без page.changed: полоса top монтируется с первым событием связи, а не сразу; до первого экрана она скрыта.
- useLoad: stale при первом чтении false вместо true; потребители open и points смотрят его вместе с data, error и loading — экран тот же. A→B→A: loading сразу false, данные те же.
- Колонка широкого вида до первого roster скрыта, а не пуста; вкладки и лента после остановки скрыты.
- app.run и app.Slot с именем из uses без владельца в сборке: тихо ничего, в старом — выключался вызывающий с ложным словом «нет в uses». Владельцы вызовов (card, chat, settings, machines, board) входят в обе сборки: путь не встречается.
- ответ запроса несёт лишние поля reply (from, bytes): потребители читают ok, result, error, why.
- Отказ приглашения gate_unavailable: адрес сохраняется, экран «Нет связи с gate» и «Повторить». Намеренно, закреплено лесами.
- 7292: выборка считается раз за такт, тест добавил app.changed. prev работает, потребителей с prev нет.
- Скрылись, показались, скрылись за время ухода: связь открывается при скрытой странице. Так же в старом.

## Не воспроизвелось как потеря

- 7281 красный на старом тесте: на новом коде проба показала снятие полосы всегда, через 33–152 мс; тест ждёт 60 мс при паузе вдвое. Красный и на старом коде, и в новых лесах — мигающий тест, код не трогал.
