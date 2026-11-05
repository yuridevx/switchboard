// Модуль manage: сессии по запросу — открыть, сменить модель и усилие на ходу, звать открытые методы query(),
// остановить, поднять, убрать. Всё — методами Agent SDK через ядро; поток сообщений не читает.
// Своё хранит в разделе сессии: выбор клиента, родителя — отправителя session.open — и отметку «убрать после хода».
// Папку держит ядро, слот — вход, профиль — профили, заголовок — файл разговора.
import { homedir } from "node:os";
import { isRefusal, refuse, tildePath } from "@switchboard/host";
import type { Frame, Host, Module, QueryPart, Session } from "@switchboard/host";
import { parseOpen, pickCallsign } from "./open.ts";
import { FLAGS, settingsOf, specOf } from "./spec.ts";
import type { Spec } from "./spec.ts";

/** Раздел сессии. */
type Rec = Spec & { parent?: string; remove_after_turn?: string; mode?: string };

/** Режим новой сессии и сессии без отметки: решение устава. */
const BYPASS = "bypassPermissions";

/** Методы query(), которые клиент зовёт по имени. Остальные — unknown_method, метод не вызван. */
const OPEN = new Set([
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
  "askSideQuestion",
  "getTaskOutput",
  "cancelAsyncMessage",
  "mcpAuthenticate",
  "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET",
  "getStatus",
  "getHooksListing",
  "setPermissionMode",
  "listPermissionRules",
]);

const LIVE = new Set(["idle", "busy", "waiting"]);
const IN_TURN = new Set(["busy", "waiting", "starting"]);

const rec = (s: Session) => s.store<Rec>().get() ?? {};
const specIn = (s: Session): Spec => {
  const { parent: _p, remove_after_turn: _r, mode: _m, ...spec } = rec(s);
  return spec;
};

/** Метод или функция SDK: отказ — слово sdk_error с причиной; модуль не выключается. */
async function sdk(s: Session, method: string, ...args: unknown[]): Promise<unknown> {
  try {
    return await s.sdk(method, ...args);
  } catch (e) {
    throw refuse("sdk_error", `${s.info.callsign}: ${method} — ${(e as Error).message}`);
  }
}

export function make(o: { home?: string } = {}): Module {
  const home = o.home ?? homedir();
  let host!: Host;
  /** Имена, которые открываются сейчас: заняты до записи ядра. */
  const opening = new Set<string>();

  /** Кадр без ответа прямо Worker'у; не дошёл — заметку пишет ядро. */
  const ledger = (ev: string, text: string, by: string | undefined, callsign: string) => void host.emit({ type: "ledger.add", to: ".ledger", ev, text, ...(by ? { by } : {}), machine: host.machine, callsign });

  async function remove(s: Session, by: string | undefined): Promise<void> {
    const { callsign } = s.info;
    await s.remove();
    ledger("session.removed", `${callsign} забыта`, by, callsign);
  }

  /** Модель сменили в claude.ai или командой /model — выбор берёт новую, иначе resume вернул бы прежнюю. */
  const onModelSwitch = (s: Session) => async (input: unknown) => {
    const { source, requested_model: model } = input as { source?: string; requested_model?: string | null };
    if (source !== "resume") {
      s.store<Rec>().update((cur = {}) => {
        const { model: _old, ...rest } = cur;
        return model ? { ...rest, model } : rest;
      });
    }
    return {};
  };

  return {
    start(h) {
      host = h;
    },

    // запись новой сессии — из запроса открытия; родитель — его отправитель: сессия, устройство или машина
    opening(s, req) {
      const r: Rec = { ...specOf(req as Frame), ...(typeof req.from === "string" ? { parent: req.from } : {}) };
      if (Object.keys(r).length) s.store<Rec>().set(r);
    },

    session(s) {
      const spec = specIn(s);
      const { effortLevel: _inQuery, ...settings } = settingsOf(spec);
      const { callsign } = s.info;
      const mode = rec(s).mode;
      return {
        enableFileCheckpointing: true,
        hooks: { PostModelSwitch: [{ hooks: [onModelSwitch(s)] }] },
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.effort ? { effort: spec.effort } : {}),
        // режим переживает новый процесс; без отметки — режим устава у ядра
        ...(mode ? { permissionMode: mode } : {}),
        ...(Object.keys(settings).length ? { settings } : {}),
        // заголовок — только при первом старте
        ...(opening.has(callsign) ? { title: callsign.slice(0, callsign.indexOf("@")) } : {}),
      } as QueryPart;
    },

    fields: {
      model: (s) => specIn(s).model ?? s.info.model ?? undefined,
      effort: (s) => specIn(s).effort,
      parent: (s) => rec(s).parent,
      mode: (s) => rec(s).mode ?? BYPASS,
    },

    requests: {
      async "session.open"(req, ctx) {
        const { machine } = ctx.host;
        const { name, numbered, cwd, make: mkdir, dir } = parseOpen(req, machine, home);
        const callsign = pickCallsign(name, numbered, machine, (cs) => !!ctx.host.session(cs) || opening.has(cs));
        opening.add(callsign);
        try {
          // профиль, слот и прочее читают свои владельцы из запроса открытия; папку создаёт ядро после сборки
          const s = await ctx.host
            .open({
              callsign,
              cwd,
              ...(mkdir ? { mkdir } : {}),
              opening: { ...req, ...(ctx.from ? { from: ctx.from } : {}) },
              ...(req.resume !== undefined ? { resume: req.resume as string } : {}),
              ...(req.fork !== undefined ? { fork: req.fork as boolean } : {}),
              ...(req.point !== undefined ? { point: req.point as number } : {}),
            })
            .catch((e: unknown) => {
              throw isRefusal(e) ? e : refuse("open_failed", `${callsign}: ${(e as Error).message}`);
            });
          const slot = (s.field("slot") as { name: string } | undefined)?.name ?? null;
          ledger("session.opened", `${callsign} создана · ${dir}${slot ? ` · слот ${slot}` : ""}`, ctx.from, callsign);
          return { callsign, session_id: s.info.session_id, slot };
        } finally {
          opening.delete(callsign);
        }
      },

      async "session.update"(req, { host: h }) {
        const s = h.session(req.callsign as string)!;
        const spec = specOf(req);
        if (Object.keys(spec).length) {
          s.store<Rec>().update((cur = {}) => ({ ...cur, ...spec }));
          // поля model и effort меняются вне событий SDK — roster узнаёт сразу
          s.refresh();
        }
        const now: string[] = [];
        if (LIVE.has(s.state)) {
          if (spec.model !== undefined) {
            await sdk(s, "setModel", spec.model);
            now.push("model");
          }
          const settings = settingsOf(spec);
          if (Object.keys(settings).length) {
            await sdk(s, "applyFlagSettings", settings);
            now.push(...FLAGS.filter((k) => spec[k] !== undefined));
          }
        }
        if (typeof req.title === "string") {
          await sdk(s, "renameSession", req.title);
          now.push("title");
        }
        return { now };
      },

      async "session.call"(req, { host: h }) {
        const s = h.session(req.callsign as string)!;
        const { callsign } = s.info;
        const { method, args = [] } = req;
        if (typeof method !== "string" || !OPEN.has(method)) throw refuse("unknown_method", `session.call ${callsign}: ${String(method)} — нет в списке открытых`);
        if (!LIVE.has(s.state)) throw refuse("stopped", `session.call ${callsign}: ${method} — сессия ${s.state}`);
        if (!Array.isArray(args)) throw refuse("bad_spec", `session.call ${callsign}: args не массив`);
        return sdk(s, method, ...args);
      },

      async "session.spec"(req, { host: h }) {
        const s = h.session(req.callsign as string)!;
        const { model = null, effort = null } = specIn(s);
        const info = (await sdk(s, "getSessionInfo")) as { customTitle?: string; summary?: string } | undefined;
        return { dir: tildePath(s.info.cwd, home), model, effort, title: info?.customTitle ?? info?.summary ?? null };
      },

      async "session.stop"(req, { host: h }) {
        await h.session(req.callsign as string)!.stop();
      },

      async "session.start"(req, { host: h }) {
        const s = h.session(req.callsign as string)!;
        const { callsign } = s.info;
        if (req.point !== undefined && typeof req.point !== "number") throw refuse("bad_spec", `session.start ${callsign}: point`);
        await s.start(req.point !== undefined ? { point: req.point as number } : undefined).catch((e: Error) => {
          throw refuse("open_failed", `${callsign}: ${e.message}`);
        });
      },

      async "session.remove"(req, ctx) {
        const callsign = req.callsign as string;
        const s = ctx.host.session(callsign)!;
        if (req.after_turn !== undefined && req.after_turn !== true) throw refuse("bad_spec", `session.remove ${callsign}: after_turn`);
        // после хода: отметка в разделе сессии переживает перезапуск Host; убирает конец хода
        if (req.after_turn === true && IN_TURN.has(s.state)) {
          s.store<Rec>().update((cur = {}) => ({ ...cur, remove_after_turn: ctx.from ?? "" }));
          return { after_turn: true };
        }
        await remove(s, ctx.from);
      },
    },

    on: {
      // режим сессии виден только в кадрах SDK: init в начале хода и status при смене; запоминается и для простаивающей сессии.
      // Проба настоящего процесса 4 нояб.: status приходит в той же миллисекунде, что возврат setPermissionMode, раньше любого запроса разрешения
      event(s, m) {
        const { type, subtype, permissionMode } = m as { type?: string; subtype?: string; permissionMode?: unknown };
        if (type !== "system" || (subtype !== "init" && subtype !== "status") || typeof permissionMode !== "string") return;
        const mode = permissionMode === BYPASS ? undefined : permissionMode;
        if (rec(s).mode === mode) return;
        s.store<Rec>().update((cur = {}) => {
          const { mode: _old, ...rest } = cur;
          return mode ? { ...rest, mode } : rest;
        });
      },
      state(s, state) {
        const by = rec(s).remove_after_turn;
        if (state === "idle" && by !== undefined) return remove(s, by || undefined);
      },
    },
  };
}
