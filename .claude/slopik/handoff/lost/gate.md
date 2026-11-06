# lost-review: граница gate (workers/gate, host/modules/keys)

База 106e8e6, HEAD ветки demolish3-lost-gate. Вывод: lost.txt — 127 строк из 441, lost-comments.txt — 20 из 47. Прочитано всё, плюс старый и новый код целиком и дифф тестов. contract.ts, stand.ts, миграции, wrangler, package.json не менялись.

## Группы

| № | группа | строк | что было | где в новом коде | итог |
|---|---|---|---|---|---|
| 1 | keys.ts: инструменты, ответ, роль | 12 + 2 комм. | ROLE, answer, invite/list/revoke, start | host/modules/keys/src/keys.ts:6, 9-12, 20-21, 26-27, 33, 37-39; пустая почта `person \|\| undefined` — :21, тест boundary.test.ts:63 | то же другими именами |
| 2 | redeem.ts: разбор адреса, вывод, отказ | 10 + 2 комм. | console.* , проверка `!gate`, `!reply.result` | workers/gate/redeem.ts:8-29; без адреса String(undefined) не пройдёт регэксп | то же; ответ ok без result — опыт А |
| 3 | seed.ts: поля, инструкция, вывод | 6 + 2 комм. | process.exit(2), console.* | workers/gate/seed.ts:7-15; exitCode вместо exit | то же |
| 4 | entrance: разбор тела и предел | 7 + 1 комм. | oversize, parseFrame, TOO_LARGE, BAD_FRAME | workers/gate/src/entrance.ts:15-21 (`door`); байты те же | то же |
| 5 | entrance: тип пропуска | 1 | `typeof key === "string" ? key : ""` | было `String(key ?? "")` | снято: запись 1 |
| 6 | entrance: кадр без id | 3 + 1 комм. | `f.id ? … : Response(null)` | было `id === undefined` | снято: запись 2 |
| 7 | entrance: журнал, ответ, relay_only | 12 + 2 комм. | цикл по out, refuse | entrance.ts:27-49; find вместо цикла — опыт Б | то же |
| 8 | format.ts | 9 + 4 комм. | fieldsWrong(role, name, person), newSecret, sha256 | workers/gate/src/format.ts:14-19, 24-32; те же правила, поля объектом; `.replaceAll("=","")` на base64 равно `/=+$/` | то же |
| 9 | index.ts: serve, слова отказа | 15 + 1 комм. | serve, refuse, fail, ok | workers/gate/src/index.ts:29-57; журнал bad_request и name_taken — passes.ts:35, 53, index.ts:36 | то же |
| 10 | index.ts: дверь | 9 | `text.length > MAX_BODY`, `!f?.id` → bad_frame 200 | index.ts:44, 59, entrance.ts:15-21 | пустой id — снято: запись 2; код 200 и знаки — опыт В, Г |
| 11 | passes.ts verify | 11 | тип, разбор, журнал, сверка | passes.ts:9-29; порядок сверки другой, исход тот же: роль и имя без точек | тип — снято: запись 1, остальное то же |
| 12 | passes.ts invite | 13 + 2 комм. | ON CONFLICT(id) + catch UNIQUE | passes.ts:32-58, INSERT OR IGNORE + SELECT адреса: тот же name_taken, тот же повтор номера, то же исключение; why ушёл из значения в журнал, наружу он не шёл | то же |
| 13 | passes.ts redeem | 7 + 1 комм. | тип, разбор, UPDATE | passes.ts:61-79 | тип — снято: запись 1, остальное то же |
| 14 | passes.ts revoke, revoked, list и заголовок | 9 + 2 комм. | DELETE RETURNING, json_each, ORDER BY | passes.ts:81-104, те же запросы | то же |
| 15 | vitest.config.ts | 3 | d1Databases PROD, seed без предела | PROD обслуживал тест 5009 (второй пустой D1); кода под ним нет: разные базы — платформа. spawnSync получил предел | снято: лес, не поведение |

Сумма: 127 строк, 20 комментариев, 15 групп. Комментарии: все причины либо живут другими словами, либо рядом правило держит тест. Вернуть не пришлось.

## Потери

Подтверждённых потерь нет. Уточнение брифа: потеря — основной путь, ожидаемая ветка устава, отказ словом, graceful shutdown; вход, до которого настоящий поток не доходит, — крайний случай, код не возвращается. Обе записи ниже воспроизвелись красным тестом, были исправлены (392dc13, cecb9e2) и отменены одним revert: дерево равно demolish3.

### Запись 1, снято. Проверка типа пропуска и приглашения

Было: `typeof key === "string" ? … : null` в verify, redeem, entrance. Стало `String(x)`.

Красный на нынешнем коде (red.txt, red-object.txt):
- `keys.list {key: [пропуск]}` → ok; `gate.redeem {invite: [приглашение]}` → выдан пропуск `"key": "host.laptop.u2kb.…"`.
- `{key: {"toString": null}}`, `{invite: {"toString": null}}` → `"error": "gate_unavailable"` 503.
- entrance: verify получает `client.phone.p3a1.secret` из списка, `42` числом вместо пустой строки; объект — verify не зван.

Вред: контракт называет пропуск не того вида словом bad_key, gate_unavailable — «база не ответила». Дверь gate.redeem открыта без пропуска: любой мог писать в журнал ложный сбой базы и получать 503. Настоящий секрет остаётся нужен, обхода проверки нет.

Причина снятия: пропуск и приглашение строкой шлют все клиенты (web/packages/core/src/pass.ts:32, os/keeper/setup.go:110, workers/gate/redeem.ts:16, workers/relay/src/fleet-client.ts:80, relay fleet.ts:215 приводит к строке сам). Не строку настоящий поток не шлёт.

### Запись 2, снято. Пустой id

Было: gate `!f?.id` → bad_frame; entrance `f.id ?` → без тела. Стало `id === undefined`.

Красный: `gate.redeem {id: ""}` принимал приглашение; entrance с `id: ""` отвечал 200 no_reply после работы обработчика вместо 204. Держатель: обработчики считают такой кадр кадром без id (ledger index.ts:90-97, points registry.ts:207-212, prefs index.ts:18, relay index.ts:13, releases index.ts:118). 
Причина снятия: отправителей с пустым id поиском нет.

## Опыты без правки

А. redeem.ts на ответе `{"ok":true}`: старый `redeem: undefined`, новый `redeem: gate не ответил — Cannot read properties of undefined (reading 'key')`; код 1 у обоих. На `null`: старый падал со стеком, новый отказывает словом. Настоящий gate так не отвечает.

Б. Кадр без id и reply без id: `204 []`, старый писал relay_only. Обработчики на кадр без id ответа не строят (`id ? … : []`). Два ответа: новый берёт первый, старый последний: обработчиков с двумя ответами нет.

В. Дверь gate, bad_frame: `"не кадр" 400 {"type":"reply","id":"","ok":false,"error":"bad_frame"}`, старый код 200. Читают тело при любом коде: web/packages/core/src/pass.ts:32-34, workers/relay/src/fleet-client.ts:80-84, workers/gate/redeem.ts. Keeper (os/keeper/link.go:238) на коде ≥ 300 теряет слово, но шлёт кадр литералом из setup.go:110, плохим он не бывает. Не менял: держателя нет, вернуть — значит второе значение у общей двери. Тест при переписи снял проверку кода: расхождение названо здесь.

Г. Предел двери gate: `кириллица знаков 10054 байт 20054 413 too_large`, старый считал знаки и пускал. Запросы двери — короткие поля. Не менял.

## Снаружи границы

- workers/relay/src/index.ts:19: `typeof kid !== "string"`, в базе `|| !kid`. keys.revoke с пустым номером теперь отвечает unknown_key вместо bad_request.
- workers/relay/src/fleet.ts:215: `String(f.key)`: hello с `key: [пропуск]` входит. Так же было в базе, не потеря этого круга.
