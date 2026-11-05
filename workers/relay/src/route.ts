// Доставка кадра: от кого он и какие соединения его получат. Чистые функции над карточками: сокетов не знают.
import { hostOf, kindOf, machineOf, reaches } from "@switchboard/protocol";
import type { Frame } from "@switchboard/protocol";
import { addressOf, type Card } from "./card.ts";

/** Имена relay: из них по сети разбирается только session.state; hello — первым кадром. */
const OWN = new Set(["hello", "roster", "session.state", "frame"]);

export type Refusal = { word: "bad_frame" | "bad_from" | "offline"; why: string };

/**
 * from ставит relay по пропуску: keeper — .keeper@машина, клиент — адрес от gate;
 * Host, свой или гость, — сама машина или сессия этой машины.
 */
export function senderOf(card: Card, f: Frame): { from: string } | Refusal {
  const own = addressOf(card);
  if (f.from === undefined) return { from: own };
  const isHost = card.role === "host" || card.role === "guest";
  const kind = kindOf(f.from);
  const allowed = isHost ? (kind === "session" || kind === "machine") && machineOf(f.from) === card.name : f.from === own;
  return allowed ? { from: f.from } : { word: "bad_from", why: `from=${String(f.from)}` };
}

/** Имя принадлежит relay: чужой кадр с таким именем — bad_frame; session.state разбирает объект. */
export const isOwnName = (type: string) => OWN.has(type);

/** Соединение Host машины: свой, иначе Host этой машины в гостях. */
const hostConn = <C extends { card: Card }>(conns: C[], machine: string): C | undefined => {
  const of = (role: Card["role"]) => conns.find((c) => c.card.role === role && c.card.name === machine);
  return of("host") ?? of("guest");
};

/** Получатели одного адреса на объекте: только своя машина и свои гости; служба — прямым запросом по её адресу, не через relay. */
export function reached<C extends { card: Card }>(conns: C[], address: string): C[] {
  const machine = machineOf(address) ?? "";
  switch (kindOf(address)) {
    case "machine":
    case "session": {
      const conn = hostConn(conns, machine);
      if (!conn) return [];
      // callsign своего Host — только если он есть в карточке; гостю — всё по адресам его машины
      const { card } = conn;
      const known = card.role !== "host" || kindOf(address) === "machine" || card.sessions.some((s) => s.callsign === address);
      return known ? [conn] : [];
    }
    case "part":
      return address.startsWith(".keeper@") ? conns.filter((c) => c.card.role === "keeper" && c.card.name === machine) : [];
    case "device":
    case "user":
      return conns.filter((c) => c.card.role === "client" && reaches(address, c.card.addr));
    default:
      return [];
  }
}

/** Куда идёт кадр после hello: получатели или отказ. Кадр с to — по адресам, без to — Host машины callsign или machine. */
export function targetsOf<C extends { card: Card }>(conns: C[], f: Frame): C[] | Refusal {
  if (f.to !== undefined) {
    const list = [f.to].flat();
    if (Array.isArray(f.to) && f.id !== undefined) return { word: "bad_frame", why: "to списком у кадра с id" };
    if (!list.length || !list.every((a) => kindOf(a) !== null)) return { word: "bad_frame", why: `to не адрес: ${JSON.stringify(f.to)}` };
    const targets = list.flatMap((a) => reached(conns, a));
    return targets.length ? targets : { word: "offline", why: `→ ${list.join(",")}` };
  }
  const machine = hostOf(f);
  if (machine === undefined) return { word: "bad_frame", why: "нет адреса" };
  if (!machine) return { word: "bad_frame", why: `callsign ${String(f.callsign)}` };
  const conn = hostConn(conns, machine);
  return conn ? [conn] : { word: "offline", why: `→ @${machine}` };
}
