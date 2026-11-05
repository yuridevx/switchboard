import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { clientPath, isRefusal, refuse, tildePath } from "@switchboard/host";
import type { Frame, Host, Module, QueryPart, Session } from "@switchboard/host";

/** Раздел сессии. mode лежит только не по умолчанию. */
type Spec = { model?: string; effort?: string; fast?: boolean; style?: string; thinking?: boolean; parent?: string; mode?: string; remove_after_turn?: string };

const DEFAULT_MODE = "bypassPermissions";
const NAME = /^[\w.-]+$/;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CALLABLE = new Set([
  "interrupt", "getContextUsage", "supportedCommands", "supportedModels", "supportedAgents", "mcpServerStatus", "toggleMcpServer", "reconnectMcpServer",
  "rewindFiles", "stopTask", "backgroundTasks", "reloadPlugins", "askSideQuestion", "getTaskOutput", "cancelAsyncMessage", "mcpAuthenticate",
  "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET", "getStatus", "getHooksListing", "setPermissionMode", "listPermissionRules",
]);

const text = (v: unknown) => typeof v === "string" && v !== "";
const flag = (v: unknown) => typeof v === "boolean";
const RULES: Record<string, (v: unknown) => boolean> = { model: text, effort: (v) => EFFORTS.includes(v as string), fast: flag, style: text, thinking: flag, title: text };
/** Ключ настроек SDK у поля спецификации, которое стартует через settings. */
const SETTING: Record<string, string> = { fast: "fastMode", style: "outputStyle", thinking: "alwaysThinkingEnabled" };

function checkSpec(f: Frame, where: string): void {
  for (const [k, ok] of Object.entries(RULES)) if (f[k] !== undefined && !ok(f[k])) throw refuse("bad_spec", `${where}: ${k} = ${JSON.stringify(f[k])}`);
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const live = (s: Session) => s.state !== "stopped" && s.state !== "failed";
const specOf = (s: Session) => s.store<Spec>().get() ?? {};

async function sdk(s: Session, name: string, ...args: unknown[]): Promise<unknown> {
  try {
    return await s.sdk(name, ...args);
  } catch (e) {
    throw refuse("sdk_error", `${s.info.callsign}: ${name} — ${message(e)}`);
  }
}

/** Поднять процесс: отказ модуля идёт наружу как есть, остальное — open_failed. */
async function starting<T>(callsign: string, start: () => Promise<T>): Promise<T> {
  try {
    return await start();
  } catch (e) {
    if (isRefusal(e)) throw e;
    throw refuse("open_failed", `${callsign}: ${message(e)}`);
  }
}

/** Путь можно построить: ближайшее, что уже есть, — папка. */
function buildable(path: string): boolean {
  const st = statSync(path, { throwIfNoEntry: false });
  if (st) return st.isDirectory();
  return dirname(path) === path ? false : buildable(dirname(path));
}

export function make({ home = homedir() }: { home?: string } = {}): Module {
  let host: Host;
  /** Открытые запросом, ещё без первого старта: им заголовок. */
  const titled = new Set<string>();

  const ledger = (ev: string, callsign: string, text: string, by: unknown) => host.emit({ type: "ledger.add", v: 1, to: ".ledger", ev, text, by, machine: host.machine, callsign } as Frame);
  const session = (req: Frame) => host.session(req.callsign as string)!;

  /** Открытие долгое: номер занят с выбора, а не с конца открытия. */
  const opening = new Set<string>();
  function firstFree(name: string): string {
    for (let n = 1; ; n++) {
      const callsign = `${name}-${n}@${host.machine}`;
      if (!host.session(callsign) && !opening.has(callsign)) return callsign;
    }
  }

  async function forget(s: Session, by: unknown): Promise<void> {
    const { callsign } = s.info;
    await s.remove();
    ledger("session.removed", callsign, `${callsign} забыта`, by);
  }

  return {
    start(h) {
      host = h;
    },

    opening(s, req) {
      const spec: Spec = {};
      for (const k of ["model", "effort", "fast", "style", "thinking"] as const) if (req[k] !== undefined) Object.assign(spec, { [k]: req[k] });
      if (typeof req.from === "string") spec.parent = req.from;
      if (Object.keys(spec).length) s.store<Spec>().set(spec);
      if (req.name !== undefined) titled.add(s.info.callsign);
    },

    session(s) {
      const spec = specOf(s);
      const settings = Object.fromEntries(Object.entries(SETTING).filter(([k]) => spec[k as keyof Spec] !== undefined).map(([k, key]) => [key, spec[k as keyof Spec]]));
      const part: QueryPart = {
        enableFileCheckpointing: true,
        hooks: {
          PostModelSwitch: [
            {
              hooks: [
                async (input) => {
                  const { requested_model: model, source } = input as { requested_model?: string | null; source?: string };
                  if (source !== "resume") s.store<Spec>().update(({ model: _, ...rest } = {}) => (model ? { ...rest, model } : rest));
                  return {};
                },
              ],
            },
          ],
        },
      };
      if (spec.mode) part.permissionMode = spec.mode;
      if (spec.model) part.model = spec.model;
      if (spec.effort) part.effort = spec.effort;
      if (Object.keys(settings).length) part.settings = settings;
      if (titled.delete(s.info.callsign)) part.title = s.info.callsign.split("@")[0];
      return part;
    },

    fields: {
      model: (s) => specOf(s).model ?? s.info.model ?? undefined,
      effort: (s) => specOf(s).effort,
      parent: (s) => specOf(s).parent,
      mode: (s) => specOf(s).mode ?? DEFAULT_MODE,
    },

    on: {
      event(s, msg) {
        const mode = (msg as { permissionMode?: unknown }).permissionMode;
        if (msg.type !== "system" || typeof mode !== "string") return;
        s.store<Spec>().update(({ mode: _, ...rest } = {}) => (mode === DEFAULT_MODE ? rest : { ...rest, mode }));
      },
      state(s, state) {
        const by = specOf(s).remove_after_turn;
        if (state === "idle" && by) void forget(s, by);
      },
    },

    requests: {
      async "session.open"(req, ctx) {
        const { name, dir } = req;
        if (typeof name !== "string" || !NAME.test(name)) throw refuse("bad_name", `session.open: имя ${JSON.stringify(name)}`);
        if (req.number !== undefined && typeof req.number !== "boolean") throw refuse("bad_spec", `session.open ${name}: number`);
        checkSpec(req, `session.open ${name}`);
        const callsign = req.number ? firstFree(name) : `${name}@${host.machine}`;
        if (host.session(callsign)) throw refuse("name_taken", `session.open: ${callsign} уже есть`);
        const where = `session.open ${callsign}`;
        const wrong = (k: string, type: string) => req[k] !== undefined && typeof req[k] !== type;
        for (const [k, type] of [["mkdir", "boolean"], ["resume", "string"], ["fork", "boolean"], ["point", "number"]]) if (wrong(k, type)) throw refuse("bad_spec", `${where}: ${k}`);
        const cwd = typeof dir === "string" ? clientPath(dir, home) : null;
        if (!cwd) throw refuse("bad_dir", `${where}: папка ${JSON.stringify(dir)} не от ~ и не полная`);
        const there = statSync(cwd, { throwIfNoEntry: false })?.isDirectory();
        if (!there && !(req.mkdir && buildable(cwd))) throw refuse("bad_dir", `${where}: папки ${dir} нет`);
        opening.add(callsign);
        const s = await starting(callsign, () =>
          host.open({ callsign, cwd, resume: (req.resume as string) || undefined, fork: req.fork as boolean | undefined, point: req.point as number | undefined, mkdir: !there, opening: { ...req, from: ctx.from } }),
        ).finally(() => opening.delete(callsign));
        const slot = (s.field("slot") as { name?: string } | undefined)?.name ?? null;
        ledger("session.opened", callsign, `${callsign} создана · ${dir}${slot ? ` · слот ${slot}` : ""}`, ctx.from);
        return { callsign, session_id: s.info.session_id, slot };
      },

      async "session.update"(req) {
        const s = session(req);
        const { callsign } = s.info;
        checkSpec(req, `session.update ${callsign}`);
        const given = (k: string) => req[k] !== undefined;
        const running = live(s);
        const now: string[] = [];
        if (given("model") && running) await sdk(s, "setModel", req.model);
        const flags: Record<string, unknown> = {};
        if (given("effort")) flags.effortLevel = req.effort;
        for (const [k, key] of Object.entries(SETTING)) if (given(k)) flags[key] = req[k];
        if (Object.keys(flags).length && running) await sdk(s, "applyFlagSettings", flags);
        const fields = ["model", "effort", "fast", "style", "thinking"].filter(given);
        if (fields.length) s.store<Spec>().update((cur) => ({ ...cur, ...Object.fromEntries(fields.map((k) => [k, req[k]])) }));
        if (running) now.push(...fields);
        if (given("title")) {
          await sdk(s, "renameSession", req.title);
          now.push("title");
        }
        s.refresh();
        return { now };
      },

      async "session.call"(req) {
        const s = session(req);
        const { callsign } = s.info;
        const { method, args = [] } = req;
        if (typeof method !== "string" || !CALLABLE.has(method)) throw refuse("unknown_method", `session.call ${callsign}: ${String(method)} — нет в списке открытых`);
        if (!Array.isArray(args)) throw refuse("bad_spec", `session.call ${callsign}: args не массив`);
        if (!live(s)) throw refuse("stopped", `session.call ${callsign}: ${method} — сессия ${s.state}`);
        return sdk(s, method, ...args);
      },

      async "session.spec"(req) {
        const s = session(req);
        const spec = specOf(s);
        const info = (await sdk(s, "getSessionInfo")) as { customTitle?: string; summary?: string } | undefined;
        return { dir: tildePath(s.info.cwd, home), model: spec.model ?? null, effort: spec.effort ?? null, title: info?.customTitle ?? info?.summary ?? null };
      },

      async "session.stop"(req) {
        await session(req).stop();
      },

      async "session.start"(req) {
        const s = session(req);
        const { point } = req;
        if (point !== undefined && typeof point !== "number") throw refuse("bad_spec", `session.start ${s.info.callsign}: point`);
        await starting(s.info.callsign, () => s.start(point === undefined ? undefined : { point }));
      },

      async "session.remove"(req, ctx) {
        const s = session(req);
        const { after_turn: afterTurn } = req;
        if (afterTurn !== undefined && afterTurn !== true) throw refuse("bad_spec", `session.remove ${s.info.callsign}: after_turn`);
        if (afterTurn && ["starting", "busy", "waiting"].includes(s.state)) {
          s.store<Spec>().update((cur) => ({ ...cur, remove_after_turn: ctx.from }));
          return { after_turn: true };
        }
        await forget(s, ctx.from);
        return undefined;
      },
    },
  };
}
