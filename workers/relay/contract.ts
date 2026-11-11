// Контракт relay: кадры рации, вход участников и клиенты link и fleet. Всё, что нужно другим модулям от relay, — только отсюда.
//
// Вход без состояния:
//   wss /m/<машина> — объект этой машины. Первый кадр — hello { key, proto } и поля своего Host { sdk, contract, sessions };
//     keeper входит пропуском своей машины и шлёт part: "keeper": адрес .keeper@машина, в roster его нет, roster — один, при входе.
//   POST / keys.revoke { key, kid } → { addr, closed }: отметка у gate, соединения номера закрыты на всех машинах.
//   привязка Relay.deliver(кадр с from) → сколько получателей: кадр Worker'а объекту машины адреса.
//   привязка Relay.broadcast(кадр с from) → сколько получателей: тот же кадр Host каждой машины флота (машины — gate.list), to: @машина.
// Кадры от relay:
//   roster — всем соединениям, кроме keeper, после каждого hello, session.state и ухода соединения.
// Кадр session.state { callsign, state, поля } — Host о своей сессии: запись заменяется целиком, state: null убирает её;
//   callsign только своей машины, иначе bad_from.
// Слова отказа: bad_frame, bad_from, offline, contract_mismatch, gate_unavailable; слово gate bad_key передаётся как есть.
// Закрытие соединения: 1008 и слово — отказ (bad_frame, bad_key, revoked, bad_from, contract_mismatch, gate_unavailable);
//   1000 replaced — вытеснил новый hello той же машины; 1012 relay_updated — выпуск relay, клиенты переподключаются.
export type { Frame, Reply } from "@switchboard/protocol";

/** keys.revoke — POST по адресу relay: kid — номер пропуска. Ответ — {addr, closed}. */
export type KeysRevoke = { type: "keys.revoke"; id: string; v?: 1; key?: string; kid: string };

/** Запись сессии в карточке Host: callsign и поля модулей Host — relay их не читает. */
export type SessionRecord = { callsign: string; state?: string | null; [field: string]: unknown };

export type RosterMachine = {
  machine: string;
  /** время hello машины, мс; новое since — новое соединение машины */
  since: number;
  proto: number;
  sdk?: string;
  contract?: Record<string, number>;
};

/**
 * roster объекта: machines и sessions — своя машина объекта; clients — гости: устройства и программы (адрес от gate)
 * и Host других машин (@машина) — по ним клиент находит машины, которых ещё не знает. Собран из карточек живых соединений.
 */
export type Roster = {
  type: "roster";
  machines: RosterMachine[];
  sessions: SessionRecord[];
  clients: string[];
};

/**
 * link(options) — клиент relay: hello, запросы с id и ожиданием reply, ping, переподключение.
 * PROTO — версия контракта relay, которую link шлёт в hello; relay принимает версии из своей настройки PROTO.
 * Пример (Host):
 *   const l = link({ url, key, hello: () => ({ sdk, contract, sessions }), onFrame, onState });
 *   const r = await l.request({ type: "message", to: "poe-bot@pc", text: "…" });
 *   // r: { type: "reply", id, ok: true, result } | { …, ok: false, error: "offline" | "disconnected" | … }
 *   l.send({ type: "reply", id: req.id, to: req.from, ok: true, result });  // ответ на чужой запрос
 */
export { link, PROTO } from "./src/link.ts";
export type { Link, LinkState, WsLike, WsCtor } from "./src/link.ts";

/**
 * fleet(options) — клиент флота: соединение с relay каждой машины (машины — keys.list у gate, новые — гостями в roster),
 * кадр к машине — в её соединение, к Worker'у — POST с пропуском по адресу из options.workers; адреса — одна карта
 * workers (relay — wss того же адреса, gate — список машин). relayWs(workers) — адрес объектов relay.
 *   const f = fleet({ workers, key, machine: "win", hello: () => ({ sdk, contract, sessions }), onFrame });
 *   await f.request({ type: "message", to: "site@wsl", text: "…" });   // через relay машины wsl
 *   await f.request({ type: "push.send", v: 1, to: ".push", … });     // POST к Worker'у push
 */
export { fleet, relayWs } from "./src/fleet-client.ts";
export type { FleetClient } from "./src/fleet-client.ts";
