# Раунд lost: keeper

База 106e8e6. Вывод `lost` — 1221 строка файла (1170 пропавших строк и литералов), `--comments` — 193 строки файла (161 пропавший комментарий). Прочитаны целиком вместе со старым и новым кодом. Мерка — уточнение главной сессии: потеря — основной путь, ожидаемая ветка устава, отказ словом, graceful shutdown. Вход, до которого настоящий поток не доходит, снимается с причиной.

## Потери: подтверждены красным тестом, починены

| группа | было | в новом коде | тест | коммит |
|---|---|---|---|---|
| подмена себя | `err != nil \|\| got != version` | сверялась только строка: упавший файл ставился | TestEtSelfCheckBadExit | 9ea2b78 |
| подмена себя | `if k.leaving() return` | остановка посреди проверки: part_failed и part.failed | TestEtStopDuringSelfCheck | 5865ed6 |
| подмена себя | `holder.Prepare(cmd)` | проверка в группе keeper, без флагов окна | TestEtSelfCheckApart (красный на Linux, на Windows зелёный до правки) | 3922ab6 |
| старт | нет ответа — файл убран | по номерам из файла убивались процессы | TestEtStaleHolderFile | fad4478 |
| план | сверка с работающей версией | сверка с последней записью: откат перезапускал, версия не пробовалась снова | TestEtRollbackToRunning, TestEtFailedUpdateRetried | 47d5aa5 |
| keeper.state | `p.err = why` у exited | причины нет | TestEtExitedShowsReason | 6282326 |
| keeper.state | off: restarts 0 | счёт оставался | TestEtOffClearsRestarts | 4dcada3 |
| план | строка «plan.json не записан» | молчание | TestEtPlanNotSaved | 1a2eb12 |
| план | записи, затем снять убранные; сортировка по имени | снятие первым, убранная не видна, порядок плана | TestEtRemovedAfterEntries | 77473fd |
| POST | разбор тела до кода | код HTTP вместо слова | TestEtWorkerRefusalWord | d418686 |
| relay | writeWait 10 с | запись без предела | TestEtRelayWriteLimit | 1e21a91 |
| установка | redeemWait 30 с | 10 с | TestEtRedeemWait | 01dc7da |
| установка | http:// или https:// | любой префикс http | TestEtWorkerFlagScheme | a2946d9 |
| systemd | enable-linger с проверкой, последним | ошибка не читалась | TestEtLingerRefused | a5708ca |
| служба Windows | LsaNtStatusToWinError | номер статуса | TestEtServiceLogonRefusalWord | a4e4dbf |
| журнал | SetEscapeHTML(false) | `<` | TestEtJournalPlainText | 66cc9b7 |
| уборка версий | строка cleanup | молчание | TestEtBusyVersionCleanup | 6c35405 |
| держатель | буфер копится | процесс вставал на 4 МиБ без хозяина | TestEtHolderNoOwnerNoStall | 8aa8b90 |

## То же другими именами (найдено в новом коде)

| что было | где теперь |
|---|---|
| holder/wire.go: кадры, File, Spawn, Dial, Conn | hold.go:41-62, owner.go:27-117 |
| holder.go: start, onSignal, readOut, readErr, writeInput, waitExit, serve, pump | hold.go:141, 270, 311, 338, 287, 194-234, 391, 447 |
| tree_linux, tree_windows, Prepare, setHolderAttr | tree_linux.go, tree_windows.go (newTree, detached) |
| keeper.go: Options, Entry, Plan, loop, offer, execute | keeper.go:18-53, 70, 214, 193, 238 |
| parts.go: apply, launch, stopPart, restart, adopt, follow | parts.go: apply, start, stop, restartExited, adoptAll, owner.go watch и parts.go exited |
| install.go keeper: ensure, download, unpack, setup, command, npmCli, updateSelf, replaceSelf | fetch.go install, download, unpack, setup, resolve; self.go selfUpdate, replace |
| link.go: linkLoop, session, planFrame, askPlan, ledger | link.go link, session, frame, askPlan, ledger |
| machine.go: Home, Conf, ReadConf, Key, NameOf, WriteAtomic, Swap, Post | main.go homeDir; journal.go readConf, machineKey, writeFile; self.go replace; link.go postWorker |
| journal.go: Lines | hold.go lineSplitter |
| main.go, install.go, service_*, logon_windows | main.go, setup.go, service_linux.go, service_windows.go |
| hideConsole: ShowWindow(SW_HIDE) | service_windows.go hideConsole: FreeConsole; окно не видно, живьём не проверено |

## Снято с причиной

| что | причина |
|---|---|
| buildVersion | release-cli собирает без -X (tools/release-cli/src/keeper.ts:22) |
| копия журнала в консоль | решение круга 3, потребителей нет |
| порядок полей журнала | дизайн круга 3: порядок не контракт, читатели разбирают JSON |
| ev stderr → out со stream, поля pid, bytes, parts, buffered, owner, строка force | поиск по host и web: читателей нет |
| строгость верхнего уровня кадра плана | тест лесов TestEtVersionSwitch: поле via допускается, строгость к телу плана |
| порядок удаления папки до скачивания | каталог отказывает `version_exists` (workers/releases/src/index.ts:54): та же версия с другим хэшем на диск не приходит |
| argv[0] из папки версии, IsLocal | единственный производитель app.json — tools/release-cli/src/core.ts: `node`, `npm` |
| wss в keeper.json | --worker принимает только http(s), keeper.json пишет установка |
| ValidName: `*?"<>\|` и имена с точкой | версии и части из каталога, callsign без них; --name с такими символами отказывает ОС |
| тип node в keeper.json, keeper.json `null` | файл пишет установка |
| rev 0 | rev 0 бывает только с пустым планом (workers/releases/src/fleet.ts) |
| machine из окружения держателя | Host наследует SWITCHBOARD_MACHINE: убираются только CLAUDE_ и ANTHROPIC_ (host/core/src/kernel.ts:23) |
| USERDOMAIN в задаче при входе | install --logon идёт из сессии пользователя, где оба имени заданы |
| SWITCHBOARD_WORKERS при пустой карте | установка требует gate, карта не пуста |
| держатель с именем keeper | apply его не создаёт, execute запись keeper пропускает |
| предел снятия ничьего держателя 5 с | предел есть (1 мин) и остановка прерывает; вход — неубиваемый процесс |
| журнал флота 30 с → 10 с | предел есть, запись не дошла — строка в журнале машины, ветка цела |
| OS-stopped часть на следующем плане | остановка ОС кончается перезапуском keeper |
| ошибки schtasks /End, Control(Stop), os.Remove юнита | вход без настоящего потока; остановка службы всё равно кончается словом по пределу |
| пауза relay: сдвиг на шаг после принятого hello | вреда нет: следующий отказ ждёт 2 с вместо 1 с |
| p.run вместо записи плана при перезапуске | версия из плана не встала — старая работает дальше, это мягче старого failed |
| link до adopt, keeper.state во время adopt | итог тот же, окно в доли секунды |
| h.c.Close после «убей» без выхода | только лишнее соединение |

## Опыт не ставился, код не тронут

Записи ниже — рассуждение, а не вывод опыта: вход не нашёлся, поэтому и запускать было нечего.

| что | почему опыта нет |
|---|---|
| сбой CreateJobObject и AssignProcessToJobObject: старый код отказывал, новый молчит | способа вызвать отказ без подмены ОС не нашёл |
| ошибки os.Pipe в держателе | нужен исчерпанный запас дескрипторов |
| subtle.ConstantTimeCompare ключа | тестом не отличить; 127.0.0.1, файл 0600 |
| проверка остановки перед запуском новой версии | окно между выходом процесса и запуском; ловить не пробовал |

## Не проверено

- `/Run` после `/Create` в `install --logon` убран: запуск держится на RegistrationTrigger. Опыт требует настоящей задачи, а задачи ставить запрещено.
- FreeConsole вместо ShowWindow под настоящей задачей при входе.
- Настоящая служба Windows и настоящий systemd: на стенде только подделки.
