// Провод страницы: мок флота или настоящий адрес. Код экранов один и тот же.
import { type Api, CallError, createApi, httpTransport, type InputOf, type OutputOf, redeem, type RequestDef } from "@sb/protocol";
import { notifications } from "@mantine/notifications";
import { kvSet } from "./lib/kv.ts";
import { sayWord } from "./lib/words.ts";
import { createMock, type Mock } from "./mock/fleet.ts";
import { useFleet } from "./store/fleet.ts";

const q = new URLSearchParams(location.search);
// Адрес флота: ?fleet=<адрес>; сборка для выкладки (VITE_FLEET=origin) берёт адрес самой страницы; ?mock — мок на любой сборке.
const built = import.meta.env.VITE_FLEET as string | undefined;
export const fleetBase: string = q.get("mock") !== null ? "" : (q.get("fleet") ?? (built === "origin" ? location.origin : built) ?? "");
export const isMock = !fleetBase;
const KEY = "sb2.key";

export const keyStore = {
  get: (): string => { try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; } },
  set: (k: string) => { try { localStorage.setItem(KEY, k); } catch { /* без хранилища пропуск живёт до перезагрузки */ } void mirror(k); },
  clear: () => { try { localStorage.removeItem(KEY); } catch { /* нечего чистить */ } void mirror(null); },
};

/** Копия пропуска и адреса флота для сервис-воркера: он отвечает на вопрос сессии прямо из уведомления. */
export const mirror = (k: string | null) => Promise.all([kvSet("key", k), kvSet("base", k && !isMock ? fleetBase.replace(/\/$/, "") : null)]);

export let mock: Mock | null = null;
export let api: Api;

/** Байты в хранилище по ссылке загрузки. */
export async function putBytes(url: string, body: Blob): Promise<void> {
  if (mock) return mock.put(url, body);
  const res = await fetch(url, { method: "PUT", body });
  if (!res.ok) throw new Error(`хранилище ответило ${res.status}`);
}

export function connect(): void {
  if (isMock) {
    mock = createMock({ live: q.get("still") === null });
    (window as any).__mock = mock;
    api = createApi(mock.transport);
  } else api = createApi(httpTransport({ base: fleetBase.replace(/\/$/, ""), key: keyStore.get() }));
}

/** Приглашение из адреса: #invite=… или ?invite=… (так его несёт приложение с экрана «Домой»: iPhone открывает его с адреса из манифеста). */
export const inviteInHash = (): string => {
  const found = /[#&]invite=([^&]+)/.exec(location.hash)?.[1] ?? /[?&]invite=([^&]+)/.exec(location.search)?.[1] ?? "";
  // приложение с экрана «Домой» каждый раз открывается с тем же адресом: уже принятое приглашение второй раз не предъявляется
  return found && decodeURIComponent(found) === usedInvite() ? "" : found;
};
const USED = "sb2.invite.used";
const usedInvite = (): string => { try { return localStorage.getItem(USED) ?? ""; } catch { return ""; } };
/** Приглашение из вставленного текста: само приглашение или ссылка с #invite=…; не оно — пусто. */
export function inviteFrom(text: string): string {
  const t = text.trim();
  const inLink = /[#&?]invite=([^&\s]+)/.exec(t)?.[1];
  const raw = inLink ? decodeURIComponent(inLink) : t;
  return /^[a-z0-9][a-z0-9_-]*:[a-z0-9]{6,32}:\S{16,}$/i.test(raw) ? raw : "";
}

export async function acceptInvite(invite: string): Promise<void> {
  const r = await api.call(redeem, { invite: decodeURIComponent(invite) });
  keyStore.set(r.key);
  try { localStorage.setItem(USED, decodeURIComponent(invite)); } catch { /* без хранилища приглашение предъявится ещё раз и получит отказ */ }
  const rest = new URLSearchParams(location.search);
  rest.delete("invite");
  history.replaceState(null, "", "/" + (rest.size ? "?" + rest : ""));
  connect();
}

/** Слова отказов — человеку: словарь один, в lib/words.ts. */
export { sayWord };
export const sayError = (e: unknown): string => (e instanceof CallError ? `${sayWord(e.word)}${e.why ? `: ${e.why}` : ""}` : e instanceof Error ? e.message : String(e));

/** Действие — запрос вне кэша чтений: отказ — красным тостом с запросом, адресатом и причиной; ответа тогда нет.
 *  Связи нет — об этом говорит полоса связи, одна на всё, а не каждый запрос. */
export async function act<D extends RequestDef<any, any>>(def: D, input: InputOf<D>, done?: string): Promise<OutputOf<D> | undefined> {
  try {
    const r = await api.call(def, input);
    if (done) notifications.show({ message: done, color: "teal" });
    return r;
  } catch (e) {
    const to = (input as { to?: unknown } | null)?.to;
    const offline = e instanceof CallError && e.word === "offline" && useFleet.getState().link !== "open";
    if (!offline) notifications.show({ title: `Не получилось: ${def.name}${typeof to === "string" ? ` · ${to}` : ""}`, message: sayError(e), color: "red", autoClose: 7000 });
    return undefined;
  }
}

/** Запросы, чей отказ человеку не нужен: отчёт о самой ошибке страницы и отписка от ленты при уходе с экрана. Список один. */
const QUIET = new Set(["obs.report", "session.unwatch"]);
export function quietly<D extends RequestDef<any, any>>(def: D, input: InputOf<D>): void {
  if (!QUIET.has(def.name)) throw new Error(`${def.name}: молчать об отказе этого запроса нельзя — act или чтение с кэшем`);
  api.call(def, input).catch(() => {});
}
