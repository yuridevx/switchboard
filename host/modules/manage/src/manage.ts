// Модуль manage: сессии по запросу — открыть, сменить модель и усилие на ходу, звать открытые методы query(),
// остановить, поднять, убрать. Всё — методами Agent SDK через ядро; поток сообщений не читает.
// Своё хранит в разделе сессии: спецификацию — что выбрал клиент (модель, усилие, флаги ответа), кто открыл сессию
// (родитель) и отметку «убрать после хода». Папку держит ядро, слот — slots, профиль — profiles, заголовок — файл разговора.
import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { clientPath, refuse, tildePath } from "@switchboard/host";
import type { Ctx, Frame, Host, Module, QueryPart, Session } from "@switchboard/host";

/** Спецификация сессии: выбор клиента. Нет поля — значение по умолчанию claude. */
export type Spec = { model?: string; effort?: string; fast?: boolean; style?: string; thinking?: boolean };
/** Раздел сессии: спецификация, родитель — отправитель session.open (сессия, устройство или машина), «убрать после хода». */
type Rec = Spec & { parent?: string; remove_after_turn?: string; mode?: string };
/** Режим новой сессии и сессии без отметки: решение устава. */
const BYPASS = "bypassPermissions";

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

const EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Флаги ответа → ключ settings в applyFlagSettings и в query(). */
const FLAG: Record<"effort" | "fast" | "style" | "thinking", string> = { effort: "effortLevel", fast: "fastMode", style: "outputStyle", thinking: "alwaysThinkingEnabled" };

const live = (s: Session) => s.state === "idle" || s.state === "busy" || s.state === "waiting";
const inTurn = (s: Session) => s.state === "busy" || s.state === "waiting" || s.state === "starting";

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
  let host!: Host;
  /** Спецификация, заголовок и родитель новой сессии: от session.open до её первого session() внутри host.open. Имя занято, пока открывается. */
  const pending = new Map<string, { spec: Spec; title: string; parent?: string }>();

  const recOf = (s: Session) => s.store<Rec>().get() ?? {};
  const specOfSession = (s: Session): Spec => {
    const { parent: _p, remove_after_turn: _r, mode: _m, ...spec } = recOf(s);
    return spec;
  };

  /** Метод или функция SDK: отказ SDK — слово sdk_error, причина в журнале; модуль не выключается. */
  async function call(s: Session, method: string, ...args: unknown[]): Promise<unknown> {
    try {
      return await s.sdk(method, ...args);
    } catch (e) {
      throw refuse("sdk_error", `${s.info.callsign}: ${method} — ${(e as Error).message}`);
    }
  }

  function ledger(host: Host, ev: string, text: string, ctx: { from?: string }, callsign: string): void {
    const r = host.emit({ type: "ledger.add", to: ".ledger", ev, text, ...(ctx.from ? { by: ctx.from } : {}), machine: host.machine, callsign });
    if (!r.ok) host.log({ kind: "note", ev: "ledger", word: r.error, callsign, why: `${ev} не записан в журнал флота: ${r.error}` });
  }

  /** Убрать сессию и записать в журнал флота, по чьей команде. */
  async function remove(s: Session, by: string | undefined): Promise<void> {
    const callsign = s.info.callsign;
    await s.remove();
    ledger(host, "session.removed", `${callsign} забыта`, { from: by }, callsign);
  }

  /** PostModelSwitch: модель сменили в claude.ai или командой /model — спецификация берёт новую, иначе resume вернул бы прежнюю. */
  const onModelSwitch = (s: Session) => async (input: unknown) => {
    const i = input as { source?: string; requested_model?: string | null };
    if (i.source === "resume") return {};
    s.store<Rec>().update((cur = {}) => {
      const next = { ...cur };
      if (i.requested_model) next.model = i.requested_model;
      else delete next.model;
      return next;
    });
    return {};
  };

  return {
    session(s) {
      // первый старт: запись — из session.open; pending снимает сам session.open, чтобы имя было занято до записи ядра
      const first = pending.get(s.info.callsign);
      if (first) {
        const rec: Rec = { ...first.spec, ...(first.parent ? { parent: first.parent } : {}) };
        if (Object.keys(rec).length) s.store<Rec>().set(rec);
      }
      const spec = first?.spec ?? specOfSession(s);
      const mode = recOf(s).mode;
      const part: QueryPart = {
        enableFileCheckpointing: true,
        hooks: { PostModelSwitch: [{ hooks: [onModelSwitch(s)] }] },
      };
      if (spec.model) part.model = spec.model;
      if (spec.effort) part.effort = spec.effort;
      // режим переживает новый процесс; без отметки — режим устава у ядра
      if (mode) part.permissionMode = mode;
      const { effortLevel: _e, ...settings } = flags(spec);
      if (Object.keys(settings).length) part.settings = settings;
      if (first) part.title = first.title;
      return part;
    },

    fields: {
      model: (s) => specOfSession(s).model ?? s.info.model ?? undefined,
      effort: (s) => specOfSession(s).effort,
      parent: (s) => recOf(s).parent,
      mode: (s) => recOf(s).mode ?? BYPASS,
    },

    requests: {
      async "session.open"(req, ctx) {
        const { host } = ctx;
        const name = req.name;
        if (typeof name !== "string" || !NAME.test(name)) throw refuse("bad_name", `session.open: имя ${JSON.stringify(name)}`);
        if (req.number !== undefined && typeof req.number !== "boolean") throw refuse("bad_spec", `session.open ${name}: number`);
        const asked = `${name}@${host.machine}`;
        const dir = req.dir;
        const cwd = typeof dir === "string" ? clientPath(dir, home) : null;
        if (!cwd) throw refuse("bad_dir", `session.open ${asked}: папка ${JSON.stringify(dir)} не от ~ и не полная`);
        if (req.mkdir !== undefined && typeof req.mkdir !== "boolean") throw refuse("bad_spec", `session.open ${asked}: mkdir`);
        let isDir = false;
        try {
          isDir = statSync(cwd).isDirectory();
        } catch {
          // нет папки — ниже отказ или создание
        }
        // создать папку можно только по просьбе: опечатка агента даёт отказ
        if (!isDir && req.mkdir !== true) throw refuse("bad_dir", `session.open ${asked}: папки ${dir} нет`);
        const spec = specOf(req);
        if (req.resume !== undefined && typeof req.resume !== "string") throw refuse("bad_spec", `session.open ${asked}: resume`);
        if (req.fork !== undefined && typeof req.fork !== "boolean") throw refuse("bad_spec", `session.open ${asked}: fork`);
        if (req.point !== undefined && typeof req.point !== "number") throw refuse("bad_spec", `session.open ${asked}: point`);
        // имя: с number — первый свободный номер на машине (disk-full-1, disk-full-2); открываемое уже занято
        const taken = (cs: string) => !!host.session(cs) || pending.has(cs);
        let callsign = asked;
        if (req.number === true) {
          let n = 1;
          while (taken(`${name}-${n}@${host.machine}`)) n++;
          callsign = `${name}-${n}@${host.machine}`;
        } else if (taken(callsign)) throw refuse("name_taken", `session.open: ${callsign} уже есть`);
        // родитель — отправитель запроса: сессия, устройство или машина
        pending.set(callsign, { spec, title: callsign.slice(0, callsign.indexOf("@")), ...(ctx.from ? { parent: ctx.from } : {}) });
        try {
          // профиль и слот — их владельцам, до старта
          for (const [type, key] of [["session.profile", "profile"], ["session.slot", "slot"]] as const) {
            if (req[key] === undefined) continue;
            const r = await host.request(type, { callsign, [key]: req[key] });
            if (!r.ok) throw refuse(r.error, `session.open ${callsign}: ${type} — ${r.error}`);
          }
          // путь строится последним шагом перед стартом: имя занято, профиль или слот не подошли — папки не появится
          if (!isDir) {
            try {
              mkdirSync(cwd, { recursive: true });
            } catch (e) {
              throw refuse("bad_dir", `session.open ${callsign}: папка ${dir} не создана — ${(e as Error).message}`);
            }
          }
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
          }
          ledger(host, "session.opened", `${callsign} создана · ${dir}${typeof req.slot === "string" ? ` · слот ${req.slot}` : ""}`, ctx, callsign);
          return { callsign, session_id: s.info.session_id };
        } finally {
          pending.delete(callsign);
        }
      },

      async "session.update"(req, { host }) {
        const s = host.session(req.callsign as string)!;
        const spec = specOf(req);
        if (Object.keys(spec).length) {
          s.store<Rec>().update((cur = {}) => ({ ...cur, ...spec }));
          // поля model и effort меняются вне событий SDK — roster узнаёт сразу
          s.refresh();
        }
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
        return { dir: tildePath(s.info.cwd, home), model: spec.model ?? null, effort: spec.effort ?? null, title: info?.customTitle ?? info?.summary ?? null };
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
        const s = ctx.host.session(callsign)!;
        if (req.after_turn !== undefined && req.after_turn !== true) throw refuse("bad_spec", `session.remove ${callsign}: after_turn`);
        // после хода: отметка в разделе сессии — переживает перезапуск Host; убирает конец хода (on.state idle)
        if (req.after_turn === true && inTurn(s)) {
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
        const x = m as { type?: string; subtype?: string; permissionMode?: unknown };
        if (x.type !== "system" || (x.subtype !== "init" && x.subtype !== "status") || typeof x.permissionMode !== "string") return;
        const mode = x.permissionMode === BYPASS ? undefined : x.permissionMode;
        if (recOf(s).mode === mode) return;
        s.store<Rec>().update((cur = {}) => {
          const { mode: _old, ...rest } = cur;
          return mode ? { ...rest, mode } : rest;
        });
      },
      state(s, st) {
        const by = recOf(s).remove_after_turn;
        if (st === "idle" && by !== undefined) return remove(s, by || undefined);
      },
    },

    start(h) {
      host = h;
    },
  };
}
