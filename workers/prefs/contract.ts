// Контракт prefs: настройки пользователя — то, что человек задаёт себе сам и что общее для его устройств.
// Служебного здесь нет: пропуска — у gate, подписки на пуши — у push. Пользователь — из адреса отправителя (userOf),
// адрес ставит вход Worker'а после gate.verify; списка пользователей prefs не знает: строка появляется при первой записи.
// Запросы — кадры с to: ".prefs", прямым POST с пропуском; relay не участвует.

export const CONTRACT = { "prefs.get": 1, "prefs.set": 1 } as const;

/** prefs.get — все ключи пользователя. Ключа нет — его нет и в ответе. */
export type PrefsGet = { type: "prefs.get"; id: string; v?: 1; to: ".prefs" };
export type PrefsGetResult = { values: Record<string, unknown> };

/** prefs.set — один ключ целиком; побеждает последняя запись. Ответ: ok без result. Имя ключа — name: поле key кадра занято пропуском. */
export type PrefsSet = { type: "prefs.set"; id: string; v?: 1; to: ".prefs"; name: string; value: unknown };

/** Слова отказа prefs (кроме общих unknown_request, contract_mismatch): bad_frame — нет name или value; not_user — отправитель не человек. */
export type PrefsWord = "bad_frame" | "not_user";
