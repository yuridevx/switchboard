// Карточка соединения: кто вошёл по hello, его адрес и roster из карточек. Чистые функции: сокетов не знают, в журнал не пишут.
import { kindOf, machineOf } from "@switchboard/protocol";
import type { Frame } from "@switchboard/protocol";
import type { VerifyResult } from "@switchboard/gate";
import type { Roster, SessionRecord } from "../contract.ts";

type Common = { name: string; kid: string; since: number; proto: number };
export type HostCard = Common & { role: "host"; sdk?: string; contract?: Record<string, number>; sessions: SessionRecord[] };
/** Host другой машины в гостях: доставка ему — по адресам его машины; в roster — среди гостей @машина. */
export type GuestCard = Common & { role: "guest" };
/** устройство или программа: адрес — из ответа gate. */
export type ClientCard = Common & { role: "client"; addr: string };
/** часть машины (keeper): входит ключом своей машины с part в hello; в roster не входит, адрес .keeper@машина. */
export type KeeperCard = Common & { role: "keeper" };
export type Card = HostCard | GuestCard | ClientCard | KeeperCard;

/** Предел карточки соединения у Cloudflare. */
export const CARD_LIMIT = 16_384;

type Passed = Exclude<VerifyResult, { error: string }>;
/** Решение по hello: карточка или слово закрытия и строка журнала. */
export type Admission = { card: Card } | { word: string; line: string };

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length;

/** Запись сессии этой машины: site@laptop; голый @laptop — не сессия. */
export const ownCallsign = (callsign: unknown, machine: string) => kindOf(callsign) === "session" && machineOf(callsign as string) === machine;

export const passId = (r: Pick<Passed, "role" | "name" | "kid">) => `${r.role}.${r.name}.${r.kid}`;

/** Вписывается ли карточка в предел платформы; нет — строка причины. */
export function tooBig(card: Card): string | null {
  const size = bytes(card);
  return size > CARD_LIMIT ? `карточка ${size} байт · предел ${CARD_LIMIT}` : null;
}

/** Что значит принятый пропуск на объекте machine при этом hello. Версию проверяет вызывающий: она зависит от настройки relay. */
export function admit(r: Passed, f: Frame, machine: string, proto: number, since: number): Admission {
  const id = passId(r);
  const base = { name: r.name, kid: r.kid, since, proto };
  const mine = r.role === "host" && r.name === machine;
  if (f.part !== undefined && !(mine && f.part === "keeper")) {
    return { word: "bad_frame", line: `bad_frame ${id} · part ${JSON.stringify(f.part)} — в relay своей машины входит только keeper пропуском машины` };
  }
  let card: Card;
  if (f.part === "keeper") card = { role: "keeper", ...base };
  else if (r.role !== "host") card = { role: "client", ...base, addr: r.addr };
  else if (!mine) card = { role: "guest", ...base };
  else {
    const sessions = f.sessions ?? [];
    if (!Array.isArray(sessions) || !sessions.every((s) => isRecord(s) && ownCallsign(s.callsign, r.name))) {
      return { word: "bad_from", line: `bad_from ${id} · в hello callsign не машины ${r.name}` };
    }
    card = { role: "host", ...base, sdk: typeof f.sdk === "string" ? f.sdk : undefined, contract: isRecord(f.contract) ? (f.contract as Record<string, number>) : undefined, sessions };
  }
  const big = tooBig(card);
  return big ? { word: "bad_frame", line: `bad_frame ${id} · ${big}` } : { card };
}

/** Адрес отправителя по пропуску. */
export function addressOf(card: Card): string {
  if (card.role === "client") return card.addr;
  return card.role === "keeper" ? `.keeper@${card.name}` : `@${card.name}`;
}

/** Запись сессии заменена или с state: null убрана; место в списке держится. */
export function withSession(card: HostCard, f: Frame): HostCard {
  const { type: _type, id: _id, v: _v, from: _from, to: _to, ...record } = f;
  const at = card.sessions.findIndex((s) => s.callsign === f.callsign);
  const sessions = card.sessions.filter((s) => s.callsign !== f.callsign);
  if (f.state !== null) sessions.splice(at < 0 ? sessions.length : at, 0, record as SessionRecord);
  return { ...card, sessions };
}

/** roster объекта: своя машина и её сессии; гости — устройства, программы и Host других машин (@машина). Keeper в roster не входит. */
export function rosterOf(cards: Card[]): Roster {
  const roster: Roster = { type: "roster", machines: [], sessions: [], clients: [] };
  for (const c of cards) {
    if (c.role === "host") {
      roster.machines.push({ machine: c.name, since: c.since, proto: c.proto, sdk: c.sdk, contract: c.contract });
      roster.sessions.push(...c.sessions);
    } else if (c.role !== "keeper" && !roster.clients.includes(addressOf(c))) {
      roster.clients.push(addressOf(c));
    }
  }
  return roster;
}
