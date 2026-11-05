import { statSync } from "node:fs";
import { homedir } from "node:os";
import { clientPath, isRefusal, refuse, tildePath } from "@switchboard/host";
import type { Frame, Host, Module, QueryPart, Session } from "@switchboard/host";

/** Раздел сессии. mode лежит только не по умолчанию. */
type Spec = { model?: string; effort?: string; fast?: boolean; style?: string; thinking?: boolean; parent?: string; mode?: string; remove_after_turn?: string };

const DEFAULT_MODE = "bypassPermissions";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LIVE = new Set(["idle", "busy", "waiting"]);
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

export function make({ home = homedir() }: { home?: string } = {}): Module {
  let host: Host;
  /** Открываются сейчас: имя занято до записи ядра, первому старту — заголовок. */
  const opening = new Set<string>();

  const ledger = (ev: string, callsign: string, text: string, by: unknown) => host.emit({ type: "ledger.add", to: ".ledger", ev, text, by, machine: host.machine, callsign } as Frame);
  const session = (req: Frame) => host.session(req.callsign as string)!;

  const taken = (callsign: string) => !!host.session(callsign) || opening.has(callsign);
  function firstFree(name: string): string {
    let n = 1;
    while (taken(`${name}-${n}@${host.machine}`)) n++;
    return `${name}-${n}@${host.machine}`;
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
      if (opening.has(s.info.callsign)) part.title = s.info.callsign.split("@")[0];
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
        const { subtype } = msg as { subtype?: string };
        if (msg.type !== "system" || (subtype !== "init" && subtype !== "status") || typeof mode !== "string") return;
        s.store<Spec>().update(({ mode: _, ...rest } = {}) => (mode === DEFAULT_MODE ? rest : { ...rest, mode }));
      },
      state(s, state) {
        const by = specOf(s).remove_after_turn;
        if (state === "idle" && by) return forget(s, by);
      },
    },

    requests: {
      async "session.open"(req, ctx) {
        const { name, dir } = req;
        if (typeof name !== "string" || !NAME.test(name)) throw refuse("bad_name", `session.open: имя ${JSON.stringify(name)}`);
        if (req.number !== undefined && typeof req.number !== "boolean") throw refuse("bad_spec", `session.open ${name}: number`);
        const where = `session.open ${name}@${host.machine}`;
        const wrong = (k: string, type: string) => {
          if (req[k] !== undefined && typeof req[k] !== type) throw refuse("bad_spec", `${where}: ${k}`);
        };
        const cwd = typeof dir === "string" ? clientPath(dir, home) : null;
        if (!cwd) throw refuse("bad_dir", `${where}: папка ${JSON.stringify(dir)} не от ~ и не полная`);
        wrong("mkdir", "boolean");
        const there = !!statSync(cwd, { throwIfNoEntry: false })?.isDirectory();
        if (!there && !req.mkdir) throw refuse("bad_dir", `${where}: папки ${dir} нет`);
        checkSpec(req, `session.open ${name}`);
        wrong("resume", "string");
        wrong("fork", "boolean");
        wrong("point", "number");
        const callsign = req.number ? firstFree(name) : `${name}@${host.machine}`;
        if (taken(callsign)) throw refuse("name_taken", `session.open: ${callsign} уже есть`);
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
        const fields = ["model", "effort", "fast", "style", "thinking"].filter(given);
        // запись — после согласия SDK: отвергнутая модель проваливала бы каждый ход после resume
        const save = (keys: string[]) => s.store<Spec>().update((cur) => ({ ...cur, ...Object.fromEntries(keys.map((k) => [k, req[k]])) }));
        const now: string[] = [];
        if (LIVE.has(s.state)) {
          if (given("model")) {
            await sdk(s, "setModel", req.model);
            save(["model"]);
          }
          const flags = fields.filter((k) => k !== "model");
          if (flags.length) {
            await sdk(s, "applyFlagSettings", Object.fromEntries(flags.map((k) => [k === "effort" ? "effortLevel" : SETTING[k], req[k]])));
            save(flags);
          }
          now.push(...fields);
        } else if (fields.length) save(fields);
        // поля model и effort меняются вне событий SDK: roster узнаёт сразу
        if (fields.length) s.refresh();
        if (given("title")) {
          await sdk(s, "renameSession", req.title);
          now.push("title");
        }
        return { now };
      },

      async "session.call"(req) {
        const s = session(req);
        const { callsign } = s.info;
        const { method, args = [] } = req;
        if (typeof method !== "string" || !CALLABLE.has(method)) throw refuse("unknown_method", `session.call ${callsign}: ${String(method)} — нет в списке открытых`);
        if (!Array.isArray(args)) throw refuse("bad_spec", `session.call ${callsign}: args не массив`);
        if (!LIVE.has(s.state)) throw refuse("stopped", `session.call ${callsign}: ${method} — сессия ${s.state}`);
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
