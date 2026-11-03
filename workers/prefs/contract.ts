// Контракт prefs: настройки людей и страниц в трёх областях. Без scope — человек: общее для его устройств; global — весь флот; app:<приложение> — все люди одного приложения.
// Значений служба не читает: новая настройка страницы её не меняет.
// Служебного здесь нет: пропуска — у gate, подписки на пуши — у push. Пользователь — из адреса отправителя (userOf),
// адрес ставит вход Worker'а после gate.verify; списка пользователей prefs не знает: строка появляется при первой записи.
// Запросы — кадры с to: ".prefs", прямым POST с пропуском; relay не участвует.

export const CONTRACT = { "prefs.get": 1, "prefs.set": 1 } as const;

/** prefs.get — все ключи пользователя. Ключа нет — его нет и в ответе. */
export type PrefsGet = { type: "prefs.get"; id: string; v?: 1; to: ".prefs"; scope?: PrefsScope };
/** Область: ключа нет — почта отправителя; любое другое значение, чем global и app:<приложение>, — bad_frame. */
export type PrefsScope = "global" | `app:${string}`;
export type PrefsGetResult = { values: Record<string, unknown> };

/** prefs.set — один ключ целиком; побеждает последняя запись. Ответ: ok без result. Имя ключа — name: поле key кадра занято пропуском. */
export type PrefsSet = { type: "prefs.set"; id: string; v?: 1; to: ".prefs"; name: string; value: unknown; scope?: PrefsScope };

/** Слова отказа prefs (кроме общих unknown_request, contract_mismatch): bad_frame — нет name или value, неверная область; not_user — область человека у отправителя не человек; too_large — значение больше 2 МБ. */
export type PrefsWord = "bad_frame" | "not_user" | "too_large";
