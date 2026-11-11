# Опись функций существующей системы Switchboard

Свод по main и ветке blocks-ch (строки ветки помечены «ветка blocks-ch»). Столбцы «в новой» и «проверено» заполняются при сверке.

## Сессии и разговор

| функция | где в старой | в новой | проверено |
|---|---|---|---|
| Открыть сессию: машина, имя, папка (с mkdir — создать путь), номер к имени (number: первый свободный), профиль, слот, модель, усилие, fast, style, thinking | host/modules/manage/contract.ts (запрос session.open v2) | | |
| Открыть сессию из разговора, лежащего на машине: resume, и копией с новым session_id (fork) | host/modules/manage (session.open resume, fork) | | |
| Слова отказа открытия: name_taken, bad_name, bad_dir, bad_spec, open_failed, offline, no_slot, slot_required | host/modules/manage/contract.ts (слова) | | |
| Сменить живой сессии модель, усилие, fast, style, thinking, заголовок разговора сразу; ответ — что подействовало (now) | host/modules/manage (session.update) | | |
| Остановить сессию (interrupt → result → close), запись остаётся | host/modules/manage (session.stop), core Session.stop | | |
| Запустить остановленную или failed сессию по resume | host/modules/manage (session.start), core Session.start | | |
| Убрать сессию (разговор остаётся на диске); after_turn: убрать после конца хода | host/modules/manage (session.remove) | | |
| Перечитать сессию: скилы и агенты с диска, внешние серверы заново (session.reload) | host/modules/manage (session.reload) | | |
| Режим разрешений сессии (поле mode, setPermissionMode, listPermissionRules); новая сессия идёт в «разрешено всё», новый процесс поднимается в нынешнем режиме | host/modules/manage (mode, session.call setPermissionMode/listPermissionRules) | | |
| Вызов метода SDK сессии из списка открытых: setModel, applyFlagSettings, interrupt, getContextUsage, supportedCommands/Models/Agents, mcpServerStatus, toggleMcpServer, reconnectMcpServer, rewindFiles, stopTask, backgroundTasks, reloadPlugins, askSideQuestion, getTaskOutput, cancelAsyncMessage, mcpAuthenticate, usage, getStatus, getHooksListing, renameSession, getSessionInfo | host/modules/manage (session.call; module.json calls) | | |
| Откат файлов сессии к сообщению (rewindFiles) | host/modules/manage (session.call rewindFiles) | | |
| Спросить сбоку (askSideQuestion) не прерывая ход | host/modules/manage (session.call askSideQuestion) | | |
| Узнать папку, модель, усилие, заголовок сессии | host/modules/manage (session.spec) | | |
| Поля сессии в roster: model, effort, parent, wing, mode, state (starting, idle, busy, waiting, stopping, stopped, failed), failed по модулям с причиной | host/core/contract.ts (SessionState, fields); host/modules/manage | | |
| Ввод человека в сессию: текст и вложения (картинки видны модели как image); ошибки bad_attachment, stopped; очередь ввода переживает resume | host/modules/chat (session.prompt) | | |
| Приоритет ввода now / next / later (InputOpts.priority) | host/core/contract.ts (InputOpts); host/modules/chat | | |
| История разговора страницами (before: uuid, limit, more); записи с тегом fleet-message несут peer | host/modules/chat (session.history) | | |
| Поиск файлов в папке сессии для упоминания (@) по подстроке | host/modules/chat (session.files) | | |
| Лента сессии зрителю: подписка и отписка, пачки событий SDK раз в 100 мс со счётчиком seq | host/modules/chat (session.watch, session.unwatch, session.events) | | |
| Сообщение человека из чата Telegram — во ввод сессии тегом fleet-message с автором группы | host/modules/chat (rooms.message) | | |
| Один перезапуск процесса claude (resume) при смерти, второй сбой до готовности — failed | host/core (CLAUDE.md «ожидаемые ветки»; kernel.ts, session.ts) | | |
| Сессии поднимаются из хранилища после перезапуска Host; сессия, остановленная намеренно, остаётся остановленной | host/core/src/kernel.ts, store.ts | | |
| Процессы claude живут у держателей: Host подменили — сессии не останавливаются | host/core/src/holders.ts; os/keeper hold | | |
| Модуль Host, бросивший ошибку, выключается, в roster сессии failed с причиной | host/core/src/kernel.ts (ловушка ошибок) | | |
| Remote Control: у каждой сессии ссылка на claude.ai (поле roster remote {url} или {error}), привязка снимается в файле разговора при смене аккаунта | host/modules/remote (enableRemoteControl, поле remote) | | |
| Сессия получает свои инструменты MCP: fleet, keys, parts, shell | host/modules/fleet, keys, parts, shell (tools) | | |
| Перенести ведущего пары на другую машину нельзя: отказ has_wing уже на пробе | host/modules/points/contract.ts (слово has_wing) | | |
| Дочь сессии: итог хода родителю сам (message report), если ввод хода дал родитель | host/modules/fleet/contract.ts (итог хода) | | |
| В системный промпт сессии добавка про флот (инструменты, правила пары); профиль даёт кусочки | host/modules/fleet/src/prompt.ts (fleet.prompt) | | |
| Лента разговора: сообщения человека, ответы Claude, служебные строки, подгрузка истории по 50 | web/packages/chat/src/view/Screen.tsx (Feed), web/packages/chat/src/talk.ts (history) | | |
| Кнопка «Раньше» подгружает более старые сообщения, лента остаётся на том же месте | web/packages/chat/src/view/Screen.tsx (Feed), web/packages/chat/src/talk.ts (older) | | |
| Лента идёт за новыми сообщениями, пока пользователь у низа; прокрутка вверх отпускает; кнопка-стрелка «К последнему» возвращает вниз | web/packages/chat/src/view/Screen.tsx (Feed) | | |
| Живой поток текста Claude с кареткой и живое «Размышляет…» с хвостом мысли; «Размышлял» разворачивается по нажатию | web/packages/chat/src/view/Rows.tsx (Think, Text), web/packages/chat/src/talk.ts (addEvent) | | |
| Индикатор работы (три точки, токены размышления) и «Сжимаю контекст…» | web/packages/chat/src/view/Screen.tsx (Work) | | |
| Ответ Claude рендерится как Markdown (таблицы, сноски, код, очищенный HTML), ссылки открываются в новой вкладке, ссылка-приглашение из текста не принимается | web/packages/ui/src/md/Markdown.tsx | | |
| Целый HTML-документ в ответе Claude показывается блоком кода с просмотром | web/packages/chat/src/view/Rows.tsx (Text) | | |
| Блок кода: язык, подсветка, кнопка копирования; для html и svg — переключатель «Просмотр / Код» | web/packages/ui/src/md/CodeBlock.tsx, web/packages/ui/src/md/CopyButton.tsx, web/packages/ui/src/md/highlight.tsx | | |
| Просмотр HTML в песочнице без сети и источника; документ, ушедший на другую страницу, снимается с кнопкой «Показать снова» | web/packages/ui/src/md/HtmlFrame.tsx | | |
| Кнопка «копировать» под готовым ответом Claude | web/packages/chat/src/view/Rows.tsx (Reply, CopyButton) | | |
| Своё сообщение появляется в ленте сразу: «отправляю…», «в очереди», «ЧЧ:ММ · доставлено / ✓ / ✓✓» | web/packages/chat/src/view/Rows.tsx (Me), web/packages/chat/src/talk.ts (send) | | |
| Очередь ввода: сообщение, отправленное пока сессия занята или ждёт, помечается «в очереди» (поле ввода: «В очередь <имя>»); приоритетов now/next/later в коде нет | web/packages/chat/src/talk.ts (send, queued), web/packages/chat/src/view/Composer.tsx (placeholder) | | |
| «отменить» у сообщения в очереди (cancelAsyncMessage): текст возвращается в черновик или сообщение «Claude уже взял это» | web/packages/chat/src/view/Rows.tsx (Me), web/packages/chat/src/talk.ts (cancel) | | |
| При обрыве связи до ответа сообщение помечается «не подтверждено» с кнопкой «отправить ещё раз» | web/packages/chat/src/view/Rows.tsx (Me), web/packages/chat/src/talk.ts (again) | | |
| Отказ доставки возвращает текст и вложения в поле ввода, тост с причиной | web/packages/chat/src/talk.ts (giveBack) | | |
| Черновик сообщения на каждую сессию сохраняется и переживает закрытие экрана и страницу | web/packages/chat/src/talk.ts (drafts, saveDrafts), web/packages/chat/src/module.tsx (store drafts) | | |
| Поле ввода растёт по тексту; Enter отправляет, Shift+Enter — перенос; кнопка «Отправить» | web/packages/chat/src/view/Composer.tsx (Composer) | | |
| Прикрепить файл или картинку: кнопка-скрепка «Вложить файл», вставка из буфера, перетаскивание файлов на форму; превью и «убрать» у каждого вложения | web/packages/chat/src/view/Composer.tsx (add, onPaste, onDrop, chat-files) | | |
| Картинки в сообщениях человека и результатах инструментов открываются в новой вкладке / показываются в ленте; вложенные файлы — чипами с именем | web/packages/chat/src/view/Rows.tsx (Me), web/packages/chat/src/view/Tool.tsx (Result) | | |
| Поиск файлов папки сессии: кнопка «@» или набор @ в поле — список файлов, стрелки/Tab/Enter подставляют путь, Esc закрывает | web/packages/chat/src/view/Composer.tsx (fq, accept, кнопка «Файл папки») | | |
| Команды сессии: кнопка «/» или набор / в начале — список команд (supportedCommands) с описаниями, плюс «/btw» | web/packages/chat/src/view/Composer.tsx (cq, кнопка «Команда»), web/packages/chat/src/talk.ts (commands) | | |
| Вопрос сбоку «/btw …»: ответ показывается над вводом (думает… / ответ / ошибка), в разговор не попадает, карточку можно закрыть | web/packages/chat/src/view/Composer.tsx (submit), web/packages/chat/src/view/Dock.tsx (sides), web/packages/chat/src/talk.ts (side) | | |
| Подсказка следующего сообщения (prompt_suggestion) в поле: нажатие или Tab подставляет текст | web/packages/chat/src/view/Composer.tsx (hint), web/packages/chat/src/fold.ts (prompt_suggestion) | | |
| Кнопка режима разрешений в поле ввода: нажатие переключает на следующий (Без вопросов, Спрашивать, Правки сами, План, Авто если модель умеет) | web/packages/chat/src/view/Composer.tsx (ModeBtn), web/packages/ui/src/labels.ts (PERM_MODES) | | |
| Кнопка «Прервать» (interrupt) пока сессия занята | web/packages/chat/src/view/Composer.tsx (chat-stop) | | |
| Панель «Контекст» (пульт): занято токенов из максимума с полосой, части контекста, расход ($, время API, строки), лимиты окон, статус Claude, правила разрешений, хуки, субагенты | web/packages/chat/src/view/Panel.tsx (Panel), web/packages/chat/src/view/Screen.tsx (Tools) | | |
| Кнопка «Сжать контекст» в панели отправляет /compact | web/packages/chat/src/view/Panel.tsx | | |
| Кнопка «Перечитать сессию» (session.reload): инструменты и команды обновляются | web/packages/chat/src/view/Panel.tsx, web/packages/chat/src/talk.ts (reload) | | |
| Режим «Фокус» (пульт): ход сжат до сообщения, свёрнутой сводки шагов «N шагов · Команда ×2…», того, что требует внимания, итогового текста и строки итога | web/packages/chat/src/focus.ts (focused), web/packages/chat/src/view/Screen.tsx (Tools, ItemView) | | |
| Выгрузка разговора в Markdown одной кнопкой «Выгрузить .md» (пульт) | web/packages/chat/src/focus.ts (exportMd), web/packages/chat/src/view/Screen.tsx (Tools) | | |
| Откат файлов к сообщению (пульт): «откатить файлы» → проба с числом файлов и строк → «Откатить» / «Отмена» (rewindFiles) | web/packages/chat/src/view/Rows.tsx (Me, Rewind), web/packages/chat/src/talk.ts (probe, apply) | | |
| Плашка отказа модели с кнопкой «Изменить сообщение» (возвращает текст в поле ввода) | web/packages/chat/src/view/Rows.tsx (Banner), web/packages/chat/src/fold.ts (refusalEnd) | | |
| Входящие сообщения: от сессии Claude, от субагента, от владельца (сессия → вам); длинные сворачиваются «показать всё / свернуть» | web/packages/chat/src/view/Rows.tsx (Incoming) | | |
| Строки состояния: «прервано», «разговор начат заново», смена модели, смена аккаунта (аккаунт: A → B), повтор запроса к API, сжатие контекста со сводкой (разворачивается), память, хуки, отклонено правилами, файлы сохранены | web/packages/chat/src/fold.ts (SYSTEM, STEP) | | |
| Плашки лимита подписки («скоро кончится» / «исчерпан» со временем сброса) и запасной модели (model_fallback, refusal_fallback) | web/packages/chat/src/fold.ts (rateLimit, SYSTEM) | | |
| Итог хода: «ход закончен · время · шаги · $ · токены в контексте»; оборванный ход — «ход оборвался» с причиной | web/packages/chat/src/fold.ts (result), web/packages/chat/src/view/Rows.tsx (case res, end) | | |
| Карточка инструмента: подпись, значок, суть одной строкой, состояние (идёт N с, готово, ошибка, отклонено, остановлено, в фоне, ждёт разрешения/одобрения), разворачивается по нажатию | web/packages/chat/src/view/Tool.tsx (ToolCard), web/packages/chat/src/tools.ts | | |
| Тела инструментов: команда (Bash/PowerShell), diff правок (+N −N, свёртка общих кусков), чтение с подсветкой, список задач, вопрос, план, субагент (задание, шаги, итог), вывод, JSON входа MCP | web/packages/chat/src/view/Tool.tsx (Body, Diff, ReadBody, AgentBody) | | |
| Просмотр HTML/SVG, записываемого инструментом Write, прямо в карточке | web/packages/chat/src/view/Tool.tsx (DiffBody, HtmlFrame) | | |
| У идущего инструмента: «идёт N с», кнопки «В фон» и «Стоп» | web/packages/chat/src/view/Tool.tsx (TaskBar) | | |
| Док над вводом: «В фоне: N» (список фоновых задач с кнопками «Вывод» (живой хвост 8 КБ раз в 2 с), «Скрыть», «Стоп») | web/packages/chat/src/view/Dock.tsx (BgRow, TaskOutput) | | |
| Док над вводом: прогресс задач Claude «N из M» с текущей задачей, разворачивается списком | web/packages/chat/src/view/Dock.tsx, web/packages/chat/src/view/Tool.tsx (TodoList) | | |
| Запущенная задача в ленте: описание, число шагов, кнопка «Стоп» | web/packages/chat/src/view/Rows.tsx (RunningTask) | | |
| Лента недоступна у машины — заметка «не отдаёт ленту — только переписка и ввод»; «Сообщений пока нет»; слова отказов подписки и истории | web/packages/chat/src/view/Screen.tsx (Feed) | | |
| Метка непрочитанного (число и текст) для сессий с закрытым чатом; сбрасывается при открытии | web/packages/chat/src/talk.ts (unread, open), web/packages/chat/src/module.tsx (marks) | | |
| Шапка экрана чата: имя, машина и модель, плашка состояния | web/packages/chat/src/module.tsx (head) | | |
| Подписка на ленту сессии и история при открытии, переподписка после возврата связи; пропуск номеров событий вызывает перечитывание истории | web/packages/chat/src/talk.ts (watch, link, session.events) | | |
| Живая строка последнего шага сессии (part=last) для колонки пары | web/packages/chat/src/view/Screen.tsx (lastStep) | | |
| Экран «Новая сессия»: поле «Имя» (обязательное, фокус при открытии), отказы имени (занято, недопустимые символы) | web/pult/modules/open/src/screen.tsx (OpenScreen), form.ts (refusal) | | |
| Выбор машины списком (на узком экране раскрывается); где больше сессий — выше | web/pult/modules/open/src/screen.tsx (machineList, pick-machine), form.ts (byLoad) | | |
| Адрес папки одним полем: подсказки подпапок (скрытые — с точки), вход в папку по клику, Tab подставляет первую, «пусто», «нет доступа» | web/pult/modules/open/src/screen.tsx (browser, keyAddr → machine.dirs), form.ts (splitAddress, shownDirs) | | |
| Последние места: 5 фишек машина+папка у почты; старт с последнего места или с самой загруженной машины и ~ | web/pult/modules/open/src/screen.tsx (recentChips), form.ts (startPlace, pushRecent), module.tsx (personal pult-open.recent) | | |
| Создание новой папки: если папки нет, кнопка «Создать и открыть»; открытие с mkdir | web/pult/modules/open/src/screen.tsx (isNew, session.open mkdir) | | |
| Пара: «ведомый» второй участник, включается копией значений ведущего, открывается вторым session.open wing_of | web/pult/modules/open/src/screen.tsx (togglePair, wing) | | |
| Поле «Что сделать?» — задача первым сообщением; кнопка «Открыть» / «Начать» / «Создать и открыть»; Ctrl или Cmd+Enter из имени и задачи | web/pult/modules/open/src/screen.tsx (Area data-f text, keyRun → session.prompt) | | |
| После открытия: вставки других модулей (open.after) и открывается карточка новой сессии; закрыть экран ✕ | web/pult/modules/open/src/screen.tsx (app.placed open.after, app.open card, op-x) | | |

## Вопросы человеку

| функция | где в старой | в новой | проверено |
|---|---|---|---|
| Вопрос сессии человеку (AskUserQuestion) уходит дающему задачу и зрителям; первый ответ выигрывает, прочим already_answered | host/modules/chat (question, answer, answered, decide.AskUserQuestion) | | |
| Запрос разрешения инструмента (perm) клиенту-человеку: allow / deny, «всегда» только предложенное SDK, причина отказа; у ExitPlanMode «всегда» = смена режима на acceptEdits | host/modules/chat (decide.*, answer action allow/deny) | | |
| Формы MCP (elicit): form, url — ответ content/action или отмена | host/modules/chat (elicit, question kind form/url) | | |
| Список ждущих вопросов сессии | host/modules/chat (question.list) | | |
| Вопрос сессии-адресату во ввод тегом fleet-question; на perm отвечает только человек (not_client) | host/modules/chat (question, answer) | | |
| В режиме bypassPermissions запросов разрешения нет | host/modules/chat/contract.ts | | |
| Отмена вопроса (cancelled) снимает его у всех зрителей | host/modules/chat (answered cancelled) | | |
| Экран вопроса: вопрос сессии (AskUserQuestion) с вариантами — один или несколько, описания вариантов, «Свой ответ» с полем, «вопрос N из M», кнопка «Ответить» | web/packages/ask/src/Screen.tsx (AskQuestions) | | |
| Запрос разрешения инструмента: инструмент, суть (команда/файл/адрес), пояснения, путь, «Весь вход» (JSON), кнопки «Разрешить», «Отклонить» (с причиной), «Разрешать всегда» при наличии предложений правил (со строкой «что ляжет навсегда») | web/packages/ask/src/Screen.tsx (PermQuestion, suggestionLine) | | |
| План на одобрение (ExitPlanMode): текст плана Markdown, «Одобрить», «Одобрить и разрешать правки», «Вернуть с замечаниями» | web/packages/ask/src/Screen.tsx (PermQuestion plan) | | |
| Форма MCP (elicitation form): поля из схемы — текст, число, список; «Отправить», «Отклонить» | web/packages/ask/src/Screen.tsx (FormQuestion) | | |
| Запрос перехода по ссылке (elicitation url): ссылка в новой вкладке, «Перешёл», «Отклонить» | web/packages/ask/src/Screen.tsx (FormQuestion, q.url) | | |
| Итог вопроса: «Ответ принят», «Уже ответили» / «Уже ответили с <устройства>», «Вопрос снят», «Вопроса больше нет»; «Не отправлено: слово» с возможностью повторить; первый ответ выигрывает | web/packages/ask/src/Screen.tsx (Outcome), web/packages/ask/src/store.ts (answer, onAnswered) | | |
| Строка «Вопрос видят: вы и телефон, пульт, …» (зрители вопроса) | web/packages/ask/src/Screen.tsx (Audience) | | |
| Плашка «ждёт ответа / ответ принят / снят / уже ответили» в шапке экрана вопроса и подзаголовок «вопрос сессии · время» | web/packages/ask/src/module.tsx (head) | | |
| В чате: на телефоне полоса «? текст вопроса — Ответить» над вводом ведёт на экран вопроса; в пульте экран вопроса встаёт прямо над вводом | web/packages/chat/src/view/Dock.tsx (AskPlace) | | |
| Метки asked(callsign) — текст первого ждущего вопроса в строках списка; asked.tool — карточка инструмента в ленте показывает «ждёт разрешения» | web/packages/ask/src/store.ts (asked, askedTool), web/packages/chat/src/view/Tool.tsx | | |
| Список вопросов сверяется с Host (question.list) при открытии, возврате связи, смене состояния waiting сессии | web/packages/ask/src/store.ts (list, onRoster, onLink, mount) | | |
| Пустой экран: «У <сессии> нет ждущих вопросов», «Загружаю вопросы…» | web/packages/ask/src/Screen.tsx (AskScreen) | | |

## Сессии между собой

| функция | где в старой | в новой | проверено |
|---|---|---|---|
| Инструмент fleet list: сессии с состоянием, родителем, моделью, профилем, слотом, именем, проектом, парой; машины с именами; проекты; клиенты | host/modules/fleet/src/tools.ts (mcp__fleet__list) | | |
| Инструмент fleet send: написать сессии, всем устройствам человека ~email или одному устройство~email, чату Telegram; undelivered в ответе | host/modules/fleet/src/tools.ts (mcp__fleet__send) | | |
| Инструмент fleet answer: ответить на вопрос сессии, которой дана задача | host/modules/fleet/src/tools.ts (mcp__fleet__answer) | | |
| Инструмент fleet open: открыть сессию на любой машине с задачей, профилем, моделью, усилием, слотом, проектом, wing (пара); итог хода придёт сам | host/modules/fleet/src/tools.ts (mcp__fleet__open) | | |
| Инструмент fleet history: последние записи разговора сессии; people — только переписка с людьми (от, к, вопросы и ответы, живёт после сжатия) | host/modules/fleet/src/tools.ts (mcp__fleet__history) | | |
| Инструмент fleet update: слот, профиль, модель, усилие, заголовок, проект, ведомый (открыть, настроить, снять) | host/modules/fleet/src/tools.ts (mcp__fleet__update) | | |
| Инструмент fleet profile: что получит сессия с списком кусочков; без списка — кусочки, слоты, ключи флота с моделями, клоны машины | host/modules/fleet/src/tools.ts (mcp__fleet__profile) | | |
| Инструмент fleet repos: список репозиториев кусочков на весь флот (показать, добавить, убрать) | host/modules/fleet/src/tools.ts (mcp__fleet__repos) | | |
| Инструмент fleet label: имя сессии или машины в интерфейсе; пустое снимает | host/modules/fleet/src/tools.ts (mcp__fleet__label) | | |
| Инструмент fleet remove: закрыть другую сессию сразу или себя после хода | host/modules/fleet/src/tools.ts (mcp__fleet__remove) | | |
| Сообщение другой сессии: во ввод тегом fleet-message; слово offline | host/modules/chat (message) | | |
| Пара ведущий–ведомый: ведомый открывается на той же машине в той же папке с именем <имя>-wing, адресуем только ведущему (pair_inside остальным), в list у ведущего поле pair | host/modules/manage (wing_of, wing); host/modules/fleet (pair_inside) | | |
| Весть ведущему о ведомом (при старте) и об обрыве посреди хода; остановка и снятие ведущего идут на ведомого | host/modules/fleet/contract.ts; manage (session.stop/remove у ведущего) | | |
| Дочерняя сессия: родитель (parent) ставится по отправителю open и виден в roster | host/modules/manage (parent) | | |
| Сообщения, которыми сессии пишут друг другу, видны в ленте как «сессия Claude · <адрес>» и «субагент · …» | web/packages/chat/src/view/Rows.tsx (Incoming), web/packages/chat/src/fold.ts (user) | | |
| Адресат сообщения в паре — поле в фокусе (у каждой стороны своё поле ввода) | web/packages/card/src/pair.tsx (Feeds) | | |
| Пара ведущий-ведомый: переключатель «Пара» в настройках создаёт вторую сессию (session.open wing_of) с теми же профилем, моделью, усилием и слотом; снятие — «Убрать пару …?» с подтверждением | web/packages/card/src/settings.tsx (PairSet, open, toggle), web/packages/party/src/party.tsx (pairSwitch) | | |
| Пара в карточке: выбор «кого показать» — ведущий, ведомый или обе стороны (стрелка ▸ между ними), выбор запоминается; на телефоне видна одна сторона | web/packages/card/src/pair.tsx (PairPick, useShown), web/packages/card/src/module.tsx (pick) | | |
| Пара на пульте: две колонки с лентой и полем ввода у каждой, у каждой стороны лампа, модель, слот и живая строка шага | web/packages/card/src/pair.tsx (Feeds, Who, Lanes) | | |
| Нажатие в ленту стороны пары ставит курсор в её поле ввода | web/packages/card/src/pair.tsx (Feeds press) | | |
| Пара в списке «Работы»: одна строка ведущего «ведущий ▸ лампа ведомого» с профилем, моделью и слотом каждой стороны | web/packages/board/src/list.tsx (PairLine) | | |
| Пара в «Сведениях» и «Журнале»: две колонки с общими рядами | web/packages/card/src/aside.tsx (Aside), web/packages/card/src/tabs.tsx (Lanes) | | |
| Дерево сессий: «открыла <родитель>» и «ведёт» с кнопками-переходами на дочерние; дочерние под родителем в списке «Работы» с отступом | web/packages/card/src/aside.tsx (Side tree), web/packages/board/src/model.ts (tree) | | |
| Чужая сессия видна с пометкой владельца (чипом); «Моё» объясняет, почему сессия моя: закреплена вами / задачу дали вы / открыли вы / открыла ваша <сессия> | web/packages/board/src/model.ts (whyMine, ownerOf), web/packages/board/src/list.tsx (Row) | | |

## Аккаунты и ключи

| функция | где в старой | в новой | проверено |
|---|---|---|---|
| Список аккаунтов машины: вход (ok/none), план, срок, лимиты по окнам (utilization, resetsAt); poll — спросить Claude сейчас | host/modules/logins (machine.accounts) | | |
| Вход в аккаунт Claude по ссылке и коду: machine.login → url, machine.login_code → почта и план; один вход за раз, новый отменяет начатый | host/modules/logins (machine.login, machine.login_code) | | |
| Проверка раз в 2 мин: есть ли вход у каждого аккаунта, чья почта в папке (чужая — «нет входа» и подмена) | host/modules/logins/contract.ts | | |
| Убрать аккаунт одним запросом: сменить в слотах на следующего, убрать из порядка, стереть папку | host/modules/logins (machine.account_remove) | | |
| Слот — упорядоченный список аккаунтов; создать, переупорядочить, удалить слот без сессий | host/modules/logins (slot.set) | | |
| Ротация аккаунтов слота по лимитам: wait у слота, сессия идёт на следующем аккаунте | host/modules/logins (slot, поле roster slot {name, wait}) | | |
| «Сменить сейчас» — принудительная смена аккаунта слота | host/modules/logins (slot.swap) | | |
| Сменить слот сессии (перезапуск между ходами); слот обязателен; имя — слот машины или ключ флота | host/modules/logins (session.slot) | | |
| Слот main заводит первый вход на машине без слотов; один аккаунт может стоять в нескольких слотах | host/modules/logins/contract.ts | | |
| Проверка ключа флота на машине: разовый запуск claude тем же вкладом, ответ — модель и время или причина | host/modules/logins (machine.key_check) | | |
| Ключи API на весь флот: список без значений, задать (адрес ANTHROPIC_BASE_URL, модели alias, окно, settings, value), убрать | workers/fleetkeys (fleetkeys.list, fleetkeys.set, fleetkeys.remove) | | |
| Машина берёт значение ключа только своим пропуском; после set/remove машины получают кадр fleetkeys.changed и обновляют папку ключа | workers/fleetkeys (fleetkeys.key, fleetkeys.changed); host/modules/logins | | |
| Ключ флота как слот: у каждой машины своя папка ключа, сессия на нём идёт тем же вкладом | host/modules/logins/contract.ts | | |
| Слова отказа: no_account, no_slot, slot_required, not_logged_in, no_reserve, has_sessions, not_started, bad_code, login_failed, refresh_locked, slot_dir_busy, account_dir_busy | host/modules/logins/contract.ts | | |
| Журнал флота получает записи о смене слота и входе | host/modules/logins (ledger.add) | | |
| Список аккаунтов: у каждого окна лимитов (5 часов, 7 дней и др.) — полоса, процент и час сброса; берётся самое свежее значение среди машин | web/pult/modules/accounts/src/screen.tsx (AccountLine, WindowLine), merge.ts (merged) | | |
| Подпись «от ЧЧ:ММ» у значения лимита старше часа | web/pult/modules/accounts/src/screen.tsx (WindowLine, OLD_S) | | |
| Подсветка аккаунта: нажатие на имя помечает его во всех строках машин, повторное снимает | web/pult/modules/accounts/src/screen.tsx (AccountLine mark, marked) | | |
| Значок ⚠ у аккаунта, если машины расходятся в тарифе или часе сброса: раскрывает, что говорит каждая машина; «Закрыть» | web/pult/modules/accounts/src/screen.tsx (ac-warn, diff), merge.ts (differs) | | |
| Автоопрос лимитов при открытии: записи всех машин, затем один опрос на почту со значением старше 2 минут, на минимуме машин; сменился аккаунт сессии в roster — опрос нового | web/pult/modules/accounts/src/state.ts (pollStale, onRoster), merge.ts (pollPlan) | | |
| Машины строками: сначала со сбоем, потом по имени; индикатор состояния, у ушедшей «ушла ЧЧ:ММ» | web/pult/modules/accounts/src/screen.tsx (MachineLine, ac-mname, ac-gone), modules/machines/src/module.tsx (machines.rows) | | |
| В строке машины очередь аккаунтов по слотам: рабочий ●, номер в очереди запаса, «нет входа», процент самого занятого окна, «вход до ДД МММ» при сроке меньше недели | web/pult/modules/accounts/src/screen.tsx (Entry) | | |
| Имя слота показывается, когда на машине их несколько; «ждёт сброса ЧЧ:ММ», если слот ждёт сброса лимита | web/pult/modules/accounts/src/screen.tsx (ac-slotname, ac-wait) | | |
| Кнопка «Сменить на следующего» у рабочего аккаунта слота (ручная ротация); итог «кто → кто» | web/pult/modules/accounts/src/screen.tsx (EntryActions act next → slot.swap) | | |
| Кнопка «Поставить сейчас» у аккаунта в запасе: делает рабочим, не из очереди — добавляет в очередь | web/pult/modules/accounts/src/screen.tsx (act now → slot.swap account + slot.set) | | |
| Порядок очереди запаса слота: «Выше» и «Ниже» | web/pult/modules/accounts/src/screen.tsx (act up/down → slot.set order) | | |
| «Убрать из очереди» и «В очередь» — состав запаса слота | web/pult/modules/accounts/src/screen.tsx (act out/add → slot.set order) | | |
| «Удалить с машины» — убрать аккаунт с машины | web/pult/modules/accounts/src/screen.tsx (act remove → machine.account_remove) | | |
| «Войти заново» у аккаунта (с входом или без): вход по ссылке для этой же почты | web/pult/modules/accounts/src/screen.tsx (act login), state.ts (beginLogin → machine.login) | | |
| «＋ войти» в строке машины: новый вход в аккаунт — «Открыть ссылку входа», «Копировать», поле «Код со страницы», «Отправить», «Отмена» | web/pult/modules/accounts/src/screen.tsx (LoginPanel), state.ts (machine.login → machine.login_code) | | |
| Итог входа «Вошёл: почта»; если вошли другой почтой — предупреждение, что исходный аккаунт не изменился; код нигде не сохраняется | web/pult/modules/accounts/src/state.ts (sendCode) | | |
| Отказы машины словами: нет запасного ниже порога, в слоте есть сессии, нет аккаунта или слота, нет входа, вход обновляется, папка слота или аккаунта занята, код не принят, вход прервался | web/pult/modules/accounts/src/state.ts (WORDS, refusal) | | |
| Отказ machine.accounts показывается в строке машины | web/pult/modules/accounts/src/screen.tsx (data-refused) | | |
| «＋ слот» с именем: создать слот на машине с первым вошедшим аккаунтом | web/pult/modules/accounts/src/screen.tsx (MachinePanel → slot.set) | | |
| «Удалить слот N» для слотов без сессий | web/pult/modules/accounts/src/screen.tsx (MachinePanel data-delete-slot → slot.set order []) | | |
| Вкладка «Ключи флота»: ключи API с адресом, моделями вместо Opus/Sonnet/Haiku, своими переменными и настройками; сколько сессий пользуется ключом | web/pult/modules/accounts/src/fleetkeys.tsx (FleetKeys, KeyLine → fleetkeys.list) | | |
| «Проверить ключ»: запрос уходит с машины, как у сессии; итог словом | web/pult/modules/accounts/src/fleetkeys.tsx (KeyLine check → machine.key_check) | | |
| «＋ ключ»: форма имя, значение ключа (скрыто), адрес, модель вместо каждой из моделей, «Дополнительно»: свои переменные окружения (＋ переменная, ✕), настройки Claude поверх профиля (JSON с проверкой); Сохранить/Отмена; у нового ключа по умолчанию окно 200K | web/pult/modules/accounts/src/fleetkeys.tsx (KeyForm, NEW → fleetkeys.set) | | |
| «Изменить» ключ: имя неизменно, пустое значение ключа = прежнее | web/pult/modules/accounts/src/fleetkeys.tsx (formOf, key-edit → fleetkeys.set) | | |
| «Удалить…» ключ с подтверждением, где перечислены сессии, которые потеряют его на следующем старте | web/pult/modules/accounts/src/fleetkeys.tsx (Confirm → fleetkeys.remove) | | |
| Слот новой сессии: слот машины или ключ флота; нет слотов и ключей — «войдите в аккаунт на этой машине», открыть нельзя | web/pult/modules/open/src/screen.tsx (slotNow, noSlots → machine.accounts, fleetkeys.list) | | |
| Адрес провайдера ключа флота знает прокси, у сессии на ключе его нет; apiKeyHelper и папка токена на диске убраны | ветка blocks-ch: host/modules/logins/src/logins.ts, host/modules/logins/src/keys.ts (удалён) | | |
| route с key — маршрут ключа флота для проверки, только внутри Host (иначе denied) | ветка blocks-ch: host/modules/logins/src/logins.ts (route) | | |
| Инструменты MCP fleetkeys.list (имя, адрес, модели, настройки; без значений) и fleetkeys.set (без значения ключа) | ветка blocks-ch: workers/fleetkeys/module.json (tools) | | |
| fleetkeys.changed уходит каждой машине одним relay.broadcast вместо перебора машин по gate.list | ветка blocks-ch: workers/fleetkeys/src/index.ts | | |

## Профили

| функция | где в старой | в новой | проверено |
|---|---|---|---|
| Профиль сессии — упорядоченный список кусочков (папки git-репозитория: плагины, CLAUDE.md и правила, settings.json, memory/); нижний выигрывает | host/modules/profiles (session.open profile, session.profile) | | |
| Сменить профиль живой сессии — перезапуск между ходами | host/modules/profiles (session.profile) | | |
| Список кусочков и наборов машины и состояние клонов репозиториев (state, op, files, error, dir, at); sync — свести сейчас | host/modules/profiles (machine.profiles) | | |
| Просмотр профиля тем же кодом, что собирает запуск: кусочки, дерево, настройки с источником и «потеряно», скилы, агенты, инструкции, память, промпт, mcp, прочее, файлы | host/modules/profiles (profile.view) | | |
| Текст файла кусочка по нажатию (больше 256 КБ — too_large, выход из папки — bad_frame) | host/modules/profiles (profile.file) | | |
| Поле roster profile [{id, state ok|error}] | host/modules/profiles/contract.ts | | |
| Репозитории кусочков: один список на флот (ключ fleet.profiles.repos), машины сами клонируют, сводят, убирают клоны; токен приложения GitHub | host/modules/profiles; workers/github (github.token); prefs | | |
| Слова: bad_profile (кольцо наборов, манифест без name, два плагина с одним именем, кусочек задаёт провайдера, вход или папку памяти), no_profile, too_large | host/modules/profiles/contract.ts | | |
| Приложение GitHub флота: форма создания (manifest), setup по code, repos установок, ссылка установки; токен установки на час к одному repo только на содержимое | workers/github (github.app, github.setup, github.token) | | |
| В новой сессии выбор профилей-кусочков, модели и усилия участника; профили подхватываются от сессии в этой же папке этой машины | web/pult/modules/open/src/screen.tsx (PartyTable, listOf), form.ts (profileHere → machine.profiles) | | |
| Экран «Профили»: кусочки по репозиториям с метками «набор»/«стиль»; поиск по профилям и по именам скилов, агентов, правил и памяти внутри них, находка ведёт на вкладку и элемент | web/pult/modules/profiles/src/ProfilesScreen.tsx (ProfilesScreen, found, go → machine.profiles) | | |
| Кнопка «Репозитории» из списка профилей ведёт в настройки | web/pult/modules/profiles/src/ProfilesScreen.tsx (data-act repos) | | |
| Просмотр кусочка с девятью вкладками: Итог, Промпт, Инструкции, Скилы, Агенты, Память, Настройки, MCP и хуки, Другие файлы (пустые недоступны) | web/pult/modules/profiles/src/ProfilesScreen.tsx (PieceView → profile.view) | | |
| «Итог»: дерево состава (ссылки на вложенные кусочки, номера, «набор»), манифест кусочка, разделы с именами-ссылками на вкладки и элементы | web/pult/modules/profiles/src/ProfilesScreen.tsx (Dashboard, DashTree, ManifestPart → profile.file) | | |
| «Промпт»: слои системного промпта (основа Claude Code, агент, стиль, добавка системы) и контекста (инструкции, домашний индекс памяти) с размерами; текст по нажатию | web/pult/modules/profiles/src/ProfilesScreen.tsx (Prompt → fleet.prompt) | | |
| Вкладки Инструкции, Скилы, Агенты, MCP и хуки, Другие файлы: строки раскрываются в текст файла (Markdown или обычный), у скила — дополнительные файлы | web/pult/modules/profiles/src/ProfilesScreen.tsx (Items, FileText, skillItem → profile.file) | | |
| «Память»: мера индекса «из 200 строк и 25 КБ», фильтр по типу, показ MEMORY.md, поиск, подгрузка «ещё N», раскрытие файла | web/pult/modules/profiles/src/ProfilesScreen.tsx (Memory, Meter) | | |
| «Настройки» кусочка: итог слияния ключ=значение, источник и проигравшие значения | web/pult/modules/profiles/src/ProfilesScreen.tsx (Settings) | | |
| На узком экране список и просмотр поочерёдно, кнопка ‹ к списку; выбранный кусочек помнится | web/pult/modules/profiles/src/ProfilesScreen.tsx (back, seen.picked) | | |
| «Репозитории» профилей: один список флота; поиск; «Подключить» из видимых приложению GitHub; «Убрать…» с подтверждением и перечнем сессий, потеряющих профили | web/pult/modules/settings/src/repos.tsx (ProfileRepos, fleet.edit PROFILE_REPOS) | | |
| У репозитория: число профилей и сессий, сводка «сведён на N из M» / конфликт / ошибка, раскрытие по машинам со временем | web/pult/modules/settings/src/repos.tsx (summary, lineText) | | |
| «Свести везде» — каждая машина сводит репозитории; «Перечитать сессии» — сведение и session.reload всем живым сессиям, итог числом | web/pult/modules/settings/src/repos.tsx (sync, reload), state.ts (syncRepos, reloadSessions) | | |
| «Свести в сессии» при конфликте: открывает сессию merge-имя в клоне и ставит ей задачу свести | web/pult/modules/settings/src/repos.tsx (resolve → session.open, session.prompt) | | |

## Точки и архив

| функция | где в старой | в новой | проверено |
|---|---|---|---|
| Снять точку сессии (блоки 1 МиБ с SHA-256, zstd в R2): разговор, файлы, пакет git; same — файлы те же; stop и interrupt | host/modules/points (points.save); workers/points (points.put) | | |
| Пометка «в R2»: точки снимаются сами — конец хода не чаще раза в 2 мин, посреди 10-минутного хода, на стопе (ждёт до 6 ч); поставить и снять пометку (снять — точки стёрты из R2) | host/modules/points (session.r2; поле roster r2 {} или {error, at}) | | |
| Поднять сессию из точки: перенос на другую машину, копия, откат, смена папки; files: «point» (вернуть файлы точки) или «keep» (оставить) | host/modules/points (points.raise) | | |
| Сухой прогон подъёма (dryRun): какая папка, какие файлы, ветка, какие другие сессии в папке | host/modules/points (points.raise dryRun) | | |
| Подъём в новой папке: клон в пустую, ветка от коммита точки без правок и чужих сессий, пакет git поверх; копия с новым именем и слотом/профилем | host/modules/points/src/git.ts, raise.ts | | |
| Перенос: прежняя машина отпускает сессию; не на связи — вернётся и отдаст дописанное; сорвалось — прежняя снова идёт | host/modules/points/src/raise.ts | | |
| Слова: not_r2, waiting, running, bad_point, bad_dir, has_wing, not_owner, missing | host/modules/points/contract.ts; workers/points/contract.ts | | |
| Реестр точек: points.put (в т.ч. «каких блоков нет» и ссылки PUT на блоки), points.get (строки и ссылки GET), points.list (обзор флота или точки сессии с line и until), points.delete (стереть сессию и её блоки без ссылок) | workers/points (контракт, registry.ts) | | |
| Хозяин сессии: raise с expect/base, чужой — not_owner; новый sid с base из другой сессии — копия | workers/points/contract.ts | | |
| Правило хранения точек: голова без срока; линия — последняя в неделе год, в дне 30 дней, прочие 2 дня; ветки по дню; конец ветки держится год | workers/points/src/retention.ts | | |
| Ночная уборка блоков (cron 03:17), итог в обзоре (sweep, bytes, blocks) | workers/points/src/registry.ts (sweep), wrangler.jsonc | | |
| Переключатель «Точки в R2» при открытии новой сессии | web/pult/modules/open/src/screen.tsx (Switch data-r2 → session.r2) | | |
| Экран «Точки» (main): сводка «N сессий в R2 из M на машинах», «только в R2», нет связи; размер R2 и последняя уборка | web/pult/modules/points/src/Overview.tsx (Overview → points.list) | | |
| Живые сессии в R2: последняя точка и «Сохранить сейчас»; перечень сессий не в R2 | web/pult/modules/points/src/Overview.tsx (Live → points.save) | | |
| «Только в R2»: поиск по имени, папке, месяцу; «Перенести на машину…» — окно подъёма: машина, слот, папка, проверка папки, «Поднять на X» | web/pult/modules/points/src/Overview.tsx (Only, RaiseWindow → points.raise) | | |
| «Удалить…» сессию из R2 насовсем, подтверждение вводом имени, без отмены | web/pult/modules/points/src/Overview.tsx (DeleteWindow → points.delete) | | |
| «Пожар»: машина не на связи — плашка «не на связи с … · N сессий ждут», «Перенести на другую машину…»: куда и слот, проверка папок, перенос всех по одной с прогрессом; новые сессии встают в проект исходных | web/pult/modules/points/src/Overview.tsx (Fire, FireWindow), target.tsx (joinProject) | | |
| Проверка папки подъёма словами: тот же репозиторий, свои правки, клон, общая папка, нет git, другой репозиторий | web/pult/modules/points/src/words.ts (checkOf), target.tsx (useProbe → points.raise dryRun) | | |
| Выбор целевой машины кнопками (ближние — проекта) или списком, слота на ней | web/pult/modules/points/src/target.tsx (useTarget, Machines, Slot) | | |
| Вкладка «Точки» в карточке сессии: «Хранить в R2» — включить, снять с вводом имени (точки удаляются сразу) | web/pult/modules/points/src/Tab.tsx (Unmarked, Unmark → session.r2) | | |
| Заголовок вкладки: последняя точка, номер, размер; «Сохранить точку» | web/pult/modules/points/src/Tab.tsx (Marked, save → points.save) | | |
| Линия точек и ветки по дням: время, первые слова разговора, номер; карточка точки (когда, почему, сообщений, с машины, git, срок хранения) | web/pult/modules/points/src/Tab.tsx (PointCard → points.list sid, points.get) | | |
| «Перенести…» сессию на другую машину: машина, слот, папка, из какой точки или «сейчас», «прервать ответ и сделать сразу»; шаги стоп, точка, подъём | web/pult/modules/points/src/Dialog.tsx (kind move, useSteps) | | |
| «Скопировать…» из последней или выбранной точки (имя и папка копии) | web/pult/modules/points/src/Tab.tsx, Dialog.tsx (kind copy) | | |
| «Сменить папку…»: копия в новой папке, прежняя забывается (session.remove), точки остаются | web/pult/modules/points/src/Dialog.tsx (kind dir, forget) | | |
| «Откатить к этой точке…»: оставить файлы как есть или вернуть к папке точки, «прервать идущий ответ», предупреждение о снятии привязки к claude.ai; нынешнее сохраняется веткой «до отката» | web/pult/modules/points/src/Dialog.tsx (kind rb, RollbackFolder, RemoteWarning) | | |
| Сообщение «последняя точка не удалась» и слова отказов (ждёт ответа человека, сессия ещё идёт, имя занято и др.) | web/pult/modules/points/src/Tab.tsx, words.ts (refused) | | |
| Метка fire: машины с сессиями в R2, которых нет в roster | web/pult/modules/points/src/store.ts (fire) | | |
| Пометка «в архиве» (бывшее «в R2»): session.archive on/off, при постановке первая точка (копия — на первом конце хода), при снятии точки удаляются из архива; поле roster archive: {} или {error, at}; слово not_archived | ветка blocks-ch: host/modules/points/src/module.ts (session.archive, поле archive) | | |
| Точка — файлы разговора и папки сессии блоками до 1 МиБ по границе строки, имя блока — SHA-256, тело zstd; в хранилище по ссылкам PUT, недостающие блоки дозаливаются | ветка blocks-ch: host/modules/points/src/snap.ts (toBlocks, snap, upload) | | |
| Пакет git (то, чего нет на remote) и сводка git — часть точки | ветка blocks-ch: host/modules/points/src/snap.ts, tools/pointfiles/src/git.ts (snapshot) | | |
| Сводка сессии в точке: заголовок (getSessionInfo; имя сессии заменяется первым запросом), модель последнего ответа, токены in и out основной нити (одно сообщение считается раз), число записей | ветка blocks-ch: host/modules/points/src/snap.ts (summaryOf), workers/points/migrations/0002_archive.sql | | |
| points.save {callsign, stop?, interrupt?}: точка по запросу, со стопом сессии и прерыванием идущего ответа; same — файлы те же | ветка blocks-ch: host/modules/points/contract.ts (points.save) | | |
| points.raise: подъём из точки — перенос на другую машину, копия, откат, смена папки; слот и профиль, имя, files keep или point; dryRun — проверка папки (same, dirty, empty, shared, nogit, other) | ветка blocks-ch: host/modules/points/src/raise.ts (plan, lay, launch), tools/pointfiles/src/git.ts (folderOf) | | |
| Подъём кладёт git-ветку точки в папку (клон при пустой, ветка при той же), разговор в папку проекта Claude, прежний файл откладывается (setAside); копия в папку той же сессии под своим именем | ветка blocks-ch: host/modules/points/src/raise.ts (lay), tools/pointfiles/src/lay.ts (writeFiles, setAside), git.ts (bring) | | |
| Отказы подъёма: has_wing (сначала снять ведомого при переносе), running, bad_point, bad_dir (другой репозиторий), store_failed; сорвавшийся перенос возвращает сессию на прежней машине; прежняя машина отпускает сессию (session.remove) | ветка blocks-ch: host/modules/points/src/raise.ts (plan, launch, release) | | |
| Точка подъёма (why raise) с base и expect: копия из другой сессии — копия, чужой хозяин — not_owner | ветка blocks-ch: host/modules/points/src/raise.ts (rule.save), workers/points/contract.ts (PointsPut) | | |
| switchboard pull (callsign или sid) [--point N] [--dir путь]: сессия из архива на свой компьютер без Host (пропуск и адрес points из окружения), печатает команду cd … && claude --resume | ветка blocks-ch: tools/pointfiles/src/pull.ts, tools/release-cli/cli.ts (pull) | | |
| Ссылки на блоки (GET) points отдаёт машине и устройству человека, байтов не видит | ветка blocks-ch: workers/points/src/registry.ts (points.get) | | |
| Каталог архива points.list: фильтры since, order (last или tokens), limit, q; поле search — умеет ли хранилище искать; сводка store и sweep | ветка blocks-ch: workers/points/src/registry.ts (catalog), workers/points/contract.ts | | |
| Поиск по переписке: сессии, где в разговоре последней точки есть q; отрывок ±60 знаков, запись с uuid, номер точки; хранилище без поиска — no_search | ветка blocks-ch: workers/points/src/registry.ts (catalog, hitOf), workers/blocks/contract.ts (blocks.search) | | |
| points.history: разговор точки страницами с конца (getSessionMessages SDK над файлом точки), вызовы модели (время, модель, токены, system) | ветка blocks-ch: workers/points/src/history.ts, workers/points/contract.ts (points.history) | | |
| points.delete стирает точки сессии и сразу убирает блоки без ссылок из хранилища (blocks.drop); отмены нет | ветка blocks-ch: workers/points/src/registry.ts, workers/points/contract.ts | | |
| Один контракт хранилища блоков blocks (blocks.links PUT или GET с have, blocks.drop, blocks.search) и две реализации во флоте под одним именем службы switchboard-blocks | ветка blocks-ch: workers/blocks/contract.ts, workers/blocks/block.ts, workers/blocks-r2, workers/blocks-ch | | |
| blocks-r2: блоки в R2, ссылки — подпись S3 на час, поиска нет (no_search) | ветка blocks-ch: workers/blocks-r2/src/index.ts | | |
| blocks-ch: блоки в таблице ClickHouse (ZSTD) за туннелем с Cloudflare Access; ссылки на Worker, подписаны HMAC на час; блок до 1 МиБ; поиск строк без учёта регистра и фильтр also, по одной на блок | ветка blocks-ch: workers/blocks-ch/src/index.ts (Blocks, serve, REQUESTS) | | |
| Чтение блока по ссылке со сверкой SHA-256 общее у points.history, подъёма Host и pull | ветка blocks-ch: workers/blocks/block.ts (fetchBlock, fetchFiles) | | |
| Инструменты MCP points.list и points.history: каталог архива и разговор сессии для агентов | ветка blocks-ch: workers/points/module.json (tools) | | |

## Машины и выпуски

| функция | где в старой | в новой | проверено |
|---|---|---|---|
| Каталог частей: edge, stable, версии; планы машин и rev; модули сборок (into, built, edge) | workers/releases (releases.list) | | |
| Загрузить версию части: ссылки на архив и хэш; повтор — same, другой архив — version_exists | workers/releases (releases.upload) | | |
| Скачать версию (контракт и стенд) в vendor/<часть> другого репо | workers/releases (releases.fetch); host/modules/parts (fetch) | | |
| Выложить часть: stable на версию, без version — edge; part * — части Cloudflare, keeper и host на edge; откат — старая версия | workers/releases (releases.deploy) | | |
| Новая сборка приложения при выкладке модуля; latest — все модули на новейшие одной проверкой; without и check_with; check_failed с причинами | workers/releases (releases.deploy) | | |
| Править план машины: pin (закрепить/снять), on (включить/выключить), force (убить дерево), env, remove | workers/releases (releases.set); host/modules/parts (set) | | |
| План машины keeper'у при подключении и кадром при смене (releases.plan), ссылка на архив живёт час | workers/releases (releases.plan) | | |
| Выкладка Cloudflare-частей (Worker с меткой-номером) и страниц приложений (оболочка, модули файлом, build.json) | workers/releases/src/cloud.ts, build.ts, deploy.ts | | |
| Инструмент parts list: каталог и состояние каждой машины от её keeper (pin, error timeout) | host/modules/parts/src/parts.ts (mcp__parts__list) | | |
| Инструмент parts upload: упаковать модуль из папки и загрузить | host/modules/parts (mcp__parts__upload) | | |
| Инструмент parts fetch / deploy / set / log | host/modules/parts (mcp__parts__fetch, deploy, set, log) | | |
| Журнал части на машине (по умолчанию час и 50 строк); Host мёртв — причину даёт list | host/modules/parts (mcp__parts__log) | | |
| Папки машины по имени для выбора dir: путь от ~ или полный | host/modules/machine (machine.dirs) | | |
| Список машин флота — из пропусков gate, не из relay | workers/gate (keys.list); workers/relay | | |
| Relay: вход машины и гостей по /m/<машина>, roster после каждого hello и session.state, доставка по `to`, ping, вытеснение прежнего соединения (replaced), relay_updated | workers/relay/contract.ts | | |
| Relay: кадр session.state {callsign, state, поля} заменяет запись сессии; state null убирает | workers/relay/contract.ts | | |
| Relay: слова отказа bad_frame, bad_from, offline, contract_mismatch, gate_unavailable, revoked | workers/relay/contract.ts | | |
| Панель машины по нажатию на её имя: части машины (система, keeper, части) встроенным экраном | web/pult/modules/accounts/src/screen.tsx (MachinePanel, app.Slot machine.parts) | | |
| Открытый экран аккаунтов держит ответы keeper свежими | web/pult/modules/accounts/src/screen.tsx (keeper.open / keeper.close) | | |
| Части машины: система, версия keeper и ревизия плана, части с версией, состоянием и pid, текст ошибки части | web/pult/modules/machines/src/module.tsx (Parts, Part → keeper.state) | | |
| «Перезапустить» упавшую часть (кроме keeper): выключить и включить по плану, итог в строке | web/pult/modules/machines/src/module.tsx (restart → releases.set on false, on true) | | |
| «План в «Выпусках»» из частей машины (только в пульте, машина на связи) | web/pult/modules/machines/src/module.tsx (Parts, app.open settings tab releases) | | |
| Машина, ушедшая из roster при открытой странице, остаётся с часом ухода; ушедшая раньше — час по журналу флота | web/pult/modules/machines/src/module.tsx (onRoster, machines.gone, readLeft → ledger.read) | | |
| «Выпуски»: переключатель «По машинам» / «Каталог и сборки» | web/pult/modules/settings/src/releases.tsx (ReleasesTab) | | |
| «Stable флота»: по частям версия, полоса и «N из M машин», держащих stable; «Вернуть +n» — откат на предыдущую сборку | web/pult/modules/settings/src/releases.tsx (Stable → releases.deploy) | | |
| Матрица машина × часть: версия, «→ stable», «сбой», «выключена», «📌» закреплена, не на связи; rev плана; поиск по машине | web/pult/modules/settings/src/releases.tsx (Matrix), rules.ts (cellOf) | | |
| Выбор машин галочками и массовое «host: закрепить +n» (3 последних), «host: к stable», «Снять» | web/pult/modules/settings/src/releases.tsx (Bulk → releases.set) | | |
| План машины сбоку: включить/выключить часть (кроме keeper), stable, закрепить одну из последних версий или набранную, «Закрыть» | web/pult/modules/settings/src/releases.tsx (MachinePlan → releases.set) | | |
| Каталог частей: где (машины/Cloudflare), stable, история; «Выложить edge», «Вернуть» любую прежнюю | web/pult/modules/settings/src/releases.tsx (Build → releases.deploy) | | |
| «Модули сборок»: куда входит, в какой версии в сборке, «Выложить» новее; итог выкладки строкой, не теряется при смене вкладки | web/pult/modules/settings/src/releases.tsx (Build, useDeploy) | | |

## Пропуска и люди

| функция | где в старой | в новой | проверено |
|---|---|---|---|
| Выдать пропуск одноразовым приглашением: машине (role host) или устройству и программе (role client + почта) | workers/gate (keys.invite); host/modules/keys (mcp__keys__invite) | | |
| Список пропусков: номер, роль, имя, человек, адрес, состояние wait/ok, кем и когда | workers/gate (keys.list); host/modules/keys (mcp__keys__list) | | |
| Принять приглашение: пропуск без пропуска (gate.redeem); у адреса один живой пропуск (name_taken) | workers/gate (gate.redeem) | | |
| Отозвать пропуск или приглашение: соединения номера закрываются на всех машинах | workers/gate (gate.revoke); workers/relay (keys.revoke); host/modules/keys (mcp__keys__revoke) | | |
| Пропуск говорит, кто пришёл: роль host или client, адрес, человек; проверка verify | workers/gate (gate.verify) | | |
| Какие номера отозваны (gate.revoked) — пуш сверяет подписки | workers/gate (gate.revoked); workers/push | | |
| Прямой POST кадра с пропуском к каждому Worker-модулю (to: .имя), reply телом, CORS * | workers/gate/src/entrance.ts | | |
| «Пропуска»: таблицы «Машины» и «Устройства и программы» — адрес, состояние (действует / ждёт приёма), кто пригласил, когда | web/pult/modules/settings/src/passes.tsx (PassesTab, Table → keys.list) | | |
| «Пригласить»: тип устройство / программа / машина, имя, почта (кроме машины) | web/pult/modules/settings/src/passes.tsx (InviteForm → keys.invite) | | |
| Приглашение устройству: ссылки #invite= для пульта и телефона, «Копировать», QR для телефона; программе и машине — строка приглашения; «Готово» | web/pult/modules/settings/src/passes.tsx (InvitedBox, QR, Link) | | |
| «Отозвать…» пропуск с подтверждением, соединения закрываются; свой пропуск помечен «это устройство» и не отзывается | web/pult/modules/settings/src/passes.tsx (PassRow → keys.revoke) | | |
| Пропуск — форма адреса: машина @laptop, устройство имя~почта, сессия site@laptop; программа — устройство; роли host и client убраны | ветка blocks-ch: workers/gate/contract.ts, workers/gate/src/format.ts, workers/gate/migrations/0003_addr.sql | | |
| Пропуск формата подпись.номер.секрет; прежние role.name.номер.секрет проходят verify как есть | ветка blocks-ch: workers/gate/src/format.ts (PASS), web/packages/core/src/pass.ts (keyId, keyKid, keyName) | | |
| Приглашение keys.invite {addr, owner?}: живёт 24 часа; owner (~почта) — владелец машины; адрес с живым пропуском — name_taken (адрес уникален); приём gate.redeem | ветка blocks-ch: workers/gate/src/passes.ts (invite, INVITE_MS), workers/gate/contract.ts | | |
| keys.list с фильтрами ids и kind, полями owner и wait (приглашение не принято), you — адрес предъявленного пропуска | ветка blocks-ch: workers/gate/src/passes.ts (list, filterWrong), workers/gate/contract.ts | | |
| Отзыв keys.revoke у relay: строка у gate удалена, соединения с этим номером закрыты на всех машинах (пропуск и непринятое приглашение) | ветка blocks-ch: workers/relay/contract.ts (keys.revoke), workers/gate/src/passes.ts (revoke) | | |
| relay.broadcast: Worker шлёт один кадр каждой машине флота, сбой — строка журнала; им пользуются prefs.changed и fleetkeys.changed | ветка blocks-ch: workers/relay/src/index.ts (broadcast), workers/fleetkeys/src/index.ts | | |
| Экран «Люди» (раздел «Флот»): люди флота по почте, их устройства и машины; метки «на связи» (roster), «это устройство», «ждёт входа», «вы»; свой человек первым | ветка blocks-ch: web/pult/modules/people/src/module.tsx (PeopleScreen, Person, PassRow) | | |
| «Пригласить человека»: почта и имя первого устройства (по умолчанию pult), проверка «уже во флоте», кнопка заблокирована при неверной почте или имени | ветка blocks-ch: web/pult/modules/people/src/module.tsx (InvitePerson, действие invite-person) | | |
| Карточка человека (параметр who, «← Люди»): «Назвать…» — отображаемое имя человека в записях области флота fleet.labels.people | ветка blocks-ch: web/pult/modules/people/src/module.tsx (Title, rename) | | |
| В карточке «＋ пригласить»: устройство (имя~почта) или машина (@имя с owner), переключатель и имя | ветка blocks-ch: web/pult/modules/people/src/module.tsx (InviteHere) | | |
| Результат приглашения: ссылки «Пульт» и «Телефон» с #invite=, QR телефона, «Код» (для keeper install и switchboard redeem), «Копировать», «Готово»; у машины только код | ветка blocks-ch: web/pult/modules/people/src/module.tsx (Invited, Link, QR) | | |
| «Отозвать…» у каждого пропуска с подтверждением; для своего устройства предупреждение, что оно выйдет из флота | ветка blocks-ch: web/pult/modules/people/src/module.tsx (PassRow, keys.revoke) | | |
| «Удалить из флота…» (кроме себя): отзыв всех устройств человека с подтверждением, машины остаются | ветка blocks-ch: web/pult/modules/people/src/module.tsx (Person remove) | | |
| Открыта одна форма за раз, Escape закрывает; отказы gate словами (name_taken, unknown_key, bad_client, bad_request) | ветка blocks-ch: web/pult/modules/people/src/module.tsx (OpenOne, WORDS) | | |
| Вкладка «Пропуска» настроек убрана; в «GitHub и устройство» кнопка «Люди» вместо «Пропуска»; список машин для «Выпусков» из keys.list kind machine без ждущих | ветка blocks-ch: web/pult/modules/settings/src/module.tsx, general.tsx, releases.tsx; settings/src/passes.tsx (удалён) | | |
| Раздел «Люди» входит в разделы пульта | ветка blocks-ch: web/pult/src/options.ts (sections people) | | |
| Подсказка на экране отказа пропуска: keys.invite имя~почта | ветка blocks-ch: web/packages/core/src/view/stops.tsx | | |
| Машины флота для Host и relay — из keys.list {kind: machine, v: 2} без ждущих приглашений | ветка blocks-ch: host/modules/parts/src/parts.ts, workers/relay/src/fleet-client.ts, workers/relay/src/index.ts | | |

## Уведомления и Telegram

| функция | где в старой | в новой | проверено |
|---|---|---|---|
| Веб-пуш подписки: открытый ключ VAPID, подписка браузера, «дойдёт ли пуш до этого браузера» | workers/push (push.key, push.subscribe, push.subscribed) | | |
| Пуш устройству или человеку (всем устройствам кроме тех, что на связи), текст до 4 КБ, строка журнала на устройство | workers/push (push.send); host/modules/push (notify) | | |
| Host: notify — кадр клиентам, кого нет на связи — пушем; undelivered в ответе | host/modules/push (notify) | | |
| Пуш дублируется чатам Telegram человека | workers/push (rooms.send) | | |
| Чат Telegram как устройство человека: привязка приглашением (/start <приглашение>), личка telegram~email, группа имя~email | workers/rooms (webhook, link) | | |
| Группа должна быть с темами (no_topics); сессия в чате — своя тема с именем callsign | workers/rooms (createForumTopic) | | |
| Ответ человека в теме — кадр rooms.message в Host через relay; в группе пишут только привязанные люди, автор в author | workers/rooms (onMessage) | | |
| Вопрос сессии кнопками в чате: нажатие — ответ, кнопки убираются; снятый вопрос или машина не на связи — подсказка | workers/rooms (onButton) | | |
| Реакция на сообщение человека: принято (SEEN), никто не получил (NOBODY), отказ (REFUSED) | workers/rooms/src/index.ts (mark) | | |
| Вложения из чата сессии не передаются: подпись с пометкой «вложение не передано» | workers/rooms (textOf) | | |
| Отказы rooms: no_topics, rate_limited, too_long, gone, send_failed; отзыв пропуска отвязывает чат | workers/rooms/contract.ts | | |
| Регистрация вебхука Telegram при выкладке (POST /setup с токеном бота) | workers/rooms (setup) | | |
| Полоса «Включить уведомления» с кнопкой «Включить»: запрос разрешения браузера, подписка на веб-пуши ключом Worker push и запись подписки во флот | web/packages/alerts/src/module.tsx (Bar, enable) | | |
| Состояния полосы: ждёт нажатия, «…» в работе, «Не вышло: причина» с кнопкой «Ещё раз», «Уведомления запрещены» (разрешить в настройках браузера) | web/packages/alerts/src/module.tsx (Bar) | | |
| Тост «Уведомления включены: сессии достучатся, когда приложение закрыто» | web/packages/alerts/src/module.tsx (enable) | | |
| Проверка при открытии, что подписка браузера есть во флоте; нет (пропуск отозван) — снова предлагается включить | web/packages/alerts/src/module.tsx (verify, check) | | |
| Пуш при закрытом приложении: системное уведомление с заголовком, текстом, тегом и значком | web/packages/alerts/src/sw.ts (onPush) | | |
| Кнопки в уведомлении (ответ вариантом без открытия приложения): показываются только если все помещаются в браузер | web/packages/alerts/src/sw.ts (onPush, maxActions) | | |
| Нажатие кнопки уведомления отправляет её кадр через короткое соединение с relay машины; сбой — уведомление «Ответ не отправлен: причина» | web/packages/alerts/src/sw.ts (answer, send, onClick) | | |
| Нажатие на уведомление открывает окно приложения (или фокусирует открытое) и ведёт на экран владельца пуша | web/packages/alerts/src/sw.ts (open), web/packages/alerts/src/module.tsx (take) | | |
| Пуши, пришедшие без страницы, сохраняются и доставляются владельцам кадров при старте и возврате на страницу | web/packages/alerts/src/module.tsx (take) | | |
| Сообщение из уведомления попадает в ленту чата строкой «из уведомления» и ставит метку непрочитанного | web/packages/chat/src/talk.ts (frames.message) | | |
| Вопрос из уведомления без тела подтягивается у Host и открывает экран вопроса | web/packages/ask/src/store.ts (onQuestion, wanted) | | |

## Инциденты

| функция | где в старой | в новой | проверено |
|---|---|---|---|
| Инцидент от любого приложения компьютера: POST на 127.0.0.1:<порт>/incident {type, key?, text, attachments?} → 202 {id}; 400 с bad_frame, unknown_type, bad_attachment | host/modules/incidents (HTTP) | | |
| Инцидент идёт в одну сессию по типу и ключу; сессия открывается по настройке типа (профиль, папка), правило типа — в системный промпт | host/modules/incidents (host.json types) | | |
| Доставка хотя бы раз: обращение лежит на диске, пока ход его не взял; повтор — тот же id в теге incident | host/modules/incidents/contract.ts | | |
| Список ждущих обращений incident.pending (id, type, key, callsign, refused) | host/modules/incidents (incident.pending) | | |
| Поле roster incident {type, key}; пуш на устройство to из настройки | host/modules/incidents | | |
| Экран «Инциденты» с числом открытых и недоставленных в отметке; фильтр «открытые / все» | web/pult/modules/incidents/src/module.tsx (Incidents, incidents.open) | | |
| Список «В сессиях»: тип, ключ, состояние (закрыт), позывной и машина; нажатие открывает карточку сессии | web/pult/modules/incidents/src/module.tsx (rows, app.open card) | | |
| «Не доставлены»: обращения на диске Host без сессии — слово отказа и «с ЧЧ:ММ» или «ждёт»; раскрытие показывает причину | web/pult/modules/incidents/src/module.tsx (lost, DisclosureBtn → incident.pending) | | |
| Поиск инцидентов по типу, ключу и позывному в общем поиске страницы | web/pult/modules/incidents/src/module.tsx (screens.incidents.find) | | |

## Скрипты

| функция | где в старой | в новой | проверено |
|---|---|---|---|
| Запустить скрипт bash, pwsh или PowerShell на машине флота: stdin, timeout, background (с timeout) | host/modules/shell (shell.run; mcp__shell__run) | | |
| Дождаться конца запуска не дольше timeout (0 — посмотреть сейчас), итог живёт сутки | host/modules/shell (shell.wait; mcp__shell__wait) | | |
| Убить запуск (всё дерево) | host/modules/shell (shell.kill; mcp__shell__kill) | | |
| Какие шеллы есть на машине: версия и путь | host/modules/shell (shell.info; mcp__shell__info) | | |
| Файлы из $SB_OUT возвращаются: картинки изображением, текст текстом, прочее файлом | host/modules/shell/contract.ts | | |
| Конец фонового запуска — сообщение владельцу во ввод сессии | host/modules/shell (message) | | |
| Снимок запуска: state running/exit/timeout/killed/stopped, code, ms, stdout, stderr, files; слова no_shell, no_run, bad_frame | host/modules/shell/contract.ts | | |

## Журналы

| функция | где в старой | в новой | проверено |
|---|---|---|---|
| Журнал машины: строки host и keeper после since, фильтры kind (stop/refuse/note), session, part, страницы more | host/modules/journal (machine.journal) | | |
| Журнал сбоев сессии: сбои из сообщений SDK — строками журнала, env CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1 | host/modules/journal | | |
| Журнал флота: записи ledger.add (событие, текст, кто, машина, сессия), чтение новых вперёд с before/after и фильтром machine | workers/ledger (ledger.add, ledger.read) | | |
| Запись «машина ушла / вернулась» от relay | workers/ledger (machine.left, machine.back) | | |
| Файлы журнала на диске: journal/host-<дата>.jsonl, keeper-<дата>.jsonl, строка JSON с t, part, machine, who | host/core; os/keeper/journal.go | | |
| Журнал Worker-модуля: строка на отказ и остановку | workers/* (log) | | |
| Журнал флота: записи по дням (Сегодня, Вчера, дата): время, текст, «by кто», позывной или машина | web/pult/modules/journal/src/module.tsx (Journal, Row → ledger.read) | | |
| Фильтр журнала по машине и поиск по загруженным записям (текст, событие, машина, позывной, кто) | web/pult/modules/journal/src/module.tsx (Sel data-f machine, In data-f q) | | |
| «Раньше» — дочитать старые записи; новые подтягиваются сами при смене состава флота и возврате связи | web/pult/modules/journal/src/module.tsx (earlier, catchUp) | | |

## Настройки и проекты

| функция | где в старой | в новой | проверено |
|---|---|---|---|
| Настройки человека (все его устройства), всего флота (global) и приложения (app:<имя>): prefs.get с prefix, prefs.set по ключу, до 2 МБ | workers/prefs (prefs.get, prefs.set) | | |
| Проекты и имена сессий и машин — записи области флота, общие для страниц и агентов | tools/records (PROJECTS, LABELS, addProject, placeSessions, setLabel…) | | |
| Цикл правки настроек (edit) с повтором при конфликте | tools/records/src/settings.ts | | |
| Список репозиториев профилей — ключ fleet.profiles.repos | tools/records (PROFILE_REPOS) | | |
| Экран «Работа»: сессии по проектам, строка сессии с лампой состояния, именем, машиной, чипами владельца/инцидента/профиля, вопросом, сбоем, непрочитанным | web/packages/board/src/list.tsx (BoardScreen, Row, second) | | |
| Знак «?» (ждёт ответа) и точка «есть новое» в строке; нажатие на строку с вопросом на телефоне ведёт сразу на экран вопроса | web/packages/board/src/list.tsx (Row open) | | |
| Ряд фильтров «Моё», «Всё» и свои: выбор запоминается на устройстве | web/packages/board/src/list.tsx (FilterRow), web/packages/board/src/state.ts (pick) | | |
| Создать свой фильтр кнопкой «+»; повторное нажатие на выбранный свой фильтр (значок ✎) открывает его правку | web/packages/board/src/list.tsx (FilterRow), web/packages/board/src/panel.tsx (FilterEditor) | | |
| Редактор фильтра: имя, поиск по значениям, поля «Чьи / Проекты / Машины / Профили / Состояние» (внутри поля «или», между полями «и»), строка «подходит N сессий · M проектов», «Сохранить», «Удалить», «Отмена», Esc | web/packages/board/src/panel.tsx (FilterEditor) | | |
| Порядок чипов фильтров: перетаскивание (мышью с порога, пальцем с удержания), Alt+←/→ с клавиатуры, порядок хранится у почты | web/packages/board/src/list.tsx (FilterRow down, keys), web/packages/board/src/drag.ts (sorting) | | |
| Панель «Вид списка» (кнопка-ползунки): переключатели списка (По проектам, По машинам, Дочерние, В одну строку), строки (лампа, машина, владелец, закрепление, инцидент, значок, вопрос, непрочитанное, сбой, профиль, модель, слот, пара), проекта (лампы, ручка, «+»); «Вернуть», «Готово» / «✕»; на пульте ещё группа «Шапка» | web/packages/board/src/panel.tsx (ViewPanel), web/packages/board/src/model.ts (VIEW) | | |
| Проекты: заголовок со стрелкой сворачивает и разворачивает; по умолчанию развёрнут проект, где ждут вас или сбой; свёрнутый проект показывает до шести ламп по срочности; выбор хранится на устройстве | web/packages/board/src/list.tsx (Project), web/packages/board/src/state.ts (folded, firstShow, setCollapsed) | | |
| «Новый проект»: поле имени, Enter создаёт, Esc отменяет | web/packages/board/src/list.tsx (Lists, NameField), web/packages/board/src/state.ts (addProject) | | |
| Меню проекта: нажатие на ручку ⠿ (или Enter/Пробел) — переименование (Enter/уход с поля сохраняют, Esc нет) и «Удалить» | web/packages/board/src/list.tsx (Project menu, NameField) | | |
| «+» у проекта — новая сессия сразу в этой машине, папке и проекте | web/packages/board/src/list.tsx (Project pj-add), web/packages/board/src/state.ts (placeOf) | | |
| Порядок проектов: перетаскивание за ручку (мышью с порога, пальцем с удержания, автопрокрутка у края) или стрелки ↑/↓ | web/packages/board/src/list.tsx (Project down, keys), web/packages/board/src/drag.ts (sorting), web/packages/ui/src/press.ts (track, edgeScroll) | | |
| Перетаскивание сессий по проектам: строка (вместе с дочерними) бросается между строками проекта или на заголовок (в свёрнутый — в конец); линия показывает место; Esc отменяет; группа «Без проекта» | web/packages/board/src/drag.ts (rowDrag), web/packages/board/src/list.tsx (Row down), web/packages/board/src/state.ts (drop) | | |
| Проект сессии определяется по записи и по родителю; новая сессия, открытая с проектом, встаёт в него (board.assign) | web/packages/board/src/module.tsx (board.assign), web/packages/board/src/state.ts (assign, projectOf) | | |
| Закрепление сессии: пункт «Закрепить» / «Закреплена» в меню карточки; закреплённая попадает в «Моё», значок булавки в строке | web/packages/board/src/module.tsx (board.pin, board.unpin) | | |
| Кнопка «Новая» / «+» открывает форму новой сессии | web/packages/board/src/module.tsx (head action), web/packages/board/src/list.tsx (bd-lh) | | |
| В широком виде вход на «Работу» сразу открывает карточку последней/первой сессии справа; открытая строка подсвечивается и прокручивается в видимое | web/packages/board/src/list.tsx (BoardScreen entry, Lists scrollIntoView) | | |
| Метки проектов для других модулей: mine, project.machines, project.current, project.of | web/packages/board/contract.ts, web/packages/board/src/state.ts (marks) | | |
| Настройки фильтров, порядка, закреплений — у почты человека; проекты — в области флота; вид, свёрнутость, выбранный фильтр — на устройстве | web/packages/board/contract.ts, web/packages/board/src/state.ts, web/packages/ui/src/personal.ts | | |
| Имена: окно «Имена» (в карточке — кнопка «Имена» / нажатие на имя) — имя сессии и имя машины, Enter сохраняет, Esc и фон закрывают, «Сохранить» / «Отмена»; имена общие для флота | web/packages/labels/src/module.tsx (Window, Screen), web/packages/card/src/head.tsx (NameBtn), web/packages/card/src/narrow.tsx (Info) | | |
| Человеческие имена показываются вместо адресов всюду (метки label.session, label.machine); без имени — короткий адрес | web/packages/labels/src/module.tsx (marks), web/packages/ui/src/sessions.ts (sessionLabel, machineLabel) | | |
| Карточка сессии на телефоне: вкладки «Чат» и «Ещё»; «Ещё» — адрес, папка, слот, аккаунт, профиль, сбой, настройки пары, кнопки вставок, «Имена», «Запустить / Остановить» с итогом отказа | web/packages/card/src/narrow.tsx (NarrowCard, Info, Control) | | |
| Карточка сессии на пульте: шапка в одну строку (лампа, имя и машина, владелец, профиль, модель и усилие, аккаунт и лимит; нажатие на модель/аккаунт ведёт на «Настройки»/«Сведения»), вкладки «Разговор», вкладки других модулей, «Настройки», «Журнал», «Сведения» | web/packages/card/src/wide.tsx, web/packages/card/src/head.tsx (Head, Facts) | | |
| Кнопка «Запустить» в шапке у остановленной или упавшей сессии; плашка «Не запустилась: причина» с кнопкой «Почему» (ведёт в журнал) | web/packages/card/src/head.tsx (Start), web/packages/card/src/wide.tsx | | |
| Подсказка у лампы состояния (слово состояния, причина сбоя), «не на связи» для ушедшей сессии | web/packages/card/src/head.tsx (Lamp) | | |
| Настройка шапки карточки: переключатели Машина, Владелец, Профиль, Модель, Аккаунт (группа «Шапка» в панели вида), «Вернуть» сбрасывает | web/packages/card/src/module.tsx (HeadGroup, card.head.reset) | | |
| Меню карточки: пункты других модулей (card.menu) — кнопки в шапке пульта и на «Ещё» телефона | web/packages/card/contract.ts, web/packages/card/src/head.tsx, web/packages/card/src/narrow.tsx | | |
| Вкладки других модулей в карточке (card.tab) | web/packages/card/src/wide.tsx, web/packages/card/src/narrow.tsx | | |
| Вкладка «Настройки»: профиль, модель, слот, усилие сразу уходят в сессию («после хода» — применится после хода; «Не вышло: причина») | web/packages/card/src/settings.tsx (PairSet), web/packages/card/src/tabs.tsx (SetTab) | | |
| Режим разрешений в настройках: кнопки Без вопросов / Спрашивать / Правки сами / План / Авто | web/packages/card/src/tabs.tsx (ModeSec) | | |
| Переключатель «Быстрый режим» | web/packages/card/src/tabs.tsx (FastSec) | | |
| Поле «Заголовок в claude.ai» (Enter/уход с поля сохраняют, Esc возвращает) | web/packages/card/src/tabs.tsx (TitleSec) | | |
| Кнопки «Запустить» / «Остановить» и «Убрать…» (остановка и удаление из списка, точки в R2 остаются) с подтверждением на месте | web/packages/card/src/tabs.tsx (ControlSec), web/packages/card/src/narrow.tsx (Control) | | |
| Таблица настроек участника: профили (порядок перетаскиванием за ручку или стрелками ←/→, Esc отменяет, «✕» убрать, поиск «Найти профиль», до шести предложенных «+ профиль» по частоте использования, пометки «набор»/«стиль», развёртка набора «→ a › b»), модель (opus, sonnet, haiku, fable), слот (на машине «тут» и ключи флота «флот» с ожиданием сброса), соответствие модели ключу, усилие (низкое…макс.) | web/packages/party/src/party.tsx (PartyTable, useCells) | | |
| Вкладка «Журнал» машины для сессии: фильтр по виду (все, stop, refuse, note), записи по 50 с кнопкой «дальше →», «Раньше» на день назад, «Записей нет» | web/packages/card/src/tabs.tsx (LogTab) | | |
| Вкладка «Сведения»: кто дал задачу, модель и усилие, адрес, машина, инцидент, папка, профиль; «Открыть в claude.ai» | web/packages/card/src/aside.tsx (Side) | | |
| «Сведения»: аккаунт и план, слот, лимиты окон с полосой и порогами (70 % / 90 %), «очередь слота», кнопка «Сменить слот» | web/packages/card/src/aside.tsx (Side account), web/packages/ui/src/parts.tsx (LimitRow) | | |
| Серверы MCP сессии: статус (подключается, выключен, нужен вход, подключён, ошибка), «вкл/выкл», «Переподключить», «Войти» (ссылка входа «Открыть страницу входа») | web/packages/card/src/aside.tsx (Servers) | | |
| Экран «Вам»: карточки ожидающего, сгруппированные «Ждут ответа», «Сломалось или ждёт», «Готово» со счётчиком; «Всё разобрано» когда пусто | web/packages/inbox/src/module.tsx (Screen, GROUPS) | | |
| Карточка «спрашивает» — вопрос с вариантами ответа прямо в карточке (экран ask внутри) | web/packages/inbox/src/module.tsx (Item) | | |
| Карточка «пишет вам» с текстом непрочитанного и кнопкой «Открыть» | web/packages/inbox/src/module.tsx (cards, actions) | | |
| Карточка «не запустилась» с причиной, кнопками «Запустить снова» и «Почему» (на телефоне — вкладка «Ещё») | web/packages/inbox/src/module.tsx (actions, restart) | | |
| Карточка «ждёт сброса лимита» (слот у порога, продолжит после времени) с «Открыть» | web/packages/inbox/src/module.tsx (cards) | | |
| Карточка «не на связи с …» — машина ушла, список моих сессий на ней; «машин не на связи: N»; кнопка «Поднять из точки» | web/packages/inbox/src/module.tsx (cards, actions) | | |
| Карточка «готово» (сессия закончила ход и свободна) с «Открыть» и «Прочитано»; уходит сама при открытии сессии | web/packages/inbox/src/module.tsx (finished, read) | | |
| В карточках «Вам» к метке добавляется проект сессии; ведомый открывается через своего ведущего | web/packages/inbox/src/module.tsx (project, pairOf) | | |
| Метка you — число карточек (точка «есть новое» у раздела «Вам») | web/packages/inbox/contract.ts, web/packages/core/src/view/nav.tsx | | |
| Экран «Настройки» (пульт): вкладки «Выпуски», «Пропуска», «GitHub и устройство»; на телефоне только «Это устройство»; вкладки находятся поиском страницы | web/pult/modules/settings/src/module.tsx (SettingsScreen, find) | | |
| Приложение GitHub флота: создание (организация, «Создать приложение GitHub» — уход на GitHub с манифестом), «Сохранить приложение» по коду с возврата, «Доступ на GitHub ↗» | web/pult/modules/settings/src/general.tsx (Github → github.app, github.setup) | | |
| «Это устройство»: адрес, пропуск (кнопка «Пропуска»), состояние уведомлений | web/pult/modules/settings/src/general.tsx (Device → keys.list, alerts.state) | | |
| prefs.changed: после prefs.set в области global каждая машина получает кадр и перечитывает ключ | ветка blocks-ch: workers/prefs/src/index.ts (announce), workers/prefs/contract.ts (PrefsChanged) | | |
| Настройки флота доступны инструментами MCP prefs.get и prefs.set (область global, prefix) | ветка blocks-ch: workers/prefs/module.json (tools) | | |
| Вкладка «Правила модели» в настройках: список правил с переключателем вкл/выкл, «↑» и «↓» порядок, «Изменить»/«Свернуть», «Удалить», «＋ правило» | ветка blocks-ch: web/pult/modules/settings/src/proxyrules.tsx (ProxyRulesTab) | | |
| Редактор правила: имя, где (system, user, assistant, tool_result — чипы), текст или регулярка, что править (совпадение, строка, абзац, весь блок), заменить или удалить, что искать, чем заменить; ошибка регулярки словами | ветка blocks-ch: web/pult/modules/settings/src/proxyrules.tsx (Editor, flawOf) | | |
| «Сохранить» — один раз весь набор в proxy.rules области флота; не владелец — «Правила модели меняет владелец флота»; кнопка заблокирована без правок или с ошибкой; тост «прокси машин перечитают» | ветка blocks-ch: web/pult/modules/settings/src/proxyrules.tsx (save) | | |
| Проверка правил на своём тексте или на вызове модели из архива: чипы роли, исходный текст с «Копировать», «Свой текст», «← сессия» (назад в историю), метки срабатываний «имя · n» или «ни одно правило не сработало», разница построчно с контекстом | ветка blocks-ch: web/pult/modules/settings/src/proxyrules.tsx (Tester, readCall), settings/src/diff.ts (diffLines) | | |
| Вызов из архива открывается параметром call=sid/uuid: system вызова и записи разговора до него (points.history) | ветка blocks-ch: web/pult/modules/settings/src/module.tsx (params.call), proxyrules.tsx | | |
| Ключ флота по fleetkeys.changed обновляется на машине, где есть сессии на нём; значения в памяти | ветка blocks-ch: host/modules/logins/src/logins.ts (refreshKey, on frame) | | |
| Сервер инцидентов: port 0 — порт выбирает ОС, настоящий в строке журнала incident_listen | ветка blocks-ch: host/modules/incidents/src/incidents.ts | | |

## Прокси модели

| функция | где в старой | в новой | проверено |
|---|---|---|---|
| Каждый запрос claude к модели идёт через локальный прокси машины на 127.0.0.1; в окружение сессии кладётся ANTHROPIC_BASE_URL (получает: агент-сессия) | ветка blocks-ch: host/modules/proxy/src/proxy.ts (session env ANTHROPIC_BASE_URL) | | |
| Порт прокси свой и тот же после перезапуска Host, живые процессы claude остаются на прежнем адресе | ветка blocks-ch: host/modules/proxy/src/proxy.ts (start, раздел машины {port}) | | |
| Сессия определяется по заголовку x-claude-code-session-id; чужой процесс — 403 unknown_session, route не ответил — 529 со словом, claude повторяет сам | ветка blocks-ch: host/modules/proxy/src/proxy.ts (serve, routeOf) | | |
| Куда идёт вызов, решается на каждом запросе: слот-аккаунт — Anthropic со входом claude как есть, слот-ключ флота — адрес провайдера и значение ключа (слот может смениться между вызовами) | ветка blocks-ch: host/modules/logins/src/logins.ts (запрос route {sid}), host/modules/proxy/src/proxy.ts | | |
| Ключ флота у сессии — слово fleet в ANTHROPIC_API_KEY; прокси подставляет настоящий ключ в x-api-key и Authorization; значение ключа только в памяти logins, не в файле и не в окружении | ветка blocks-ch: host/modules/logins/src/logins.ts (route, values, KEY_WORD), host/modules/proxy/src/proxy.ts (headersOf) | | |
| Настройки ключа флота (env, settings) хранятся в записи сессии: подъём без связи читает их оттуда; ключа во флоте нет — значение забыто, сессия без него | ветка blocks-ch: host/modules/logins/src/logins.ts (Seat.config, refreshKey) | | |
| Правила замены текста запроса к модели: набор лежит в prefs, область флота, ключ proxy.rules; читается на первом вызове и по кадру prefs.changed; не прочитан — 529 rules_unavailable, тело без правил к провайдеру не уходит | ветка blocks-ch: host/modules/proxy/src/proxy.ts (loadRules), tools/rules/contract.ts | | |
| Правило: где искать (system, user, assistant, tool_result), для каких моделей (шаблоны со звёздочкой, пусто — все), текст или регулярка RE2, с учётом или без учёта регистра | ветка blocks-ch: tools/rules/src/rules.ts (Rule, compile) | | |
| Правило: что править — совпадение, строка, абзац или весь блок; как — заменить или удалить; в замене группы $1, ${имя}, $$ | ветка blocks-ch: tools/rules/src/rules.ts (unit, action, expand) | | |
| Правила идут по порядку, каждое к выходу предыдущего; выключенные (on:false) и неверные не применяются, неверное правило — строка журнала bad_rule; срабатывания считаются по имени | ветка blocks-ch: tools/rules/src/rules.ts (compile, Hits), host/modules/proxy/src/proxy.ts | | |
| Правила правят только тексты Messages API: system (строка, блоки, system-сообщения), тексты сообщений по роли, ответы инструментов; прочее не трогается; тело не JSON — 400 bad_json | ветка blocks-ch: tools/rules/src/rules.ts (editRequest), host/modules/proxy/src/proxy.ts | | |
| Для Anthropic и совместимых провайдеров тело после правил, статус, заголовки и поток байтов идут к claude как есть, со сжатием провайдера; заголовки соединения вычищаются | ветка blocks-ch: host/modules/proxy/src/proxy.ts (forward), host/modules/proxy/src/upstream.ts | | |
| Тишина провайдера дольше 600 с — запрос оборван словами; своих повторов нет, повторяет claude | ветка blocks-ch: host/modules/proxy/src/upstream.ts (IDLE_MS) | | |
| Провайдер Meta (хост meta.ai): перевод запроса Anthropic Messages в Responses — сообщения, изображения, документы (PDF, текст), результаты поиска, инструменты, tool_choice словами в instructions, формат ответа, ключ кэша, id сессии | ветка blocks-ch: host/modules/proxy/src/muse/request.ts (toMetaRequest), muse/handle.ts | | |
| Рассуждение Meta ездит через клиента в подписи блока thinking (meta1.…) и возвращается в следующем запросе; чужие подписи и незаконченное рассуждение отбрасываются | ветка blocks-ch: host/modules/proxy/src/muse/request.ts (encodeSignature), muse/stream.ts | | |
| Уровень усилия (effort) из budget thinking и из запроса; thinking входит в max_tokens | ветка blocks-ch: host/modules/proxy/src/muse/request.ts (effortFromBudget, normalizeEffort) | | |
| Инструменты Anthropic без пары у Meta (bash, редактор, code_execution, web_fetch, computer, memory) не идут, список — строкой журнала gap; отложенные инструменты ToolSearch идут обычными после загрузки | ветка blocks-ch: host/modules/proxy/src/muse/request.ts (convertTools, loadedToolNames), muse/handle.ts | | |
| Ответ Meta (Responses SSE) переводится в поток Anthropic: рассуждение — thinking, сообщение — text, вызов функции — tool_use, usage и stop_reason; не-потоковый запрос получает собранное сообщение; ping каждые 10 с | ветка blocks-ch: host/modules/proxy/src/muse/stream.ts (StreamTranslator, MessageReducer), muse/handle.ts | | |
| Стоп-строки клиента (stop_sequences) работают: хвост, который может стать стоп-строкой, придерживается; на стоп поток обрывается | ветка blocks-ch: host/modules/proxy/src/muse/stream.ts (stopSequence), muse/handle.ts | | |
| Веб-поиск инструмента web_search Anthropic через поиск самого Muse CLI: прокси ведёт раунды (до 8), клиенту отдаёт server_tool_use и web_search_tool_result; max_uses, allowed/blocked domains, до 10 результатов; результаты прошлых поисков возвращаются модели из истории | ветка blocks-ch: host/modules/proxy/src/muse/search.ts, muse/handle.ts (MAX_SEARCH_ROUNDS) | | |
| count_tokens для Meta — оценка (счёта у Meta нет) | ветка blocks-ch: host/modules/proxy/src/muse/handle.ts (countTokens, estimateTokens) | | |
| Ошибки Meta переводятся в конверт Anthropic: «prompt is too long» (claude сжимает разговор), 400/401/403/404/413/429/529/5xx; retry-after передаётся | ветка blocks-ch: host/modules/proxy/src/muse/handle.ts (mapUpstreamError) | | |
| Квота Meta (429 с resets_at) приходит заголовками лимита Anthropic (unified status, claim five_hour или seven_day, reset): claude пишет «лимит сессии, сброс в …» | ветка blocks-ch: host/modules/proxy/src/muse/handle.ts (quotaHeaders) | | |
| Заголовки к Meta как у Muse CLI в его порядке; версия Muse — один запрос к публичному каналу muse-stable при старте, не ответил — спросит на следующем вызове Meta | ветка blocks-ch: host/modules/proxy/src/muse/headers.ts (museVersion, responsesHeaders, apiHeaders), proxy.ts (muse) | | |
| К Meta поддержан только /v1/messages и count_tokens; другие пути — 404 not_supported | ветка blocks-ch: host/modules/proxy/src/proxy.ts (serve) | | |
| Проверка ключа флота (кнопка в «Аккаунтах»): разовый claude через прокси на этом ключе, ответ — модель и время или причина словами; значение ключа не попадает в аргументы и окружение; перенесено из logins в proxy | ветка blocks-ch: host/modules/proxy/src/proxy.ts (machine.key_check), web/pult/modules/accounts/module.json (machine.key_check@host-proxy) | | |
| Остановка прокси: новых не принимает, идущим 5 с, потом обрыв; отказы — в журнал Host (ev proxy) | ветка blocks-ch: host/modules/proxy/src/proxy.ts (stop) | | |
| Переписку прокси не пишет — её пишет сам claude в файл сессии | ветка blocks-ch: host/modules/proxy/contract.ts | | |

## MCP и внешний вход

| функция | где в старой | в новой | проверено |
|---|---|---|---|
| Хост передаёт сессии сервер MCP fleet, keys, parts, shell через createSdkMcpServer | host/core (QueryPart.mcpServers) | | |
| Публичный сервер MCP флота по Streamable HTTP на <mcp>/mcp с Bearer-пропуском gate: initialize, ping, tools/list, tools/call, пакетные запросы, версии протокола 2025-06-18, 2025-03-26, 2024-11-05, тело до 1 МБ, CORS | ветка blocks-ch: workers/mcp/src/index.ts, workers/mcp/contract.ts | | |
| Инструменты MCP — запросы Worker-модулей с полем tools в манифесте; имя — запрос с _ вместо точки; список из releases.tools, новый модуль с инструментом появляется без правки mcp; tools/call — POST владельцу с пропуском клиента, отказ владельца — isError | ветка blocks-ch: workers/mcp/src/index.ts, workers/releases/src/tools.ts (releases.tools), tools/manifest-gate/src/check.ts (tools) | | |
| Схема входа инструмента строится при упаковке модуля из типа запроса в contract.ts (описание поля — его комментарий) | ветка blocks-ch: tools/release-cli/src/schema.ts (inputSchema), tools/release/src/folder.ts (packModule schema) | | |
| Инструменты, выставленные наружу: fleetkeys.list, fleetkeys.set (значение ключа не принимает), keys.invite (без challenge, client, back), keys.list, keys.revoke, points.list, points.history, prefs.get, prefs.set | ветка blocks-ch: workers/fleetkeys, gate, relay, points, prefs: module.json (tools) | | |
| Неживой пропуск — 401 с WWW-Authenticate resource_metadata; метаданные ресурса по RFC 9728 на /.well-known/oauth-protected-resource | ветка blocks-ch: workers/mcp/src/index.ts (unauthorized, resourceMeta) | | |
| Сессия Claude получает сервер switchboard в mcpServers (HTTP с пропуском сессии): инструменты флота прямо в разговоре (агент-сессия) | ветка blocks-ch: host/modules/fleet/src/fleet.ts (switchboard) | | |
| Пропуск сессии выдаётся один раз (keys.invite с адресом сессии и gate.redeem), лежит в разделе сессии; ведомому нет; не выдался за 5 с — сессия идёт без сервера; убрали сессию — пропуск отозван | ветка blocks-ch: host/modules/fleet/src/fleet.ts (passOf, revoke), host/core/src/session.ts (on.remove) | | |
| Модуль host-keys (инструменты MCP keys: invite, list, revoke у каждой сессии) убран, его место занял сервер switchboard; подсказка сессии про привязку чата называет keys_invite с адресом telegram~почта | ветка blocks-ch: host/modules/keys (удалён), host/modules/fleet/src/prompt.ts | | |
| Ядро Host даёт модулю адрес Worker-модуля по uses (host.worker) | ветка blocks-ch: host/core/contract.ts, host/core/src/kernel.ts (worker) | | |
| Вход OAuth для внешних клиентов (claude.ai, Claude Code): метаданные сервера /.well-known/oauth-authorization-server, POST /token (authorization_code, PKCE S256, client_id — адрес описания клиента), access_token — пропуск устройства; authorization_endpoint — страница согласия пульта | ветка blocks-ch: workers/gate/src/oauth.ts, workers/gate/src/passes.ts (redeem) | | |
| Описание клиента по адресу: адрес возврата сверяется с redirect_uris, loopback с любым портом; слово bad_client | ветка blocks-ch: workers/gate/src/passes.ts (invite, проверка back) | | |
| Экран согласия consent: клиент просит вход, имя устройства по умолчанию (code, claude, client) правится, метка «заменит прежний», «Разрешить» (отзыв прежнего пропуска с тем же адресом, приглашение с PKCE, возврат в клиент с code и state), «Отказать» (error=access_denied) | ветка blocks-ch: web/pult/modules/people/src/module.tsx (ConsentScreen, экран consent) | | |
| Страница открывается снаружи адресом ?open=экран с параметрами query (точка authorize сохраняет свой query) | ветка blocks-ch: web/packages/core/src/route.ts | | |

## Страница: экраны и действия

| функция | где в старой | в новой | проверено |
|---|---|---|---|
| (вход) Открыть ссылку-приглашение с #invite=: приглашение принимается у gate, пропуск сохраняется на устройстве, ссылка из адреса убирается, показывается «Ключ сохранён» | web/packages/core/src/pass.ts (enter), web/packages/core/src/view/stops.tsx (Stops) | | |
| (вход) Без пропуска — экран «Нужен пропуск флота» с подсказкой команды `keys.invite client <имя|phone> <почта>` | web/packages/core/src/view/stops.tsx (NoKey) | | |
| (вход) Вставить приглашение (номер.секрет или ссылку с #invite=) в поле и нажать «Принять приглашение»; неверный формат — отказ словом | web/packages/core/src/view/stops.tsx (NoKey), web/packages/core/src/pass.ts (paste) | | |
| (вход) Ссылка с другим приглашением при уже имеющемся пропуске — экран «Заменить пропуск этого устройства?» с кнопками «Заменить пропуск» и «Оставить текущий» | web/packages/core/src/view/stops.tsx (Replace), web/packages/core/src/pass.ts (replace) | | |
| (вход) На iPhone вне экрана «Домой» приглашение не принимается: экран «Добавьте Switchboard на экран Домой» с шагами установки, приглашение ждёт в адресе | web/packages/core/src/view/stops.tsx (Install), web/packages/core/src/pass.ts (enter) | | |
| (вход) Отказ приглашения словом: «Приглашение не принято» (уже принято, отозвано, ошибка) с кнопкой «Стереть данные приложения» | web/packages/core/src/view/stops.tsx (Stopped) | | |
| (вход) gate не ответил при приёме приглашения — экран «Нет связи с gate» с кнопками «Повторить» и «Стереть данные», приглашение не теряется | web/packages/core/src/view/stops.tsx (Stopped, UNREACHED) | | |
| (вход) Пропуск отозван или не принят — экран «Пропуск отозван / не принят» с номером пропуска, командой выдачи нового и кнопкой «Стереть данные приложения» | web/packages/core/src/view/stops.tsx (Refused) | | |
| (вход) «Стереть данные приложения» очищает хранилище страницы и перезагружает её | web/packages/core/src/pass.ts (wipe), web/packages/core/src/view/stops.tsx (Wipe) | | |
| (вход) Экран подключения: логотип, номер пропуска, «подключаюсь · hello» | web/packages/core/src/view/stops.tsx (Stops) | | |
| (вход) Экран «Приложение устарело» (contract_mismatch) с кнопкой «Перезагрузить» | web/packages/core/src/view/stops.tsx (Stopped) | | |
| (вход) Экран «Связь остановлена» с причиной закрытия relay и кнопкой «Перезагрузить» | web/packages/core/src/view/stops.tsx (Stopped) | | |
| (вход) Экран «Браузер устарел» (нет поддержки @scope) | web/packages/core/src/view/stops.tsx (Stopped, word browser) | | |
| (вход) Экран «Приложение не стартует» со списком ошибок гейта набора модулей | web/packages/core/src/view/stops.tsx (Stopped, word gate) | | |
| (каркас) Лампа связи (на связи / подключаюсь / нет связи) в шапке и в колонке пульта | web/packages/core/src/view/bar.tsx (ConnPill) | | |
| (каркас) Полоса «Нет связи с relay · данные на ЧЧ:ММ · снова через N с» с кнопкой «Сейчас» (переподключиться сразу) | web/packages/core/src/view/bar.tsx (Off) | | |
| (каркас) Шапка экрана: логотип или кнопка «Назад», лампа состояния, заголовок и подзаголовок, плашка состояния | web/packages/core/src/view/bar.tsx (Bar) | | |
| (каркас) Кнопка «Найти» и кнопка действия раздела («+» новой сессии) в шапке на телефоне | web/packages/core/src/view/bar.tsx (Bar) | | |
| (каркас) Нижние вкладки разделов на телефоне с точкой «есть новое» у раздела; разделы одной группы — одна вкладка и лента соседей над экраном | web/packages/core/src/view/nav.tsx (Tabs, Ribbon, Count) | | |
| (каркас) Колонка разделов пульта: логотип с лампой связи, кнопка «Перейти…», разделы со значками и группами, точка «есть новое» | web/packages/core/src/view/nav.tsx (Column, Section) | | |
| (каркас) Поиск «Перейти» (Ctrl K / Cmd K, в русской раскладке тоже): разделы и строки, что отдают экраны (сессии по имени, адресу, папке, проекту), Enter открывает первый, Esc закрывает, не более 40 строк | web/packages/core/src/view/search.tsx (Search, Box, useHits), web/packages/board/src/state.ts (find) | | |
| (каркас) Тост (всплывающее сообщение) об ошибке или итоге действия | web/packages/core/src/view/shell.tsx (Toast) | | |
| (каркас) Широкий вид пульта: список слева, экран сессии/вопроса/чата справа (master-detail); на телефоне — отдельные экраны | web/packages/core/src/view/shell.tsx (Screens), web/packages/core/src/route.ts (masterOf), web/pult/src/options.ts | | |
| (каркас) Адрес страницы — источник правды: экран и параметры после #, кнопка «Назад» и браузерная история | web/packages/core/src/route.ts | | |
| (каркас) Модуль, упавший при отрисовке, выключается: на его месте «Экран выключен» с причиной и кнопкой «Перезапустить приложение», остальные экраны работают | web/packages/core/src/view/place.tsx (Place, Boundary) | | |
| (каркас) Полоса модулей над экранами разделов (top) — место уведомлений | web/packages/core/src/view/shell.tsx (Top) | | |
| (каркас) Тёмная и светлая тема по настройке системы (переключателя нет) | web/packages/ui/src/ui.css (prefers-color-scheme) | | |
| (каркас) Страница устанавливается как приложение (PWA): манифест, значки 192 и 512 (в т.ч. maskable), standalone, apple-touch-icon, тема #2747c9 | web/phone/public/manifest.webmanifest, web/phone/public/index.html | | |
| (каркас) Разделы телефона: «Вам», «Работа», аккаунты, профили, инциденты, настройки; разделы пульта: «Вам», «Работа», инциденты, аккаунты, профили, журнал, точки, настройки (экраны последних — в web/pult/modules, вне описи) | web/phone/src/options.ts, web/pult/src/options.ts | | |
| (каркас) Сборка читается из build.json (адреса relay и Worker'ов, модули); сбой загрузки — текст причины на странице | web/shell.ts (boot), web/list.ts | | |
| (общие компоненты) Подтверждение на месте без окна («что случится» + красная кнопка + «Отмена») | web/packages/ui/src/parts.tsx (Confirm) | | |
| (общие компоненты) Поле с фиксацией: Enter и уход фиксируют, Esc возвращает прежнее | web/packages/ui/src/parts.tsx (CommitIn) | | |
| (общие компоненты) Строка лимита: доля, полоса с порогами и срок («N % · до ЧЧ:ММ») | web/packages/ui/src/parts.tsx (LimitRow, Meter) | | |
| (общие компоненты) Выбор слота чипами с ожиданием сброса | web/packages/ui/src/parts.tsx (SlotPick), web/packages/ui/src/time.ts (slotWaitText) | | |
| (общие компоненты) «Один из многих»: выбранный и ближние кнопками, остальные списком «ещё N…» | web/packages/ui/src/parts.tsx (PickOne) | | |
| (общие компоненты) Слова состояний сессии (работает, ждёт вас, свободна, запускается, останавливается, остановлена, не запустилась) и цвета ламп | web/packages/ui/src/labels.ts (stateLabel), web/packages/ui/src/sessions.ts (lamp) | | |
| (общие компоненты) Жест перетаскивания: мышь с порога, палец с удержания 300 мс, Esc отменяет, автопрокрутка у края, клик после жеста гасится | web/packages/ui/src/press.ts (track, edgeScroll, holdTouch) | | |
| (общие компоненты) Итоги действий строкой (ok / bad / wait) и слова отказов связи («нет связи», «нет ответа», «не на связи») | web/packages/ui/src/parts.tsx (Outcome), web/packages/ui/src/labels.ts (linkText) | | |
| (общие компоненты) Время: «ЧЧ:ММ», «ago», «до …», длительности, склонения; полуночь для журнала | web/packages/ui/src/time.ts | | |
| Пульт — широкий вид, разделы по порядку: входящие, работа (board), инциденты, аккаунты, профили, журнал, точки, настройки | web/pult/src/options.ts (PULT.sections, wide, brand) | | |
| Экран сессии (card, chat, ask, open) открывается справа от списка входящих, работы или инцидентов | web/pult/src/options.ts (PULT.beside) | | |
| Устанавливаемое приложение (PWA): имя «Пульт», иконки, цвет темы, режим standalone | web/pult/public/manifest.webmanifest, index.html | | |
| Раздел «Аккаунты» с двумя вкладками «Аккаунты» и «Ключи флота»; вкладка берётся из адреса #accounts?tab= и запоминается | web/pult/modules/accounts/src/screen.tsx (AccountsScreen, Tabs, state.seen.tab) | | |
| Экран «Сессии» (раздел «Флот», #points): список архива; строка — точка статуса «идёт на машине» или «только в архиве», заголовок, callsign, проект, модель, токены вход → выход, время (сегодня — часы, раньше — день); клик открывает страницу сессии | ветка blocks-ch: web/pult/modules/points/src/List.tsx (SessionRow) | | |
| Фильтры списка: проект (чипы «все проекты», если проектов больше одного), период «сегодня», «неделя», «всё время» (по умолчанию неделя), порядок «последние» и «токены» (скрыт при поиске) | ветка blocks-ch: web/pult/modules/points/src/List.tsx (Picks, PERIODS, ORDERS) | | |
| Поиск по переписке: поле в шапке (только если хранилище умеет), «Найти» и «Сбросить»; результаты группами сессий с отрывком и временем; клик — страница на этой записи, найденные слова подсвечены | ветка blocks-ch: web/pult/modules/points/src/List.tsx (Hits, mark), web/packages/chat/src/view/Archive.tsx (useHighlight) | | |
| «Пожар»: баннер «машина не на связи с … · N сессий ждут на последних точках» и «Перенести на другую машину…»; окно: куда (машины), слот, проверка папки у каждой сессии, «Перенести N из N на X», перенос по одной с итогом «готова — …» или «не поднялась: …», «не закрывайте страницу», закрыли — идущая доходит | ветка blocks-ch: web/pult/modules/points/src/windows.tsx (Fire, FireWindow, FireRow), store.ts (метка fire) | | |
| Страница сессии: «← Сессии», заголовок, callsign ссылкой в карточку живой, проект, модель, токены, метка «идёт» или «в архиве» | ветка blocks-ch: web/pult/modules/points/src/Session.tsx (Head, SessionPage) | | |
| Разговор архива — лента chat.view с теми же строками, что живая, только чтение, страницы по 200 записей с конца, «Раньше» | ветка blocks-ch: web/packages/chat/src/view/Archive.tsx (ArchiveScreen) | | |
| В ленте архива точки стоят на своих местах кнопками «№id · время»: клик выбирает точку (в адресе), разговор после неё приглушён; найденная запись в рамке и прокручена в центр | ветка blocks-ch: web/packages/chat/src/view/Archive.tsx (marks, sel, uuid, pick), Session.tsx | | |
| На телефоне вкладки «Разговор» и «Точки» (pane в адресе) | ветка blocks-ch: web/pult/modules/points/src/Session.tsx (PANES) | | |
| Линия точек по дням: время, причина (старт Host, конец хода, сохранена вручную, подъём, сессия ушла), №; ветка отмечена; выбранная точка раскрывается: причина, машина, число записей, состояние git, метка «последняя» или «ветка» | ветка blocks-ch: web/pult/modules/points/src/Session.tsx (Points, PointBody, WHY) | | |
| «Сохранить точку» у живой сессии: «Сохраняю точку…», «Точка №N» или «та же» | ветка blocks-ch: web/pult/modules/points/src/Session.tsx (save, points.save) | | |
| «Перенести на машину…» у живой сессии: окно — машина (переключатели), слот на машине, папка, проверка папки словами, «прервать идущий ответ»; шаги: точка со стопом, подъём, результат ссылкой на новую сессию; из свежей или выбранной точки | ветка blocks-ch: web/pult/modules/points/src/Dialog.tsx (kind move, useSteps), target.tsx | | |
| «Копия…»: имя копии (по умолчанию имя-copy), папка (имя-copy), машина, слот, точка без стопа; новая сессия встаёт в проект исходной | ветка blocks-ch: web/pult/modules/points/src/Dialog.tsx (kind copy), target.tsx (joinProject) | | |
| «Откатить сюда…» (не последняя точка): файлы «как сейчас» или «как в точке», «прервать идущий ответ», прежнее — веткой (и веткой git); предупреждение «Привязка к claude.ai снимется» | ветка blocks-ch: web/pult/modules/points/src/Dialog.tsx (kind rb, RollbackFiles, RemoteWarning) | | |
| «Сменить папку…» у живой сессии: копия в новой папке (имя-v2) и «Забыть» прежней; не поднялась — прежняя остаётся остановленной | ветка blocks-ch: web/pult/modules/points/src/Dialog.tsx (kind dir, forget) | | |
| «Поднять на машине…» у сессии только в архиве: машина, слот, папка, проверка, «Поднять на X» | ветка blocks-ch: web/pult/modules/points/src/windows.tsx (RaiseWindow) | | |
| Проверка папки подъёма словами: правки точки НЕ применятся (dirty), клон (empty), здесь же сессии (shared), нет git, другой репозиторий — кнопка заблокирована | ветка blocks-ch: web/pult/modules/points/src/words.ts (checkOf, blocked), target.tsx (useProbe) | | |
| «На свой компьютер»: команда switchboard pull с --point и «Копировать» | ветка blocks-ch: web/pult/modules/points/src/Session.tsx (Pull) | | |
| «Вызовы модели» у точки: время, модель, токены, «Правила» (открывает проверку правил на этом вызове), «ещё N» | ветка blocks-ch: web/pult/modules/points/src/Session.tsx (Calls, test-rules) | | |
| «Удалить из архива…» у сессии без живой копии: подтверждение вводом имени, «Удалить насовсем», блоки для копий остаются | ветка blocks-ch: web/pult/modules/points/src/windows.tsx (DeleteWindow), Session.tsx (remove) | | |
| Итог действия строкой со ссылкой на новую сессию в карточку; Escape закрывает окно; открыта одна форма за раз | ветка blocks-ch: web/pult/modules/points/src/Session.tsx (DoneNote, Open) | | |
| Вкладка «Архив» в карточке сессии: «Хранить в архиве» (галочка; снятие — подтверждение вводом имени, «точки удалятся сразу, без отмены»), сообщение о неудачной последней точке, линия точек и вызовы внутри карточки | ветка blocks-ch: web/pult/modules/points/src/Session.tsx (CardTab, Unmark), module.tsx (session.points, card.tab) | | |
| При открытии сессии переключатель «Хранить в архиве» (бывшее «Точки в R2»), отказ — тост «архив не включился» | ветка blocks-ch: web/pult/modules/open/src/screen.tsx | | |
| Метка fire (машины с сессиями в архиве, которых нет в roster); каталог архива читается один раз при первом roster | ветка blocks-ch: web/pult/modules/points/src/store.ts (fire, onRoster) | | |
| Экран «Сессии» без прежних Overview и Tab (обзор с объёмом хранилища, вкладки) — заменены списком и страницей сессии | ветка blocks-ch: web/pult/modules/points/src/module.tsx (Overview.tsx, Tab.tsx удалены) | | |
| Слова отказов экранов точек: waiting, bad_dir, bad_point, not_owner, open_failed, not_archived, no_search, running, name_taken, slot_required, no_slot, not_logged_in, offline | ветка blocks-ch: web/pult/modules/points/src/words.ts (refused) | | |

## Keeper

| функция | где в старой | в новой | проверено |
|---|---|---|---|
| Служба ОС машины (Windows — служба под пользователем или задача планировщика при входе --logon; Linux — служба) | os/keeper (service_windows.go, service_linux.go) | | |
| Установка машины: keeper install, приглашение первой строкой stdin (пароль службы Windows — второй), --worker имя=адрес, --name второй флот, --logon | os/keeper/setup.go | | |
| Удалить службу: keeper uninstall | os/keeper/main.go | | |
| keeper run [--hide], keeper version, keeper hold (держатель процесса) | os/keeper/main.go | | |
| Исполнять план машины от «Выпусков»: скачать архив версии, сверить sha256, распаковать, setup, поднять часть через держатель | os/keeper/fetch.go, parts.go, keeper.go | | |
| Один актор исполняет планы по rev; без связи исполняет сохранённый plan.json | os/keeper/keeper.go | | |
| Падение части: один перезапуск с диска, второе — failed; failed снимает правка записи или перезапуск keeper | os/keeper/parts.go | | |
| Включить/выключить часть (on), закрепить версию (pin), env части, убить дерево (force), убрать часть (data/ остаётся) | os/keeper (план, parts.go, tree_*.go) | | |
| Подмена себя последним шагом плана: новый файл ответил версией — выход, ОС поднимает новый; держатели живут | os/keeper/self.go | | |
| Состояние машины по запросу keeper.state: части, версии, состояние, причины, ОС, rev | os/keeper/link.go (keeper.state) | | |
| Соединение с relay машины: hello, ping, переподключение с паузой вдвое до минуты | os/keeper/link.go | | |
| Держатель процесса: свой порт, ключ, хозяин подключается, закрыть ввод, убить дерево, выход словами | os/keeper/hold.go, owner.go | | |
| Журнал keeper и держателей в один файл дня | os/keeper/journal.go | | |
| Папка машины ~/.switchboard (SWITCHBOARD_HOME) или ~/.switchboard-<имя>: machine.key, keeper.json, journal, parts | os/keeper/main.go, journal.go | | |
| Запись о машине в журнал флота при выходе из плана | os/keeper (ledger.add) | | |

## Инструменты и скрипты разработчика

| функция | где в старой | в новой | проверено |
|---|---|---|---|
| switchboard release core / keeper / modules [--out --dry-run] / check — упаковка и загрузка в каталог, проверка «чей номер поднять» | tools/release-cli/cli.ts | | |
| Гейт манифестов (npm run gate): модуль, имена, владельцы, uses, импорты мимо контракта | tools/manifest-gate (check, checkSet, order, ownerOf, loadRepo) | | |
| Формат выпуска: архив, sha256, ссылки, раскладка сборки страницы (BuildList) | tools/release | | |
| tools/send: сообщение в сессию от служб компьютера (пропуск программы первой строкой stdin, `node send.mjs <callsign> [--url]`; коды выхода 0/1/2) | tools/send/send.mjs | | |
| tools/demolish: size, lost, shots-pair, dom-diff, mutate — мера и сверка при сносе | tools/demolish/cli.ts | | |
| Выкладка Worker-модулей: deploy-workers.mjs [имена] [--env prod], --upload (CI), секреты через stdin | scripts/deploy-workers.mjs | | |
| scripts/fleet.ts: state, deploy, set, sessions save/check, page (проверка страниц в Chromium) | scripts/fleet.ts | | |
| Живые флоу и эталоны выложенного флота (flow-*.ts, live-etalons.ts, smoke-relay.ts) | scripts/flow-*.ts, live-etalons.ts, smoke-relay.ts | | |
| Снимки экранов настоящего кода: npm run shots, SHOTS_DOM; жесты мышью и пальцем: npm run drag | scripts/shots/ | | |
| Сервер дизайна и разработки фронта: npm run front test|prod (--app pult,phone --port), прототип с моком, метки и комментарии, пропуска design-<имя> | scripts/design/serve.mjs, pass.mjs | | |
| Клиент флота для сценариев: scripts/client.ts, fleets.ts | scripts/client.ts, fleets.ts | | |
| Тесты: npm test (гейт и vitest), test:workers, typecheck, стенды Host (поддельные SDK, relay, keeper, часы) | package.json; scripts/test-packages.mjs; host/core/stand | | |
| Стенды Go keeper и CI (.github/workflows/ci.yml) | os/keeper/*_test.go; .github/workflows/ci.yml | | |
| Клиенты relay для кода: link (hello, запросы с id, ping, переподключение) и fleet (relay каждой машины и POST к Worker'ам) | workers/relay/contract.ts | | |
| Общий конверт кадра: type, id, reply, пределы кадра и вызова, слова отказов | protocol/ | | |
| Манифест: поле implements (модуль-контракт, одна реализация во флоте) и tools (инструменты MCP), гейт проверяет их | ветка blocks-ch: tools/manifest-gate/src/check.ts (implemented, tooled) | | |
| release check сверяет модули и ядро с каталогом параллельно | ветка blocks-ch: tools/release-cli/cli.ts (check) | | |
