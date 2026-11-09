// Провод страницы: мок флота или настоящий адрес. Код экранов один и тот же.
import { type Api, CallError, createApi, httpTransport, type InputOf, type OutputOf, redeem, type RequestDef } from "@sb/protocol";
import { notifications } from "@mantine/notifications";
import { createMock, type Mock } from "./mock/fleet.ts";

const q = new URLSearchParams(location.search);
export const fleetBase: string = q.get("fleet") ?? (import.meta.env.VITE_FLEET as string | undefined) ?? "";
export const isMock = !fleetBase;
const KEY = "sb2.key";

export const keyStore = {
  get: (): string => { try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; } },
  set: (k: string) => { try { localStorage.setItem(KEY, k); } catch { /* без хранилища пропуск живёт до перезагрузки */ } },
  clear: () => { try { localStorage.removeItem(KEY); } catch { /* нечего чистить */ } },
};

export let mock: Mock | null = null;
export let api: Api;

export function connect(): void {
  if (isMock) {
    mock = createMock({ live: q.get("still") === null });
    (window as any).__mock = mock;
    api = createApi(mock.transport);
  } else api = createApi(httpTransport({ base: fleetBase.replace(/\/$/, ""), key: keyStore.get() }));
}

/** Приглашение из адреса: #invite=… */
export const inviteInHash = (): string => /[#&]invite=([^&]+)/.exec(location.hash)?.[1] ?? "";

export async function acceptInvite(invite: string): Promise<void> {
  const r = await api.call(redeem, { invite: decodeURIComponent(invite) });
  keyStore.set(r.key);
  history.replaceState(null, "", location.pathname + location.search);
  connect();
}

/** Слова отказов — человеку. */
const SAY: Record<string, string> = {
  offline: "Машина не на связи", forbidden: "Нет права", timeout: "Нет ответа", bad_input: "Ввод не подходит", unknown_request: "Здесь это не обслуживается",
  not_found: "Не найдено", module_failed: "Ошибка в модуле", name_taken: "Имя занято", already_answered: "На вопрос уже ответили", bad_key: "Пропуск не принят",
  analytics_unavailable: "Аналитика недоступна", bad_code: "Код не подошёл",
};
export const sayError = (e: unknown): string => (e instanceof CallError ? `${SAY[e.word] ?? e.word}${e.why ? `: ${e.why}` : ""}` : e instanceof Error ? e.message : String(e));

/** Действие человека: запрос, отказ — тостом с причиной. */
export async function act<D extends RequestDef<any, any>>(def: D, input: InputOf<D>, done?: string): Promise<OutputOf<D> | undefined> {
  try {
    const r = await api.call(def, input);
    if (done) notifications.show({ message: done, color: "teal" });
    return r;
  } catch (e) {
    notifications.show({ title: "Не получилось", message: sayError(e), color: "red", autoClose: 7000 });
    return undefined;
  }
}
