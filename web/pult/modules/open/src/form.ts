// Правила формы новой сессии: адрес и его родитель, с какого места начать, что уходит в session.open.
import { machineOf } from "@switchboard/protocol";
import type { SessionRecord } from "@switchboard/relay";
import { profileIdOf } from "@switchboard/web-ui";

export type Place = { m: string; dir: string };
export const RECENT_LIMIT = 5;

/** Адрес поля: чей список показать и каким хвостом его сузить. */
export function splitAddress(addr: string): { parent: string; tail: string } {
  const text = addr.trim();
  if (text.endsWith("/") || !text.includes("/")) return { parent: text.replace(/\/+$/, "") || "~", tail: "" };
  const at = text.lastIndexOf("/");
  return { parent: text.slice(0, at) || "/", tail: text.slice(at + 1) };
}

/** Папка, в которой откроется сессия: без хвостовой черты. */
export const dirOf = (addr: string) => addr.trim().replace(/(.)\/+$/, "$1") || "~";

/** Что показать из ответа: скрытые — только когда хвост с точки. */
export const shownDirs = (dirs: string[], tail: string) => dirs.filter((d) => d.toLowerCase().startsWith(tail.toLowerCase()) && (tail.startsWith(".") || !d.startsWith(".")));

/** Машины выбора: где больше сессий — выше. */
export function byLoad(machines: string[], sessions: SessionRecord[]) {
  const count = (m: string) => sessions.filter((s) => machineOf(s.callsign) === m).length;
  return [...machines].sort((a, b) => count(b) - count(a));
}

/** С чего начать без адреса: последнее своё место, иначе машина с большим числом сессий и домашняя папка. */
export function startPlace(machines: string[], sessions: SessionRecord[], recent: Place[]): Place | null {
  const last = recent.find((p) => machines.includes(p.m));
  if (last) return last;
  const best = byLoad(machines, sessions)[0];
  return best ? { m: best, dir: "~" } : null;
}

/** Профиль подхватывается только от сессии в этой же папке этой машины. */
export const profileHere = (sessions: SessionRecord[], machine: string, dir: string) => profileIdOf(sessions.find((s) => machineOf(s.callsign) === machine && s.dir === dir && profileIdOf(s))) ?? "";

export const pushRecent = (old: Place[] | undefined, p: Place): Place[] => [p, ...(old ?? []).filter((x) => x.m !== p.m || x.dir !== p.dir)].slice(0, RECENT_LIMIT);

/** Отказ session.open: где показать и каким словом. */
export function refusal(error: string, why: string | undefined, machine: string, name: string): { field: "name" | "slot" | ""; text: string } {
  if (error === "name_taken") return { field: "name", text: `на ${machine} уже есть ${name}` };
  if (error === "bad_name") return { field: "name", text: "латиница, цифры, точка, - и _" };
  if (error === "slot_required") return { field: "slot", text: "Выберите слот" };
  return { field: "", text: `session.open: ${error}${why ? ` — ${why}` : ""}` };
}
