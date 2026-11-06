# Сверка lost: github

База 106e8e6. `lost` — 60 строк из 220, `--comments` — 6 из 20. Прочитано всё: 66 из 66.
Старый код прочитан целиком, оба файла; новый — `workers/github/src/index.ts` (номера строк — на коммите до правки).
Опыт сверх чтения: старые леса 106e8e6 целиком на новом коде — 1 красный из 38 (`exp-old-on-new.log`: вместе с нынешними 23 — 61, зелёных 60).

| № | группа | строк | было | где в новом | итог |
|---|---|---|---|---|---|
| 1 | импорты | 6 | `Buffer` из node:buffer, `CALL_MS`, импорт из ./github.ts, литералы `node:buffer`, `./github.ts` | index.ts:3-5; `Buffer` глобальный при nodejs_compat, JWT проверяет 240 в workerd с тем же wrangler.jsonc | то же другими именами |
| 2 | Refusal | 2 | класс с export, конструктор | index.ts:25-36; импортёров вне файла нет: package.json отдаёт только contract.ts | то же |
| 3 | типы | 2 | `Keyed`, `Answer`, `AppInfo & pem` | index.ts:9-10 | то же |
| 4 | запрос к API | 4 | `HEADERS`, сборка заголовков, fetch с пределом, чтение тела в try | index.ts:40-45 | то же |
| 5 | статус ответа | 2 | `status < 200 или > 299` | index.ts:52 `ok`: Response.ok по спецификации fetch — 200–299 | то же |
| 6 | JWT | 1 | `jwt(Keyed)` | index.ts:67-72 | то же; срок и начало — 240 |
| 7 | токен установки | 7 | `installationToken`, `repoToken`, 404 → null, тело с repositories, возврат | index.ts:76, 119-130: 404 → not_installed сразу, порядок запросов тот же | то же |
| 8 | страницы | 3 | `per_page=100`, `got.length < 100` | index.ts:12, 57-64 | то же |
| 9 | репозитории | 3 | `allRepos`, токен metadata: read, `sort` | index.ts:98-104 | то же |
| 10 | convert, владелец | 3 | `owner?: … | null`, `owner?.login ?? ""` | index.ts:112-115: `owner.login` без проверки | **потеря**, см. ниже |
| 11 | форма и ссылка | 2 | `manifestForm`, `installUrl` | index.ts:74, 79-91, текст тот же | то же |
| 12 | журнал | 4 | `log(row)`, строка note setup, note token, refuse | index.ts:22, 114, 128, 144: ключи и порядок те же | то же |
| 13 | чтение таблицы | 2 | `readApp`, `info` | index.ts:75, 104 | то же |
| 14 | HANDLERS и вход | 9 | объект обработчиков, `frame`, `bad_frame`, fetch | index.ts:132-151, `BAD_FRAME` = "bad_frame" (protocol/contract.ts:28) | то же |
| 15 | проверки полей | 4 | typeof и регулярки redirect, org, code, repo | index.ts:19, 94-95, 109, 120: fits — typeof и test | то же |
| 16 | setup | 2 | convert, INSERT | index.ts:110-115: порядок тот же, запись до ответа | то же, кроме группы 10 |
| 17 | app, token — ответы | 3 | ответы обработчиков | index.ts:104, 129 | то же |
| 18 | vitest.config.ts | 1 | `test*.test.ts` | файл не менялся: `/**/` в строке съел разбор комментариев инструмента | не строка кода |
| 19 | комментарии | 6 | шапки файлов, Refusal, токен, репозитории, code | index.ts:1-2, 24, 66, 107, 118; «установки нет — null» снят фактом: null нет, 125 бросает отказ | то же, кроме «Нет владельца — пустая строка» — группа 10 |

Вне вывода lost:

- `migrations` класса App из wrangler.jsonc. Снято: обслуживало снесённый объект; класса нет на базе, wrangler при пустом списке миграций не шлёт (`getMigrationsToUpload`, `config.migrations.length > 0`).
- `test/raw.d.ts`. Снято: держал только тест слепка конфига.

## Потеря

Группа 10. Запись круга 3: «снято: крайний случай; GitHub называет владельца всегда».
Факт из описания API (openapi.json, `schema.mjs`): `owner` обязателен и не nullable, но это Simple User или Enterprise, у Enterprise `login` нет. Значит, «называет всегда» верно про `owner`, неверно про `owner.login`. Снос устройства тут ни при чём: ветка служила разбору ответа GitHub.

Вывод дословно на коде до правки (`red.log`):

    failed github.setup от panel~test@example.com · Error: D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'
    failed github.setup от panel~test@example.com · TypeError: Cannot read properties of undefined (reading 'login')

Предел: документация потока manifest называет только адреса личного аккаунта и организации, форма шлёт на них же. Enterprise-владелец в этом потоке документом не подтверждён и не отрицается, на настоящем GitHub не проверено: приложения не создавали. Одноразовость code — из старого комментария, документация говорит только про час.
