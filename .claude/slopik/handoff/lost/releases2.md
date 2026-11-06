# Сверка границы `releases`, раунд 2

База 106e8e6. Вывод `lost`: 1123 строки файла, 1057 пропавших строк и литералов из 1795; `--comments`: 159 строк файла, 115 пропавших комментариев из 147. Прочитано всё, старый код прочитан файлами целиком (21 файл), новый — целиком.

Запись: что было · где в новом · решение.

## Потери: подтверждены красным тестом, исправлены

| № | что было | чем видно снаружи | новый код до правки | коммит |
|---|---|---|---|---|
| 1 | `on: true` снимает и `force` (`edited`) | следующий `on: false` без force убивает дерево процесса (keeper parts.go:48) | index.ts `entryOf` держал force | 814db23 |
| 2 | запись без версии и без stable — no_release всегда | `pin: null` у части без stable: часть молча уходит с машины | index.ts условие `!was && !everywhere` | bde7d9e |
| 3 | `no_build` у into без корня | падение `Cannot read properties of null (reading 'uses')` вместо слова | build.ts draftOf | 4b7b4e5 |
| 4 | `without` не называет выкладываемую часть | сборка с модулем, журнал «сняты X» | deploy.ts deployModule | fd44770 |
| 5 | newestDraft фильтрует по into новейшей версии | модуль, вышедший из into, застревает: `version: null` идёт по into новейшей и до него не достаёт | build.ts draftOf | 1dc29dd |
| 6 | fleetSet: ОС — версия из планов (`planned`, `pinned`) | загруженный keeper рушит или ложно пропускает проверку набора | build.ts `inPlan` + новейший манифест | 82119ab |
| 7 | `machineEdge` и partView: сборки, иначе каталог | корень машины без сборок: edge null, `deploy host` и `*` — no_release «нет версии в каталоге» | deploy.ts edgeOf, index.ts rowOf | 4a6a934 |
| 8 | shipScript: `tags.at(-1)` | сборка лежит, выкладка оборвалась — `*` отказывает no_release | deploy.ts deployCloud | 67ed6fd |
| 9 | list неизвестной части — `{}` | опечатка — строка части машины с нулями | index.ts list | e926bb9 |
| 10 | log: `t`, `part: "releases"`, `from` | строки вне общего формата (ledger, push, github, points, prefs пишут его), отказ без того, кто спросил | env.ts line | 86ec80c |
| 11 | sendPlans: planOf внутри try | сбой R2 после записи — исключение вместо ok, план остальным не уходит | fleet.ts | 49edf3c |
| 12 | `checked`: нет объекта — весь вывод в отказе | причина падения host --check заменялась на «без ответа» | core.ts | dd8911b |
| 13 | `--out` без значения — незнакомый аргумент | архив молча во временной папке | cli.ts options | c5ac7af |
| 14 | buildKeeper: finally снимает папку | упавший go build оставляет папку с бинарником | keeper.ts | 7108570 |
| 15 | os: решает `dist/app.json` | dist/ без app.json и app.json в корне — архив без app.json | folder.ts | 7cb94fc |
| 16 | log tool: part необязателен | модель не может спросить весь журнал, схема отказывает | parts.ts | ce5ab76 |
| 17 | log: host.read, 10 с | молчащая машина держит ход сессии 2 минуты | parts.ts | c27acb3 |
| 18 | fetchTo: entries до rmSync | плохой архив сносит vendor | parts.ts | f1c6599 |
| 19 | описания: force, remove и data/, новая часть, «уже так — ok», stable не трогает, каталог не ответил, машина не на связи | модель не знает, что значит force и как добавить часть; в set стояло «Чистый перезапуск части: чистый перезапуск» | parts.ts | 917b123 |
| 20 | spawn: windowsHide | у агента без консоли окна на рабочем столе | spawn.ts | ff99c56 |
| 21 | walk: режим файла по stat у всех файлов, ядро `...f` | файл с +x у пакета и ОС без dist/ уходит 0644: keeper не запустит | folder.ts, core.ts | a6f6fbd |
| 22 | process.exit | снятая по пределу сборка оставляет потомка с трубами, CLI висит до его конца | cli.ts | 98d4f10 |

## То же другими именами: найдено в новом коде

- host/modules/parts: asJson → json, say → text, refusedText → refused (release), worded → guarded, inFolder → resolve, forward → answer, machineState → list, listAll → list, uploadFrom и fetchTo → инструмент и take.
- release-cli: parse → options, asker → netOf, heldArchive и differing → compare, differs, realExec и realGo → значения по умолчанию main, deliver, send → upload, corePackages → packagesOf, releasedPackage → released, coreFiles → filesOf и coreArchive, step → вложенная step, spawn: Ran → Done, why → out.
- release: archive → tar (nameFields → split, foldersOf → pack, pathOrder → first и сравнение, readTar → read), layout → sign и catalog (byVersion, isBuild, isVersion, tgzKey, shaKey → key), link → sign, page → build (withImportMap → withImports), transfer → exchange, parseJsonc → keepStrings, workerNames → workersOf, namedManifest → named, needWrangler → named, filesOf → by.
- releases: builds → build (Ask → Change, Pinned → манифест, currentDraft и newestDraft и changedDraft → draftOf, noteOf → note, nextNumber → nextBuild, scriptsUsed → owners, archiveFiles → hostBuild и webBuild, store → два put), cloudflare → cloud (api → call, Versions → CloudState и cloudOf, deployVersion → release, uploadAssets и publishStatic → publish, addressesOf → addressing), requests → index (askPlan → plan, partView → rowOf, modulesView → modulesOf, uploadLinks → upload, edited → entryOf, setPlan → set), fleet (readFleet → readRow, saveFleet → writeRow, ALWAYS → EVERYWHERE, SELF → ME, deployed → journal, followers → follows, moveStable → advance, linkTo → cat.link), deploy (shipScript → deployCloud, deployMachine и machineEdge → machineMove, deployNamed → deployOne и deployModule), refusal → env.

## Снято: причина — факт

- Нет строки флота — «миграция не применена»: 0001_fleet.sql создаёт таблицу и строку одним файлом; таблицы нет — падали оба кода.
- Запись вида NUL читается как файл (`block[156] || 48`): архивы пишет только `pack`, тип всегда 0 или 5.
- `lockOf` без lockfile: `npm install --package-lock-only` до него либо пишет файл, либо step отказывает.
- `manifestOf` читает только первую запись: новый читает все записи начала, особой записи `pack` не пишет.
- `pathOrder` по байтам: разница с `<` только у путей за пределами BMP; таких нет, хэши 47 из 47 те же.
- `advance` без цепочки rev при двух корнях машины: `sdk-core` в экосистеме один (`host`), into вне sdk и web нет (факт: 32 манифеста, приложения host, pult, phone).
- Оболочка без `workers[FLEET]`: флоты test и prod есть в каждом wrangler; старый код здесь писал бы stable части Cloudflare в строку флота.
- `addressing` зовётся и без Worker'ов в сборке: у настоящей сборки Worker'ы всегда есть (relay).
- Файлы статики с одним хэшем (byHash): в dist пульта и телефона одинаковых файлов 0 из 7 и 0 из 7.
- `r?.jwt` при `result: null`: wrangler читает `res.jwt` без проверки, такого ответа нет.
- Blob и File у metadata: одна часть формы, другое имя файла; подделка API читает её одинаково, настоящий API не проверен (см. отчёт).
- `f.remove === true`, `f.latest === true`: инструмент шлёт логические значения по схеме; строка в POST даёт то же, что `true`.
- `sha256` строкой: `String(x)` у массива: значение только сравнивается, в ссылки не идёт.
- Описания аргументов `.describe()`: то же сказано в описании инструмента.
- `version: "1.0.0"` у сервера MCP: значение SDK по умолчанию; `s.info.cwd ?? process.cwd()`: `cwd` в типе обязателен.
- `vitest.config.ts`: файл не менялся, строка — разбор скрипта.

## Отличается от старого, вреда нет: запись, кода нет

- Адреса и загрузка: `differs` не ловит удалённый пустой файл; занятый номер сравнивается без lockfile и режимов (решение приёмки 5a8c9f1).
- `packageFiles` не берёт файлы с точкой (`.env` больше не уходит в каталог) и файлы с именем `dist` и `test`: в 47 модулях таких нет.
- external `@switchboard/web-*` вместо списка модулей страниц; REACT без `jsx-dev-runtime`; `logLevel: warning`; без absWorkingDir: хэши 47 из 47 те же.
- Без `version` модуль с `latest` теперь входит в сборку сам, раньше молчал; владельцы uses входят и без latest (было check_failed): набор всё равно проверяется.
- Версия модуля с архивом без хэша проходит `deploy module version`: `cat.manifest` смотрит архив; архив по R2 цельный, вред не найден.
- Порядок ключей плана после правки; чтение строки флота до разбора кадра; слова отказа другими текстами при тех же кодах; `without` с именем не из каталога — теперь bad_frame.
- `uses` выкладки «*»: отказ no_release теперь до выкладки Cloudflare, если у части машины нет хэша.
- `addressing` раньше цикла, `file`-имя metadata, сжатый вывод инструментов (`JSON.stringify` без отступов).
- Байт ОС gzip постоянный: решение приёмки, тест закрепляет.

## Не воспроизвелось

- `release modules --dry-run`, старая упаковка против новой на одном дереве: 47 из 47 тех же хэшей до правок и после (`hashes-base.txt`, `hashes-after.txt`; байт ОС gzip приведён к 3).
