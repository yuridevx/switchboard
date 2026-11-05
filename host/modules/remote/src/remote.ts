import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeDir } from "@switchboard/host";
import type { Host, Module, Session } from "@switchboard/host";

/** Раздел сессии. account — кто был в слоте, когда мост включился; null — вход машины. */
type Bridge = { url?: string; bridge?: string; account: string | null };

const loginName = (account: string | null) => account ?? "вход машины";
const accountOf = (s: Session) => (s.field("account") as string | undefined) ?? null;

/** Файл разговора: папку проекта называет сам claude. */
function transcriptOf(root: string, sessionId: string): string | null {
  const projects = join(root, "projects");
  if (!existsSync(projects)) return null;
  return readdirSync(projects).map((d) => join(projects, d, `${sessionId}.jsonl`)).find((f) => existsSync(f)) ?? null;
}

/** Последняя запись привязки в файле — так её прочитает claude. Недописанная строка — не запись. */
function lastBridge(content: string): string | null {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"bridge-session"')) continue;
    try {
      const rec = JSON.parse(lines[i]) as { type?: string; bridgeSessionId?: string };
      if (rec.type === "bridge-session") return rec.bridgeSessionId ?? null;
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
    const content = readFileSync(file, "utf8");
    const bound = lastBridge(content);
    if (!bound) return;
    const rec = s.store<Bridge>().get();
    const now = accountOf(s);
    const reason = start === "point" ? "старт из точки" : !rec ? "записи нет" : rec.account !== now ? `${loginName(rec.account)} → ${loginName(now)}` : null;
    if (!reason) return;
    const line = JSON.stringify({ type: "bridge-session", sessionId, bridgeSessionId: "", lastSequenceNum: 0 });
    appendFileSync(file, `${content.endsWith("\n") ? "" : "\n"}${line}\n`);
    host.log({ ev: "unbind", callsign, why: `привязка снята: ${reason} · ${bound}` });
  }

  async function enable(s: Session): Promise<void> {
    const { callsign, start } = s.info;
    try {
      const r = (await s.sdk("enableRemoteControl", true)) as { session_url?: string; bridge_session_id?: string } | undefined;
      refused.delete(callsign);
      const store = s.store<Bridge>();
      const account = start === "attach" && store.get() ? store.get()!.account : accountOf(s);
      store.set({ url: r?.session_url, bridge: r?.bridge_session_id, account });
      host.log({ ev: "remote", callsign, why: `Remote Control включён: ${r?.session_url ?? "—"} · ${loginName(account)}` });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      refused.set(callsign, why);
      host.log({ kind: "stop", ev: "remote", callsign, why });
    }
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
      open(s) {
        void enable(s);
      },
    },
  };
}
