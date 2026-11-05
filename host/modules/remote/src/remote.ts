import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeDir } from "@switchboard/host";
import type { Host, Module, Session } from "@switchboard/host";

/** Раздел сессии. account — кто был в слоте, когда мост включился. */
type Bridge = { url?: string; bridge?: string; account?: string | null };
type Binding = { type?: string; sessionId?: string; bridgeSessionId?: string };

const accountOf = (s: Session) => (s.field("account") as string | undefined) ?? null;

/** Файл разговора: папку проекта называет сам claude. */
function transcriptOf(root: string, sessionId: string): string | null {
  const projects = join(root, "projects");
  if (!existsSync(projects)) return null;
  return readdirSync(projects).map((d) => join(projects, d, `${sessionId}.jsonl`)).find((f) => existsSync(f)) ?? null;
}

/** Последняя запись привязки в файле — так её прочитает claude. Недописанная строка — не запись. */
function lastBridge(file: string): Binding | null {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"bridge-session"')) continue;
    try {
      const rec = JSON.parse(lines[i]) as Binding;
      if (rec.type === "bridge-session") return rec;
    } catch {
      // claude ещё пишет эту строку
    }
  }
  return null;
}

export function make(o: { claudeDir?: string } = {}): Module {
  let host: Host;
  /** Отказ claude в этом процессе Host: в раздел не идёт. */
  const refused = new Map<string, string>();

  /** Разговор привязан к сессии claude.ai другого входа или старого состояния — новый мост заведёт свою привязку. */
  function unbind(s: Session): void {
    const { callsign, session_id: sessionId, start } = s.info;
    const file = transcriptOf(o.claudeDir ?? claudeDir(), sessionId);
    if (!file) return;
    const bound = lastBridge(file);
    if (!bound?.bridgeSessionId) return;
    const account = s.store<Bridge>().get()?.account;
    const now = accountOf(s);
    const reason = start === "point" ? "старт из точки" : account === undefined ? "записи нет" : account !== now ? `${account} → ${now}` : null;
    if (!reason) return;
    // не вышло записать — исключение: ядро выключит модуль в сессии
    appendFileSync(file, JSON.stringify({ type: "bridge-session", sessionId: bound.sessionId ?? sessionId, bridgeSessionId: "", lastSequenceNum: 0 }) + "\n");
    host.log({ ev: "unbind", callsign, why: `привязка снята: ${reason} · ${bound.bridgeSessionId}` });
  }

  async function enable(s: Session): Promise<void> {
    const { callsign, start } = s.info;
    let r: { session_url?: string; bridge_session_id?: string } | undefined;
    try {
      r = (await s.sdk("enableRemoteControl", true)) as typeof r;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      refused.set(callsign, why);
      host.log({ kind: "stop", ev: "remote", callsign, why });
      s.refresh();
      return;
    }
    refused.delete(callsign);
    const store = s.store<Bridge>();
    // attach: мост живёт в процессе с прежним аккаунтом
    const before = store.get()?.account;
    const account = start === "attach" && before !== undefined ? before : accountOf(s);
    store.set({ url: r?.session_url, bridge: r?.bridge_session_id, account });
    host.log({ ev: "remote", callsign, why: `Remote Control включён: ${r?.session_url ?? "—"} · ${account ?? "—"}` });
    s.refresh();
  }

  return {
    start(h) {
      host = h;
    },
    session(s) {
      if (s.info.start === "resume" || s.info.start === "point") unbind(s);
      return undefined;
    },
    fields: {
      remote(s) {
        const error = refused.get(s.info.callsign);
        if (error) return { error };
        const url = s.store<Bridge>().get()?.url;
        return url ? { url } : undefined;
      },
    },
    on: {
      open: (s) => enable(s),
    },
  };
}
