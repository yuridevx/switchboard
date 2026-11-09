// Remote Control: сессия с ключом документа remote открыта в приложении Claude. Привязка к сессии claude.ai живёт в файле разговора:
// чужому аккаунту её надо снять до возобновления.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostApi, Module, SessionApi } from "../../core/contract.ts";
import { claudeDir } from "../../core/paths.ts";

/** Раздел сессии: account — на каком аккаунте мост включился. */
type Part = { url?: string; account: string | null; error?: string };
type Bridge = { sessionId?: string; bridgeSessionId?: string };

function transcriptOf(dir: string, sessionId: string): string | undefined {
  const projects = join(dir, "projects");
  if (!existsSync(projects)) return undefined;
  return readdirSync(projects).map((d) => join(projects, d, `${sessionId}.jsonl`)).find(existsSync);
}

/** Последняя целая запись привязки: claude читает файл так же. */
function lastBridge(text: string): Bridge | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes('"bridge-session"')) continue;
    try {
      const rec = JSON.parse(lines[i]!) as Bridge & { type?: string };
      if (rec.type === "bridge-session") return rec;
    } catch {
      // недописанная строка — не запись
    }
  }
  return undefined;
}

export function make({ claudeDir: dir }: { claudeDir?: string } = {}): Module {
  let host: HostApi;
  /** Аккаунт сессии сейчас: его называет модуль аккаунтов в строке; своего знания нет. */
  const accountOf = (s: SessionApi): string | null => s.spec.account ?? null;

  /** Привязку снимаем, если аккаунт сменился: та же учётная запись продолжает. */
  function unbind(s: SessionApi): void {
    const part = s.store<Part>().get();
    const now = accountOf(s);
    const why = !part ? "записи нет" : part.account === now ? undefined : `${part.account ?? "—"} → ${now ?? "—"}`;
    if (!why) return;
    const file = transcriptOf(dir ?? claudeDir(), s.info.sessionId);
    if (!file) return;
    const text = readFileSync(file, "utf8");
    const bound = lastBridge(text);
    if (!bound?.bridgeSessionId) return;
    // файл кончается обрывком упавшего процесса: запись — своей строкой, иначе claude её не прочтёт
    appendFileSync(file, `${text.endsWith("\n") ? "" : "\n"}${JSON.stringify({ type: "bridge-session", sessionId: bound.sessionId ?? s.info.sessionId, bridgeSessionId: "", lastSequenceNum: 0 })}\n`);
    host.log.info("unbind", { callsign: s.callsign, why: `привязка снята: ${why} · ${bound.bridgeSessionId}` });
  }

  async function enable(s: SessionApi): Promise<void> {
    const account = accountOf(s);
    try {
      const r = (await s.sdk("enableRemoteControl", true)) as { session_url?: string };
      s.store<Part>().set({ url: r?.session_url, account });
      host.log.info("remote", { callsign: s.callsign, why: `Remote Control включён: ${r?.session_url ?? "—"}` });
    } catch (e) {
      s.store<Part>().set({ account, error: (e as Error).message });
      host.log.warn("remote", { callsign: s.callsign, why: (e as Error).message });
    }
    s.sync();
  }

  return {
    name: "host-remote",
    start: (h) => void (host = h),
    spec: { remote() {} },
    compose(s) {
      if (s.spec.remote) unbind(s);
      return {};
    },
    async applied(s, keys) {
      if (!keys.includes("remote")) return;
      if (s.spec.remote && (s.state === "idle" || s.state === "busy" || s.state === "waiting")) return enable(s);
      if (!s.spec.remote) {
        s.store<Part>().set(undefined);
        if (s.state === "idle" || s.state === "busy" || s.state === "waiting") await s.sdk("enableRemoteControl", false).catch(() => {});
        s.sync();
      }
    },
    row(s) {
      const url = s.spec.remote ? s.store<Part>().get()?.url : undefined;
      return url ? { remoteUrl: url } : {};
    },
    on: {
      // новый процесс сессии готов — мост включается заново
      state(s, state, was) {
        if (was === "starting" && s.spec.remote && (state === "idle" || state === "busy")) void enable(s);
      },
    },
  };
}
