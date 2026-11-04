// Снять точку — одна процедура на все поводы: блоки и git с машины, строка в реестре, точки сессии идут по очереди.
// Реестр решает, кто хозяин и каких блоков нет; модуль кладёт байты и отдаёт сессию, если хозяин уже другой.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Host, Result, Session } from "@switchboard/host";
import { addFile, projectDir, scanSession, upload } from "./blocks.ts";
import type { Fetch, Links, Scan } from "./blocks.ts";
import { BUNDLE, snapshot } from "./git.ts";

export type Why = "rule" | "save" | "start" | "raise" | "yield";
export type Taken = { point: number; same: boolean } | { error: string };

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b?.type === "text" ? String(b.text) : "")).join("");
};

/** «Первые слова» точки: 10 последних обменов по 160 знаков. */
function exchanges(messages: unknown[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of messages as Array<{ type?: string; message?: { content?: unknown } }>) {
    const text = textOf(m?.message?.content).trim().slice(0, 160);
    if (!text) continue;
    if (m.type === "user") out.push([text, ""]);
    else if (m.type === "assistant" && out.length) out[out.length - 1][1] = text;
  }
  return out.slice(-10);
}

const taken = (r: Result): Taken => (r.ok ? { point: (r.result as { id: number }).id, same: !!(r.result as { same?: boolean }).same } : { error: r.error });

export type Capture = ReturnType<typeof makeCapture>;

export function makeCapture(host: () => Host, fetcher: Fetch, onTaken: (s: Session) => void) {
  /** последняя точка не удалась: поле r2 */
  const failures = new Map<string, { error: string; at: number }>();
  /** последняя начатая точка каждой сессии: следующая ждёт её */
  const queues = new Map<string, Promise<Taken>>();
  /** сессии, чьё закрытие — не повод для точки */
  const silent = new Set<string>();

  /** points.put; реестр назвал недостающие блоки — положить их и спросить ещё раз. */
  async function put(frame: Record<string, unknown>, scan: Scan): Promise<Result> {
    const first = await host().request("points.put", frame);
    if (first.ok || first.error !== "missing") return first;
    const { missing, links } = first as unknown as { missing?: string[]; links?: Links };
    try {
      await upload(missing ?? [], links ?? {}, scan, fetcher);
    } catch (e) {
      host().log({ kind: "refuse", ev: "r2", word: "r2_failed", callsign: frame.callsign as string, why: (e as Error).message });
      return { ok: false, error: "r2_failed" };
    }
    return host().request("points.put", frame);
  }

  /** Сообщений и первых слов может не быть: разговор не прочитался — точка всё равно нужна. */
  async function conversation(s: Session): Promise<Record<string, unknown>> {
    try {
      const messages = (await s.sdk("getSessionMessages")) as unknown[];
      return { msgs: messages.length, last: exchanges(messages) };
    } catch (e) {
      host().log({ kind: "note", ev: "messages", callsign: s.info.callsign, why: (e as Error).message });
      return {};
    }
  }

  async function takeNow(s: Session, why: Why, more: Record<string, unknown>): Promise<Taken> {
    const { callsign, session_id: sid, cwd } = s.info;
    const proj = projectDir(cwd);
    if (!existsSync(join(proj, `${sid}.jsonl`))) return { error: "no_file" };
    const scan = scanSession(proj, sid);
    const bytes = scan.bytes;
    const git = await snapshot(cwd);
    try {
      if (git?.bundle) addFile(scan, git.bundle, BUNDLE);
      const spec = await host().read("session.spec", { callsign });
      const frame: Record<string, unknown> = {
        sid,
        why,
        files: scan.files,
        callsign,
        dir: cwd,
        bytes,
        ...(await conversation(s)),
        ...(git ? { git: git.summary } : {}),
        ...(spec.ok ? { spec: spec.result } : {}),
        ...more,
      };
      const r = await put(frame, scan);
      if (r.ok || r.error !== "not_owner" || why === "raise") return taken(r);
      // вернувшийся прежний хозяин: дописанное — веткой, сессию — убрать у себя; на её закрытие точки нет,
      // иначе второй not_owner и второй yield про уже убранную сессию (живой прогон 31 окт.: это уронило host-manage)
      host().log({ kind: "note", ev: "yield", callsign, why: `${callsign}: сессией владеет ${String((r as unknown as { owner?: string }).owner)} — отдаю` });
      const given = await put({ ...frame, why: "yield" }, scan);
      silent.add(callsign);
      const removed = await host().request("session.remove", { callsign });
      silent.delete(callsign);
      if (!removed.ok) host().log({ kind: "refuse", ev: "session.remove", word: removed.error, callsign });
      return taken(given);
    } finally {
      git?.cleanup();
    }
  }

  /** Снять точку в очередь сессии; итог — в поле r2 и в журнал. */
  function take(s: Session, why: Why, more: Record<string, unknown> = {}): Promise<Taken> {
    const cs = s.info.callsign;
    const run = async (): Promise<Taken> => {
      let out: Taken;
      try {
        out = await takeNow(s, why, more);
      } catch (e) {
        out = { error: (e as Error).message };
      }
      if ("error" in out) {
        failures.set(cs, { error: out.error, at: Math.floor(Date.now() / 1000) });
        host().log({ kind: "refuse", ev: "point", word: out.error, callsign: cs, why: `${cs}: точка (${why}) не снята — ${out.error}` });
      } else {
        failures.delete(cs);
        onTaken(s);
      }
      return out;
    };
    const next = (queues.get(cs) ?? Promise.resolve<Taken>({ error: "" })).then(run);
    queues.set(cs, next);
    return next;
  }

  return {
    take,
    failure: (cs: string) => failures.get(cs),
    forget: (cs: string) => void failures.delete(cs),
    silent,
    /** Все начатые точки доведены. */
    settled: () => Promise.all(queues.values()),
  };
}
