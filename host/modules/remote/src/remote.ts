// Remote Control у каждой сессии. Привязка к сессии claude.ai живёт в файле разговора: чужому аккаунту её надо снять до resume.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeDir } from "@switchboard/host";
import type { Host, Module, Session } from "@switchboard/host";

/** Раздел сессии: account — кто был в слоте, когда мост включился. */
type Part = { url?: string; bridge?: string; account: string | null };
type Bridge = { sessionId?: string; bridgeSessionId?: string };

const accountOf = (s: Session) => (s.field("account") as string | undefined) ?? null;

function transcriptOf(dir: string, sessionId: string): string | undefined {
  const projects = join(dir, "projects");
  if (!existsSync(projects)) return undefined;
  return readdirSync(projects).map((d) => join(projects, d, `${sessionId}.jsonl`)).find(existsSync);
}

/** Последняя целая запись привязки: claude читает файл так же. */
function lastBridge(text: string): Bridge | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"bridge-session"')) continue;
    try {
      const rec = JSON.parse(lines[i]);
      if (rec.type === "bridge-session") return rec;
    } catch {
      // недописанная строка — не запись
    }
  }
  return undefined;
}

export function make({ claudeDir: dir }: { claudeDir?: string } = {}): Module {
  let host: Host;
  /** отказ claude в этом подъёме: виден в поле, пока следующий не удался */
  const refused = new WeakMap<Session, string>();

  /** Почему привязку надо снять; undefined — та же учётная запись продолжает. */
  function reasonOf(s: Session): string | undefined {
    if (s.info.start === "point") return "старт из точки";
    const part = s.store<Part>().get();
    if (!part) return "записи нет";
    const now = accountOf(s);
    return part.account === now ? undefined : `${part.account ?? "—"} → ${now ?? "—"}`;
  }

  function unbind(s: Session): void {
    const { callsign, session_id: sessionId } = s.info;
    const file = transcriptOf(dir ?? claudeDir(), sessionId);
    if (!file) return;
    const text = readFileSync(file, "utf8");
    const bound = lastBridge(text);
    const why = bound?.bridgeSessionId && reasonOf(s);
    if (!why) return;
    // файл кончается обрывком упавшего процесса: запись — своей строкой, иначе claude её не прочтёт
    appendFileSync(file, `${text.endsWith("\n") ? "" : "\n"}${JSON.stringify({ type: "bridge-session", sessionId: bound!.sessionId ?? sessionId, bridgeSessionId: "", lastSequenceNum: 0 })}\n`);
    host.log({ ev: "unbind", callsign, why: `привязка снята: ${why} · ${bound!.bridgeSessionId}` });
  }

  async function enable(s: Session): Promise<void> {
    const { callsign, start } = s.info;
    const before = s.store<Part>().get();
    const account = start === "attach" && before ? before.account : accountOf(s);
    try {
      const r = (await s.sdk("enableRemoteControl", true)) as { session_url?: string; bridge_session_id?: string };
      refused.delete(s);
      s.store<Part>().set({ url: r.session_url, bridge: r.bridge_session_id, account });
      host.log({ ev: "remote", callsign, why: `Remote Control включён: ${r.session_url ?? "—"} · ${account ?? "—"}` });
    } catch (e) {
      refused.set(s, (e as Error).message);
      host.log({ kind: "stop", ev: "remote", callsign, why: (e as Error).message });
    }
    s.refresh();
  }

  return {
    start: (h) => void (host = h),
    fields: {
      remote(s) {
        const error = refused.get(s);
        if (error) return { error };
        const url = s.store<Part>().get()?.url;
        return url ? { url } : undefined;
      },
    },
    session(s) {
      if (s.info.start === "resume" || s.info.start === "point") unbind(s);
      return undefined;
    },
    on: { open: (s) => enable(s) },
  };
}
