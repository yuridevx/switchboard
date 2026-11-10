// Слова документа сессии на языке Claude: режим разрешений и флаги настроек.
export const MODES: Record<string, string> = { all: "bypassPermissions", ask: "default", plan: "plan", edits: "acceptEdits", auto: "auto" };
/** Ключ документа → настройка Claude: вступает в силу сразу у живой сессии и стоит в опциях запуска. */
export const FLAGS = { effort: "effortLevel", fast: "fastMode", style: "outputStyle", thinking: "alwaysThinkingEnabled" } as const;
