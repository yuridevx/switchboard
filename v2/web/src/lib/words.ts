// Слова отказов флота — человеку. Одно место на всю страницу: вход, платформа, службы, Host, Keeper.
// Эталон сверяет словарь с кодом частей: слово, которое часть умеет сказать, обязано быть здесь.
export const SAY: Record<string, string> = {
  // вход и связь
  offline: "Машина не на связи", forbidden: "Нет права", timeout: "Нет ответа", bad_input: "Ввод не подходит", bad_frame: "Запрос не разобран", too_large: "Слишком большое сообщение",
  unknown_request: "Здесь это не обслуживается", module_failed: "Ошибка в модуле", not_found: "Не найдено", not_session: "Адресат — не сессия", shutting_down: "Часть останавливается", proto: "Приложение устарело",
  replaced: "Соединение заменено другим", hello_timeout: "Соединение не представилось", access: "Доступ изменился", error: "Ошибка", server_error: "Ошибка сервера",
  // пропуска, люди, вход внешних клиентов
  bad_key: "Пропуск не принят", revoked: "Пропуск отозван", bad_invite: "Приглашение не принято", exists: "Такой человек уже во флоте", name_taken: "Имя занято",
  bad_client: "Клиент не опознан", invalid_grant: "Код входа не принят", invalid_request: "Запрос входа не разобран", unsupported_grant_type: "Такой вход не поддерживается", bad_token: "Токен не принят",
  not_client: "Ответить может только человек", permission_denied: "Отказано в разрешении",
  // сессии
  already_answered: "На вопрос уже ответили", unknown_question: "Такого вопроса нет", unknown_session: "Такой сессии нет", open_failed: "Сессия не открылась", bad_spec: "Документ сессии не подходит",
  bad_dir: "Папка не подходит", has_wing: "У сессии есть ведомый", pair_inside: "Сессия уже в паре", has_sessions: "На нём идут сессии", not_started: "Сессия не запущена", running: "Уже идёт",
  stopped: "Остановлено", sdk_error: "Ошибка Claude", waiting: "Сессия ждёт ответа", bad_attachment: "Вложение не подходит", not_text: "Нужен текст",
  // аккаунты и ключи
  no_account: "Нет годного аккаунта", no_accounts: "Аккаунтов нет", not_logged_in: "Вход не выполнен", login_failed: "Вход не удался", bad_code: "Код не подошёл", no_reserve: "Запасного аккаунта нет",
  account_dir_busy: "Папка аккаунта занята", slot_dir_busy: "Папка входа занята", refresh_locked: "Вход обновляется другим процессом", no_key: "Такого ключа нет", rate_limit: "Лимит исчерпан",
  upstream: "Провайдер модели отказал", muse_version: "Версия Muse не получена", rules_unavailable: "Правила прокси не прочитаны", bad_rule: "Правило не разобрано", check_failed: "Проверка не прошла",
  // профили, точки, архив
  no_profile: "Такого кусочка нет", bad_profile: "Кусочек не собирается", no_file: "Такого файла нет", missing: "В архиве этого нет", bad_point: "Точка не подходит", not_owner: "Это не ваша сессия",
  changed: "В архиве уже другое", blocks_missing: "Блоки точки не загружены", no_links: "Ссылки на блоки не получены", store_failed: "Хранилище не ответило", records_failed: "Записи не ответили",
  no_search: "Поиск недоступен", analytics_unavailable: "Аналитика недоступна",
  // скрипты, инциденты, машина
  no_shell: "Такой оболочки нет", no_run: "Такого запуска нет", unknown_kind: "Такого вида обращений нет",
  // связь с людьми, GitHub
  no_vapid: "Уведомления не настроены у флота", no_telegram: "Бот Telegram не подключён", no_topics: "В группе выключены темы", not_linked: "Чат не привязан",
  github_failed: "GitHub отказал", no_app: "Приложение GitHub не создано", app_exists: "Приложение GitHub уже есть", not_installed: "Приложение GitHub не установлено",
};

/** Слово отказа по-русски; незнакомое — как есть. */
export const sayWord = (word?: string): string => (word ? SAY[word] ?? word : "");
