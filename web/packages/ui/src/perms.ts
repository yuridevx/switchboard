// Подписи разрешений Claude: режимы и куда ложится правило. Одна таблица на чат, вопросы и панель.

/** Режимы разрешений SDK и их имена в интерфейсе. */
export const PERM_MODES: Array<[string, string]> = [
  ["bypassPermissions", "Без вопросов"],
  ["default", "Спрашивать"],
  ["acceptEdits", "Правки сами"],
  ["plan", "План"],
  ["auto", "Авто"],
];

export const permModeName = (mode: string): string | undefined => PERM_MODES.find(([v]) => v === mode)?.[1];

/** Откуда правило и куда ляжет. */
export const PERM_PLACES: Record<string, string> = { localSettings: "локально", projectSettings: "проект", userSettings: "пользователь", policySettings: "организация", flagSettings: "запуск", cliArg: "запуск", command: "команда", session: "сессия" };
