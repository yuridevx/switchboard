// Модуль remote: Remote Control у каждой сессии Host — мост процесса claude к claude.ai.
// Исключение устава (как в claude-fleet): включение — метод SDK enableRemoteControl (в типах SDK его нет),
// снятие привязки — запись bridge-session с пустым bridgeSessionId в файл разговора (формат не документирован).
//
// До старта процесса: resume или старт из точки, а в файле разговора есть привязка к сессии claude.ai —
//   из точки снимать всегда; иначе снимать, если в слоте сессии сейчас не тот аккаунт, под которым мост включался,
//   или записи нет. attach — файл живого процесса не трогать: claude держит привязку в памяти и допишет её поверх.
// Кто в слоте сессии — поле account владельца слотов, читается в момент решения; своей копии нет.
// После initialize: enableRemoteControl(true) без имени — заголовок в claude.ai остаётся именем сессии.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeDir } from "@switchboard/host";
import type { Host, Module, Session } from "@switchboard/host";

/** Раздел сессии: ссылка, мост и аккаунт, под которым мост включился. */
type Record_ = { url?: string; bridge?: string; account?: string | null };
type Bridge = { type?: string; sessionId?: string; bridgeSessionId?: string };

/** Файл разговора: <папка Claude>/projects/<папка проекта>/<session_id>.jsonl. */
function transcript(home: string, sessionId: string): string | null {
  const projects = join(home, "projects");
  if (!existsSync(projects)) return null;
  const file = readdirSync(projects).map((d) => join(projects, d, `${sessionId}.jsonl`)).find(existsSync);
  return file ?? null;
}

/** Последняя запись привязки; недописанная строка — не запись. */
function lastBridge(file: string): Bridge | null {
  let last: Bridge | null = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"bridge-session"')) continue;
    try {
      const v = JSON.parse(line) as Bridge;
      if (v.type === "bridge-session") last = v;
    } catch {
      // claude ещё пишет эту строку
    }
  }
  return last;
}

/** Кто в слоте сессии сейчас; вне слотов или слоты выключены — вход машины, null. */
const accountOf = (s: Session) => (s.field("account") as string | null | undefined) ?? null;

/** Почему снять привязку перед стартом; снимать не надо — null. */
function reasonToUnbind(s: Session): string | null {
  if (s.info.start === "point") return "старт из точки";
  const rec = s.store<Record_>().get();
  if (!rec || rec.account === undefined) return "записи нет";
  const now = accountOf(s);
  return now === rec.account ? null : `${rec.account} → ${now}`;
}

export function make(o: { claudeDir?: string } = {}): Module {
  let host!: Host;
  /** отказ claude во включении — до следующего старта процесса */
  const refused = new Map<string, string>();

  return {
    start(h) {
      host = h;
    },

    // не вышло записать — исключение: ядро выключит модуль в сессии
    session(s) {
      const { start, callsign, session_id } = s.info;
      if (start !== "resume" && start !== "point") return undefined;
      const file = transcript(o.claudeDir ?? claudeDir(), session_id);
      const bound = file && lastBridge(file);
      if (!bound || !bound.bridgeSessionId) return undefined;
      const why = reasonToUnbind(s);
      if (!why) return undefined;
      appendFileSync(file, JSON.stringify({ type: "bridge-session", sessionId: bound.sessionId ?? session_id, bridgeSessionId: "", lastSequenceNum: 0 }) + "\n");
      host.log({ ev: "unbind", callsign, why: `привязка снята: ${why} · ${bound.bridgeSessionId}` });
      return undefined;
    },

    fields: {
      remote: (s) => {
        const error = refused.get(s.info.callsign);
        if (error) return { error };
        const url = s.store<Record_>().get()?.url;
        return url ? { url } : undefined;
      },
    },

    on: {
      async open(s) {
        const { callsign, start } = s.info;
        let bridge: { session_url?: string; bridge_session_id?: string };
        try {
          bridge = ((await s.sdk("enableRemoteControl", true)) ?? {}) as typeof bridge;
        } catch (e) {
          const why = (e as Error).message;
          refused.set(callsign, why);
          host.log({ kind: "stop", ev: "remote", callsign, why });
          return;
        }
        refused.delete(callsign);
        const before = s.store<Record_>().get();
        // attach: мост живёт в процессе с прежним аккаунтом — его и помним
        const account = start === "attach" && before && before.account !== undefined ? before.account : accountOf(s);
        s.store<Record_>().set({ url: bridge.session_url, bridge: bridge.bridge_session_id, account });
        host.log({ ev: "remote", callsign, why: `Remote Control включён: ${bridge.session_url ?? "—"} · ${account ?? "вход машины"}` });
      },
    },
  };
}
