// Модуль manage: сессии по запросу — открыть, сменить модель и усилие на ходу, звать открытые методы query(),
// остановить, поднять, убрать. Всё — методами Agent SDK через ядро; поток сообщений не читает.
// Своё хранит одно: спецификацию сессии — что выбрал клиент (модель, усилие, флаги ответа).
// Папку держит ядро, слот — slots, профиль — profiles, заголовок — файл разговора.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { refuse } from "@switchboard/host";
import type { Ctx, Frame, Host, Module, QueryPart, Session } from "@switchboard/host";

/** Спецификация сессии: выбор клиента. Нет поля — значение по умолчанию claude. */
export type Spec = { model?: string; effort?: string; fast?: boolean; style?: string; thinking?: boolean };

/** Методы query(), которые клиент зовёт по имени. Остальное — unknown_method, метод не вызван. */
export const OPEN = new Set([
  "interrupt",
  "getContextUsage",
  "supportedCommands",
  "supportedModels",
  "supportedAgents",
  "mcpServerStatus",
  "toggleMcpServer",
  "reconnectMcpServer",
  "rewindFiles",
  "stopTask",
  "backgroundTasks",
  "reloadPlugins",
]);

const EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Флаги ответа → ключ settings в applyFlagSettings и в query(). */
const FLAG: Record<"effort" | "fast" | "style" | "thinking", string> = { effort: "effortLevel", fast: "fastMode", style: "outputStyle", thinking: "alwaysThinkingEnabled" };

const live = (s: Session) => s.state === "idle" || s.state === "busy" || s.state === "waiting";

/** Поля спецификации из кадра; не того вида — bad_spec. Незнакомые поля пропускаются. */
function specOf(f: Frame): Spec {
  const spec: Spec = {};
  const bad = (k: string) => {
    throw refuse("bad_spec", `${f.type} ${String(f.callsign ?? f.name ?? "")}: ${k} = ${JSON.stringify(f[k])}`);
  };
  if (f.model !== undefined) typeof f.model === "string" && f.model ? (spec.model = f.model) : bad("model");
  if (f.effort !== undefined) typeof f.effort === "string" && EFFORT.has(f.effort) ? (spec.effort = f.effort) : bad("effort");
  if (f.fast !== undefined) typeof f.fast === "boolean" ? (spec.fast = f.fast) : bad("fast");
  if (f.style !== undefined) typeof f.style === "string" && f.style ? (spec.style = f.style) : bad("style");
  if (f.thinking !== undefined) typeof f.thinking === "boolean" ? (spec.thinking = f.thinking) : bad("thinking");
  if (f.title !== undefined && (typeof f.title !== "string" || !f.title)) bad("title");
  return spec;
}

/** Флаги спецификации как settings. */
function flags(spec: Spec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["effort", "fast", "style", "thinking"] as const) if (spec[k] !== undefined) out[FLAG[k]] = spec[k];
  return out;
}

export type ManageOptions = { home?: string };

export function manage(o: ManageOptions = {}): Module {
  const home = o.home ?? homedir();
  /** Спецификация и заголовок новой сессии: от session.open до её первого session() внутри host.open. */
  const pending = new Map<string, { spec: Spec; title: string }>();

  const tilde = (p: string) => (p === home ? "~" : p.startsWith(home + sep) ? "~/" + p.slice(home.length + 1).split(sep).join("/") : p);
  const expand = (p: string) => (p === "~" ? home : p.startsWith("~/") ? join(home, ...p.slice(2).split("/")) : p);
  const specOfSession = (s: Session) => s.store<Spec>().get() ?? {};

  /** Метод или функция SDK: отказ SDK — слово sdk_error, причина в журнале; модуль не выключается. */
  async function call(s: Session, method: string, ...args: unknown[]): Promise<unknown> {
    try {
      return await s.sdk(method, ...args);
    } catch (e) {
      throw refuse("sdk_error", `${s.info.callsign}: ${method} — ${(e as Error).message}`);
    }
  }

  function ledger(host: Host, ev: string, text: string, ctx: Ctx, callsign: string): void {
    const r = host.emit({ type: "ledger.add", to: ".ledger", v: 1, ev, text, ...(ctx.from ? { by: ctx.from } : {}), machine: host.machine, callsign });
    if (!r.ok) host.log({ kind: "note", ev: "ledger", word: r.error, callsign, why: `${ev} не записан в журнал флота: ${r.error}` });
  }

  /** PostModelSwitch: модель сменили в claude.ai или командой /model — спецификация берёт новую, иначе resume вернул бы прежнюю. */
  const onModelSwitch = (s: Session) => async (input: unknown) => {
    const i = input as { source?: string; requested_model?: string | null };
    if (i.source === "resume") return {};
    s.store<Spec>().update((cur = {}) => {
      const next = { ...cur };
      if (i.requested_model) next.model = i.requested_model;
      else delete next.model;
      return next;
    });
    return {};
  };

  return {
    session(s) {
      const first = pending.get(s.info.callsign);
      if (first) {
        pending.delete(s.info.callsign);
        if (Object.keys(first.spec).length) s.store<Spec>().set(first.spec);
      }
      const spec = first?.spec ?? specOfSession(s);
      const part: QueryPart = {
        enableFileCheckpointing: true,
        hooks: { PostModelSwitch: [{ hooks: [onModelSwitch(s)] }] },
      };
      if (spec.model) part.model = spec.model;
      if (spec.effort) part.effort = spec.effort;
      const { effortLevel: _e, ...settings } = flags(spec);
      if (Object.keys(settings).length) part.settings = settings;
      if (first) part.title = first.title;
      return part;
    },

    fields: {
      model: (s) => specOfSession(s).model ?? s.info.model ?? undefined,
      effort: (s) => specOfSession(s).effort,
    },

    requests: {
      async "session.open"(req, ctx) {
        const { host } = ctx;
        const name = req.name;
        if (typeof name !== "string" || !NAME.test(name)) throw refuse("bad_spec", `session.open: имя ${JSON.stringify(name)}`);
        const callsign = `${name}@${host.machine}`;
        if (host.session(callsign)) throw refuse("name_taken", `session.open: ${callsign} уже есть`);
        const dir = req.dir;
        if (typeof dir !== "string" || !(dir === "~" || dir.startsWith("~/") || isAbsolute(dir))) throw refuse("bad_spec", `session.open ${callsign}: папка ${JSON.stringify(dir)} не от ~ и не полная`);
        const cwd = expand(dir);
        let isDir = false;
        try {
          isDir = statSync(cwd).isDirectory();
        } catch {
          // нет папки — ниже отказ
        }
        if (!isDir) throw refuse("bad_spec", `session.open ${callsign}: папки ${dir} нет`);
        const spec = specOf(req);
        if (req.resume !== undefined && typeof req.resume !== "string") throw refuse("bad_spec", `session.open ${callsign}: resume`);
        if (req.fork !== undefined && typeof req.fork !== "boolean") throw refuse("bad_spec", `session.open ${callsign}: fork`);
        if (req.point !== undefined && typeof req.point !== "number") throw refuse("bad_spec", `session.open ${callsign}: point`);
        // профиль и слот — их владельцам, до старта
        for (const [type, key] of [["session.profile", "profile"], ["session.slot", "slot"]] as const) {
          if (req[key] === undefined) continue;
          const r = await host.request(type, { v: 1, callsign, [key]: req[key] });
          if (!r.ok) throw refuse(r.error, `session.open ${callsign}: ${type} — ${r.error}`);
        }
        pending.set(callsign, { spec, title: name });
        let s: Session;
        try {
          s = await host.open({
            callsign,
            cwd,
            ...(req.resume !== undefined ? { resume: req.resume as string } : {}),
            ...(req.fork !== undefined ? { fork: req.fork as boolean } : {}),
            ...(req.point !== undefined ? { point: req.point as number } : {}),
          });
        } catch (e) {
          const why = (e as Error).message;
          if (why.includes("имя занято")) throw refuse("name_taken", why);
          throw refuse("open_failed", `${callsign}: ${why}`);
        } finally {
          pending.delete(callsign);
        }
        ledger(host, "session.opened", `${callsign} создана · ${dir}${typeof req.slot === "string" ? ` · слот ${req.slot}` : ""}`, ctx, callsign);
        return { callsign, session_id: s.info.session_id };
      },

      async "session.update"(req, { host }) {
        const s = host.session(req.callsign as string)!;
        const spec = specOf(req);
        if (Object.keys(spec).length) s.store<Spec>().update((cur = {}) => ({ ...cur, ...spec }));
        const now: string[] = [];
        if (live(s)) {
          if (spec.model !== undefined) {
            await call(s, "setModel", spec.model);
            now.push("model");
          }
          const f = flags(spec);
          if (Object.keys(f).length) {
            await call(s, "applyFlagSettings", f);
            now.push(...(["effort", "fast", "style", "thinking"] as const).filter((k) => spec[k] !== undefined));
          }
        }
        if (typeof req.title === "string") {
          await call(s, "renameSession", req.title);
          now.push("title");
        }
        return { now };
      },

      async "session.call"(req, { host }) {
        const s = host.session(req.callsign as string)!;
        const method = req.method;
        if (typeof method !== "string" || !OPEN.has(method)) throw refuse("unknown_method", `session.call ${s.info.callsign}: ${String(method)} — нет в списке открытых`);
        if (!live(s)) throw refuse("stopped", `session.call ${s.info.callsign}: ${method} — сессия ${s.state}`);
        if (req.args !== undefined && !Array.isArray(req.args)) throw refuse("bad_spec", `session.call ${s.info.callsign}: args не массив`);
        return call(s, method, ...((req.args as unknown[] | undefined) ?? []));
      },

      async "session.spec"(req, { host }) {
        const s = host.session(req.callsign as string)!;
        const spec = specOfSession(s);
        const info = (await call(s, "getSessionInfo")) as { customTitle?: string; summary?: string } | undefined;
        return { dir: tilde(s.info.cwd), model: spec.model ?? null, effort: spec.effort ?? null, title: info?.customTitle ?? info?.summary ?? null };
      },

      async "session.stop"(req, { host }) {
        await host.session(req.callsign as string)!.stop();
      },

      async "session.start"(req, { host }) {
        const s = host.session(req.callsign as string)!;
        if (req.point !== undefined && typeof req.point !== "number") throw refuse("bad_spec", `session.start ${s.info.callsign}: point`);
        try {
          await s.start(req.point !== undefined ? { point: req.point as number } : undefined);
        } catch (e) {
          throw refuse("open_failed", `${s.info.callsign}: ${(e as Error).message}`);
        }
      },

      async "session.remove"(req, ctx) {
        const callsign = req.callsign as string;
        await ctx.host.session(callsign)!.remove();
        ledger(ctx.host, "session.removed", `${callsign} забыта`, ctx, callsign);
      },
    },
  };
}
