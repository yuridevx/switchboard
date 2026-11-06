# lost-review: conversation2 (host/modules/chat, web/packages/chat, web/packages/ask)

База 106e8e6. `lost`: строк и литералов старого кода 3791, пропало 1091. `--comments`: комментариев 162, пропало 58.
Прочитано всё: оба вывода целиком и старые файлы границы целиком рядом с новыми. Чужие разборы не открывал.

Статусы: потеря (красный тест, правка, коммит) · снято (причина-факт) · запись (отличается на достижимом пути без вреда) · то же (где в новом коде).

## Группа 1. host/modules/chat/src/ask.ts (94 строки, 10 комментариев)

| было | где теперь | статус |
|---|---|---|
| asked/of, Entry с settle: null | ask.ts:24-27 open + closed | то же: already_answered и unknown_question различаются так же |
| audience, human | ask.ts:14,30 | то же |
| notify(type, callsign, to, push) | ask.ts:32 | то же; кадр дополнен полем question, push.ts его не берёт (host/modules/push/src/push.ts: type, from, notify) — запись |
| pushOf, кнопки при одном вопросе с одним выбором | ask.ts:66-72 | то же |
| ask: кадр, пуш, Promise, close, onAbort | ask.ts:37-74 | то же, порядок close → notify → resolve сохранён |
| close({ by, ...reply }): always и message в answered | ask.ts:53 берёт только by, answers, action, content | запись: контракт их не называет, потребитель answered читает by, answers, cancelled (web/packages/ask/src/store.ts onAnswered) |
| act = action ?? "accept" в answered и пуше формы | ask.ts:53-54: при ответе без action поля нет, пуш «by: » | запись: веб всегда шлёт action (Screen.tsx FormQuestion), action кадра никто не читает |
| answer: проверки, слова | ask.ts:104-120 | то же |
| list | ask.ts:121 | то же |
| intoInput | ask.ts:18-21,124-126 | то же |
| askUser, permission, form | ask.ts:76-102 | то же; updatedPermissions при пустых suggestions не ставится — запись, пустой список ничего не меняет |
| once: true у abort | ask.ts:46 снимает в close | то же |

## Группа 2. host/modules/chat/src/chat.ts (59 строк, 6 комментариев)

| было | где теперь | статус |
|---|---|---|
| wrap, task, gitFiles, findFiles | chat.ts:16-41 | то же |
| session(), page() | chat.ts:50,98-107 | то же; проверка полей раньше поиска сессии — запись: ядро отказывает offline по callsign до модуля (kernel.ts:438) |
| viewerOf, слово `${type}: нет from` | chat.ts:55 «без from» | снято: from ставит relay и ядро, путь без from не достижим (kernel.ts:463, fleet.ts:165) |
| message: from = "" | chat.ts:93 String(ctx.from) | снято: та же причина |
| `if (f.type === "roster")` | потеря | ПОТЕРЯ 1, коммит 5ce7526 |

## Группа 3. host/modules/chat/src/feed.ts (27 строк, 3 комментария)

| было | где теперь | статус |
|---|---|---|
| Feed, flush, watch, unwatch, viewers, present, flushAll | chat.ts:45-48,61-70,76-78 | то же; номер растёт только при отправке, как было |
| event: без зрителей пачка не копится | chat.ts:126-130 копит и сбрасывает на flush | запись: кадра без зрителей нет, номер не растёт; зритель, пришедший в окно 100 мс, получает на пачку больше |

## Группа 4. web/packages/ask/src/store.ts (19 строк, 2 комментария), module.tsx (2 и 1)

| было | где теперь | статус |
|---|---|---|
| askedText, Asks, shown, asked, askedTool | store.ts:36,91-99 | то же; экспорт askedText снят: потребителей нет |
| импорт machineOf из протокола | store.ts:29 своя строка | запись: на callsign сессий результат тот же |
| `known.add(cs)` на кадр вопроса | нет | ПОТЕРЯ 9: лишний question.list на каждый вопрос, коммит ff9abfe |
| list без условия в mount и onQuestion | store.ts: только при открытой связи | ПОТЕРЯ 10: без связи экран говорит «нет ждущих вопросов», коммит 86271fa. Первый вариант теста был пустым: стенд переподключался за 5 мс; переписан с pauseMs 60 000, красный на прежнем коде |
| module.tsx | module.tsx | то же |

## Группа 5. web/packages/ask/src/Screen.tsx (22 строки)

| было | где теперь | статус |
|---|---|---|
| обёртка `.ask-qh` вокруг чипа инструмента | нет | ПОТЕРЯ 11: `.ask-q` — колонка flex, чип растянут на всю ширину, коммит 11197f6 |
| send(), subject, what | Screen.tsx reply, subjectOf, rules | то же |
| слова исхода | Outcome, LATE | то же |

## Группа 6. web/packages/chat/src/store.ts → talk.ts (225 строк, 12 комментариев)

| было | где теперь | статус |
|---|---|---|
| ownEntry, «своё сообщение — в ленте сразу» | Send отдельно, pending под всеми строками | ПОТЕРЯ 2, коммит ad2b07c |
| put("") только в submit | send и side чистили поле | ПОТЕРЯ 3, коммит 1f208c0 |
| take, seen, delta, partial | addEvent, fold seen | то же |
| merge оставлял partial | merge снимает stream_event | запись: при обрыве посреди ответа живой текст пропадает до готового сообщения, затем виден целиком |
| cancel: put затирал поле | giveBack: поле не трогает, снятый текст при занятом поле не возвращается | запись: вред сопоставим, в старом терялось новое, теперь снятое; новых подписей бриф не позволяет |
| onRoster без условия | talk.ts roster только при открытой записи | ПОТЕРЯ 8: строка смены аккаунта у неоткрытой сессии, коммит c7340df |
| unwatch всегда | только при can | запись: отказ машины без session.watch не шлётся |
| run.asked, loadModels, loadCommands | models, commands | то же |
| env, Env | view/env.ts, Screen.tsx | то же |
| act возвращал ответ | не возвращает | снято: потребителей нет |

## Группа 7. web/packages/chat/src/fold.ts (195 строк, 10 комментариев)

| было | где теперь | статус |
|---|---|---|
| id строки от uuid и msg.id | key от порядка | ПОТЕРЯ 4, коммит ebc13c2 |
| field(): оба написания | снято | снято: коммит f5b0f2a, опыт на SDK 0.3.311; настоящий файл разговора в host/modules/chat/test/boundary.test.ts compacted() |
| refusalFallback, значок shield-off | значка нет | ПОТЕРЯ 6, коммит 1b92ad1 |
| снятие отозванного по u | fold: seen заполнен заранее | то же |
| tool.result.raw | снято | снято: чтения нет ни в старом tools.ts, ни в виде |
| emptyView, step, partial | fold, STEP, stream | то же |
| m.arrived | m._at | то же |
| files в строке me | Rows.tsx из Send | то же |
| имена значков stop, memory, model, reset, file | square, book-open, sparkles, rotate-ccw, file-up | то же, view/icons.tsx |

## Группа 8. focus.ts и export.ts (18 и 11 строк)

t → k, id → key, exportMd перенесён в focus.ts:71. То же. Своё сообщение в выгрузке и фокусе вернула потеря 2.

## Группа 9. tools.ts и words.ts (9 и 2 строки)

Перестановки: DENIED перенесён в tools.ts, SEARCH и SHELLS развёрнуты, ToolState снят как тип. То же.

## Группа 10. view/Composer.tsx (83 строки, 2 комментария)

Поле живёт в сторе, bindComposer и ComposerHandle сняты вместе с устройством. Запуск модулей ждётся до связи (core/src/start.ts:99), гонки черновика нет. Каретка после fill и giveBack не сбрасывается — запись: подсказки на устаревшей каретке, следующий ввод её выставляет. Очистка после отправки вернулась с потерей 3.

## Группа 11. view/Dock.tsx и view/Panel.tsx (34 и 62 строки, 1 комментарий)

Dock: то же, добавлен признак снятого компонента. Panel: useLoad заменён одним циклом, разделы те же; панель закрывается, когда canAct стал ложным — запись: кнопка её открытия скрыта тогда же. Значение null от метода показывает пустой заголовок — запись: метод с таким ответом не встречен.

## Группа 12. view/Rows.tsx (102 строки, 1 комментарий)

memo снят — запись: Markdown мемоизирован по тексту (ui/src/md/Markdown.tsx:78), тяжёлая часть не перерисовывается; замера нет. Остальное то же. data-state echo → ok — запись: в CSS селектора нет.

## Группа 13. view/Screen.tsx (52 строки, 3 комментария)

«Раньше» было Btn, стало button — ПОТЕРЯ 7, коммит df0fa6c. Остальное то же.

## Группа 14. view/Tool.tsx (58 строк)

Картинки в ReadBody — ПОТЕРЯ 5, коммит b957211. Значки перенесены в icons.tsx. Остальное то же.

## Группа 15. module.tsx чата и vitest.config.ts (16 и 1 строка)

Новые имена createTalks и talks. То же. Строка конфигурации тестов — артефакт поиска по литералу.

## Сравнение с прежним разбором

Прочитан ../conversation/disputes.md, после своих правок.

- Запись «проверка `f.type !== "roster"`: модуль получает кадры только из uses, roster там один» неверна по факту: в uses host-chat пять имён, kernel.ts зовёт on.frame на любое. Отсюда потеря 1. Мутант выжил, потому что лесов на кадр участника не было.
- Запись «`Run/outbox/composer handle/partial` — устройство прежнего стора» сняла вместе с устройством поведение: своё сообщение как запись ленты. Отсюда потеря 2.
- Запись «ask store: known возвращено» верна для поля, но не для `known.add` на кадр: потеря 9.
- Совпало: memo снят, второе написание полей снято опытом, «нет зрителей» в on.event — у меня запись без вреда.
