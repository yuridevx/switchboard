// Модуль remote: Remote Control у каждой сессии Host — мост процесса claude к claude.ai.
// Исключение устава (как в claude-fleet): включение — метод SDK enableRemoteControl (в типах SDK его нет),
// снятие привязки — запись bridge-session с пустым bridgeSessionId в файл разговора (формат не документирован).
//
// До старта процесса (session): resume или старт из точки, а в файле разговора есть привязка к сессии claude.ai —
//   из точки снимать всегда; иначе снимать, если в слоте сессии сейчас не тот аккаунт, под которым мост включался,
//   или записи нет. attach — файл живого процесса не трогать: claude держит привязку в памяти и допишет её поверх.
// После initialize (on.open): enableRemoteControl(true) без имени — заголовок в claude.ai остаётся именем сессии.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Host, Module, Session } from "@switchboard/host";

/** Раздел сессии: ссылка, мост и аккаунт, под которым мост включился. */
export type RemoteRecord = { url?: string; bridge?: string; account?: string | null };
type Slots = Record<string, { account?: string | null; sessions?: string[] }>;

export type RemoteOptions = {
  /** папка Claude с projects/ — по умолчанию CLAUDE_CONFIG_DIR или ~/.claude */
  claudeDir?: string;
};

/** Файл разговора: <папка Claude>/projects/<папка проекта>/<session_id>.jsonl. */
export function transcriptOf(claudeDir: string, sessionId: string): string | null {
  const projects = join(claudeDir, "projects");
  if (!existsSync(projects)) return null;
  for (const d of readdirSync(projects)) {
    const f = join(projects, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

/** Последняя запись bridge-session файла разговора. */
type Bridge = { type?: string; sessionId?: string; bridgeSessionId?: string };
export function lastBridge(file: string): Bridge | null {
  let last: Bridge | null = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"bridge-session"')) continue;
    try {
      const v = JSON.parse(line) as Bridge;
      if (v.type === "bridge-session") last = v;
    } catch {
      // недописанная строка — не запись
    }
  }
  return last;
}

export function remote(o: RemoteOptions = {}): Module {
  const claudeDir = () => o.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  let host!: Host;
  /** последний ответ machine.slots: кто в каком слоте и чьи там сессии */
  let slots: Slots = {};
  /** отказ claude во включении — до следующего старта процесса */
  const errors = new Map<string, string>();

  /** Кто в слоте сессии сейчас — по slots; вне слотов — вход машины, null. */
  const accountOf = (callsign: string): string | null => {
    for (const v of Object.values(slots)) if (v.sessions?.includes(callsign)) return v.account ?? null;
    return null;
  };

  /**
   * Ответ machine.slots. session() у ядра синхронный, поэтому решение до старта берёт последний ответ:
   * он обновляется на старте Host, после каждого старта процесса, конца хода и закрытия процесса.
   */
  async function refresh(): Promise<void> {
    const r = await host.request("machine.slots", { v: 1, machine: host.machine });
    if (!r.ok) throw new Error(`machine.slots: ${r.error}`);
    slots = ((r.result as { slots?: Slots } | undefined)?.slots ?? {}) as Slots;
  }

  /** Снять привязку до старта, если правило велит. Не вышло записать — исключение: ядро выключит модуль в сессии. */
  function unbind(s: Session): void {
    const { start, callsign, session_id } = s.info;
    if (start !== "resume" && start !== "point") return;
    const file = transcriptOf(claudeDir(), session_id);
    if (!file) return;
    const b = lastBridge(file);
    if (!b?.bridgeSessionId) return;
    const rec = s.store<RemoteRecord>().get();
    let why: string;
    if (start === "point") why = "старт из точки";
    else if (!rec || rec.account === undefined) why = "записи нет";
    else {
      const now = accountOf(callsign);
      if (now === rec.account) return;
      why = `${rec.account} → ${now}`;
    }
    appendFileSync(file, JSON.stringify({ type: "bridge-session", sessionId: b.sessionId ?? session_id, bridgeSessionId: "", lastSequenceNum: 0 }) + "\n");
    host.log({ ev: "unbind", callsign, why: `привязка снята: ${why} · ${b.bridgeSessionId}` });
  }

  return {
    async start(h) {
      host = h;
      await refresh();
    },

    session(s) {
      unbind(s);
      return undefined;
    },

    fields: {
      remote: (s) => {
        const err = errors.get(s.info.callsign);
        if (err) return { error: err };
        const url = s.store<RemoteRecord>().get()?.url;
        return url ? { url } : undefined;
      },
    },

    on: {
      async open(s) {
        const { callsign, start } = s.info;
        await refresh();
        let r: { session_url?: string; bridge_session_id?: string };
        try {
          r = ((await s.sdk("enableRemoteControl", true)) ?? {}) as typeof r;
        } catch (e) {
          const msg = (e as Error).message;
          errors.set(callsign, msg);
          host.log({ kind: "stop", ev: "remote", callsign, why: msg });
          return;
        }
        errors.delete(callsign);
        const rec = s.store<RemoteRecord>().get();
        // attach: мост живёт в процессе с прежним аккаунтом — его и помним
        const account = start === "attach" && rec && rec.account !== undefined ? rec.account : accountOf(callsign);
        s.store<RemoteRecord>().set({ url: r.session_url, bridge: r.bridge_session_id, account });
        host.log({ ev: "remote", callsign, why: `Remote Control включён: ${r.session_url ?? "—"} · ${account ?? "вход машины"}` });
      },
      state(_s, st) {
        if (st === "idle") return refresh();
      },
      close() {
        return refresh();
      },
    },
  };
}
