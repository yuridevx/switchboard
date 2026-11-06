# Раунд 2 lost, граница alerts (workers/push, host/modules/push, web/packages/alerts)

База 106e8e6. `lost`: 295 строк вывода (275 пропавших из 652). `--comments`: 43 строки (27 пропавших из 52). Прочитано всё, плюс старые файлы целиком через git show и новые целиком.

## workers/push

| группа | что было | где сейчас / решение |
|---|---|---|
| Разбор подписки | try/catch вокруг unb64u: любая строка, которую atob не читает, — bad_frame | ПОТЕРЯ. Образец B64U пропускал длину 4n+1, atob бросал мимо Refusal: POST с пропуском → 500 failed. Дверь с телом от клиента — граница доверия по уточнению раунда 2. Вернул: keyBytes в src/index.ts, тест «дверь с пропуском», 3895ce7. Первый проход это чинил (3241e8e) и откатил (d323c42) по уточнению раунда 1 |
| Заполнение и `+/` в ключах | старый принимал `=`, `+`, `/` | образец их отказывал; браузеры шлют без заполнения, вреда не было; правкой keyBytes вернулось старое поведение попутно |
| sub не объект | «нет sub» | теперь «в подписке нет https-адреса», слово то же bad_frame: запись, не правка |
| endpoint | URL.canParse + protocol https + host | index.ts subscription: startsWith https:// + canParse + hostname. Отличие только `https:x` и `HTTPS://`: браузер так не шлёт |
| from обязателен | только subscribe и subscribed | serve: на всех именах. POST всегда ставит from, PUSH-привязки нет ни у одного Worker'а: разницы на пути нет |
| fromKid строкой | typeof === string, иначе null | `fromKid ?? null`. entrance вырезает fromKid тела и ставит who.kid; привязки нет. Снято: вход недостижим |
| isReply | строгая проверка | f.type === "reply": разница в журнале, ответа нет в обоих случаях |
| кадр без id | note и [] до accepts | refuse с причиной и []: ответа нет в обоих; другая строка журнала |
| fit | по UTF-16, бинарный поиск | index.ts fit, по кодовым точкам: тот же предел, суррогатная пара больше не рвётся |
| targets | весь SELECT, filter reaches | SQL по концу адреса + тот же reaches; правило у протокола |
| отозванные | drop по kid, журнал | index.ts push.send: тот же DELETE и строка |
| deliver, статусы | 404/410 drop, не 2xx push_failed, catch fetch | index.ts deliver: те же; журнал `host` → hostname, `why` с Error: — запись |
| cut | только в строке sent | во всех строках push.send: запись |
| notify объект | `!notify` | строже typeof object: потребители шлют объект |
| webpush | encrypt, VAPID, заголовки | webpush.ts encrypt, vapid; заголовки в deliver: те же значения (RS 4096, MAX_PLAIN 3993, ttl 86400, urgency high, exp 12 ч, AbortSignal CALL_MS) |
| frames.ts как файл, Participant.frame через answer | | слиты в index.ts: то же дело |
| литерал ./frames.ts, env.ts | | нет файла, тот же тип Env |
| vitest.config: `test*.test...` | | файл не менялся (git diff пуст): артефакт разбора литерала |

## host/modules/push

| группа | что было | решение |
|---|---|---|
| skip человека | online.filter(device && reaches) | filter(reaches). `~email` в roster не бывает: адрес пропуска — всегда устройство. Если бы был — skip всё равно верен. Снято |
| pushTo | from только если есть, skip только непустой | push.ts send и pushesFor: `from: undefined` не идёт в JSON; пустой skip снят |
| журнал gone/stop | | те же строки |
| notify, проверка | clients, type, notify | + typeof object, текст другой, слово то же |
| roster нет | журнал, undefined | тот же |

## web/packages/alerts: module.tsx

| группа | что было | решение |
|---|---|---|
| firstState try/catch | getSubscription отказал → ask | Снято. Красный: `"web-alerts": "Модуль web-alerts упал на старте: AbortError: сбой хранилища"`. Факта, что настоящий браузер здесь отказывает, нет; не дверь и не граница доверия; исход — ветка устава «ошибка модуля — модуль выключен», причина видна. Правка c99a50b откатана d67c586 |
| checkHeld, повторная проверка ui.state === "on" после чтения | | нет в verify. Из on уходит только сам verify: кнопки нет. Снято: нужно два открытия связи и нажатие в окне чтения |
| browserApis | | pageBrowser, тот же PushManager-признак |
| takePushes | | take, те же кадры и open |
| enable | | тот же порядок: разрешение, ключ, ready, subscribe, push.subscribe, on, тост |
| AlertsBar | | Bar, те же тексты; `word ? ` → `s === "error"` |
| start, on, marks, screens, store | | те же |
| keyBytes | | bytesOf, то же заполнение |

## web/packages/alerts: sw.ts

| группа | что было | решение |
|---|---|---|
| порядок: store, потом show | | Promise.all show и store. Запись: отличие в миллисекундах записи, человек не нажмёт раньше; при сбое хранилища уведомление теперь показано — лучше |
| `n.title ??` | | typeof string: то же для строк |
| data { id, notify } | | { id, body, tag, frames }: те же кадры; старые уведомления после обновления — совместимость не нужна |
| действие без кадра → openApp | | answer → bad_frame. Кнопки показываются только если у всех есть кадр: вход недостижим. Снято |
| `word === null` | | `!word`: пустое слово. closed даёт reason или код; stopped — 1008 relay всегда со словом (fleet.ts 103, 212, 220). Снято; старый visible.test прогнан на новом коде: 2 из 2 |
| уведомление отказа без data | клик падал | теперь с data: клик открывает окно. Лучше |
| sendFrame, onState closed/stopped | | send, `s !== "connecting"`: те же состояния (LinkState — 4) |
| SEND_MS, no_key, bad_frame, relay url | | те же |
| openApp | | open, тот же |
| литералы closed, stopped | | см. выше |

## Комментарии --comments

Все 27 — тот же смысл в новых комментариях или описывают снесённый файл; договорённость без нового держателя не потеряна. «Удалить именно эту подписку» — комментарий в deliver.

## Находки без правки

- Точка не на кривой, 65 Б: subscribe отвечает ok; push.send на ~email бросает `DataError: Point is not on curve`, ответ failed, живое устройство получило POST, в опыте он ушёл. Опыт: posts [good], send бросил. По чтению базы то же (pushRequest вне try, проверки кривой нет): не потеря.

## Опыт: старые леса на новом коде

boundary.test.ts из 106e8e6 прогнаны временными файлами: alerts 38 из 38, push 27 из 27, host-push 15 из 15. Старый visible.test (кнопка, обрыв связи) 2 из 2. Снятые триажем случаи держатся кодом.

## Итог

Групп 42. Потерь 1. Снято с причиной 6. Не воспроизвелось 0. Остальные 35 — то же другими именами или отличие без вреда с записью.
