// Сессии по запросу: спецификация в разделе сессии, всё остальное — у ядра и SDK.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { clientPath, isRefusal, refuse, tildePath } from "@switchboard/host";
import { nameOf, withLimit } from "@switchboard/protocol";
import type { Frame, Host, Module, OpenSpec, QueryPart, Session } from "@switchboard/host";

/** Раздел сессии. Режим лежит только не по умолчанию. */
type Part = { model?: string; effort?: string; fast?: boolean; style?: string; thinking?: boolean; parent?: string; wing?: boolean; mode?: string; remove_after_turn?: string };

const MODE = "bypassPermissions";
/** Предел шага перечитывания: как ступень остановки сессии. */
const RELOAD_MS = 30_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EFFORTS: unknown[] = ["low", "medium", "high", "xhigh", "max"];
const CALLS = new Set<unknown>([
  "interrupt", "getContextUsage", "supportedCommands", "supportedModels", "supportedAgents", "mcpServerStatus", "toggleMcpServer", "reconnectMcpServer", "rewindFiles", "stopTask", "backgroundTasks",
  "askSideQuestion", "getTaskOutput", "cancelAsyncMessage", "mcpAuthenticate", "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET", "getStatus", "getHooksListing", "setPermissionMode", "listPermissionRules",
]);

const isText = (v: unknown) => typeof v === "string" && v !== "";
const isFlag = (v: unknown) => typeof v === "boolean";
/** Поля спецификации: значение годно? title в раздел не идёт: заголовок живёт в файле разговора. */
const SPEC = { model: isText, effort: (v: unknown) => EFFORTS.includes(v), fast: isFlag, style: isText, thinking: isFlag, title: isText };
const OPEN_TYPES = { mkdir: "boolean", resume: "string", fork: "boolean", point: "number" };
const STORED = ["model", "effort", "fast", "style", "thinking"] as const;
/** Поле спецификации → ключ настроек SDK. */
const SETTINGS = { effort: "effortLevel", fast: "fastMode", style: "outputStyle", thinking: "alwaysThinkingEnabled" } as const;

const given = <T extends object>(o: T, keys: readonly (keyof T)[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) as Partial<T>;
const settingsOf = (o: Part, keys: Array<keyof typeof SETTINGS>) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [SETTINGS[k], o[k]]));
const isLive = (s: Session) => s.state === "idle" || s.state === "busy" || s.state === "waiting";
const partOf = (s: Session): Part => s.store<Part>().get() ?? {};
const merge = (s: Session, part: Part) => s.store<Part>().update((cur) => ({ ...cur, ...part }));

function checkSpec(f: Frame, where: string): void {
  for (const [key, valid] of Object.entries(SPEC)) if (f[key] !== undefined && !valid(f[key])) throw refuse("bad_spec", `${where}: ${key} = ${JSON.stringify(f[key])}`);
}

async function sdk(s: Session, method: string, ...args: unknown[]): Promise<unknown> {
  try {
    return await s.sdk(method, ...args);
  } catch (e) {
    throw refuse("sdk_error", `${s.info.callsign}: ${method} — ${(e as Error).message}`);
  }
}

/** Шаг перечитывания: Claude не ответил — отказ словом, как любой сбой SDK. */
const step = (s: Session, method: string, ...args: unknown[]): Promise<unknown> =>
  withLimit(sdk(s, method, ...args), RELOAD_MS, () => {
    throw refuse("sdk_error", `${s.info.callsign}: ${method} — Claude не ответил за ${RELOAD_MS / 1000} с`);
  });

/** Скилы и агенты с диска, затем внешние серверы кусочков: перечитывание плагинов запущенные серверы не трогает. */
async function reload(s: Session): Promise<void> {
  const { mcpServers } = (await step(s, "reloadPlugins")) as { mcpServers: Array<{ name: string; status: string }> };
  await Promise.all(mcpServers.filter((m) => m.name.startsWith("plugin:") && m.status === "connected").map((m) => step(s, "reconnectMcpServer", m.name)));
}

/** Подъём процесса: отказ модуля идёт как есть, остальное — open_failed. */
async function raising<T>(callsign: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    throw isRefusal(e) ? e : refuse("open_failed", `${callsign}: ${(e as Error).message}`);
  }
}

export function make({ home = homedir() }: { home?: string } = {}): Module {
  let host: Host;
  /** открытия запросом: ядро ещё не внесло имя в список, заголовок ставится только им */
  const opening = new Set<string>();

  /** callsign, которого нет на машине, отказывает ядро; кадр без него доходит сюда. */
  const sessionOf = (f: Frame) => {
    const s = host.session(f.callsign as string);
    if (!s) throw refuse("bad_spec", `${f.type}: нет callsign`);
    return s;
  };
  const isTaken = (callsign: string) => opening.has(callsign) || !!host.session(callsign);
  /** Ведомый этой сессии: у него одного wing и parent — она. */
  const wingOf = (lead: Session) =>
    host.sessions().flatMap((x) => host.session(x.callsign) ?? []).find((s) => {
      const { wing, parent } = partOf(s);
      return wing && parent === lead.info.callsign;
    });
  const ledger = (ev: string, callsign: string, text: string, by: unknown) => host.emit({ type: "ledger.add", to: ".ledger", ev, machine: host.machine, callsign, text, by });

  /** Снаружи пара — одна сессия: ведущий уходит вместе с ведомым, ведомый первым. */
  async function remove(s: Session, by: unknown): Promise<void> {
    const { callsign } = s.info;
    const wing = wingOf(s);
    if (wing) await remove(wing, by);
    await s.remove();
    ledger("session.removed", callsign, `${callsign} забыта`, by);
  }

  function callsignOf(f: Frame, name: string): string {
    const at = (n: string) => `${n}@${host.machine}`;
    if (f.number) {
      let n = 1;
      while (isTaken(at(`${name}-${n}`))) n++;
      return at(`${name}-${n}`);
    }
    if (isTaken(at(name))) throw refuse("name_taken", `session.open: ${at(name)} уже есть`);
    return at(name);
  }

  function folderOf(f: Frame, callsign: string): string {
    const { dir } = f;
    const cwd = typeof dir === "string" ? clientPath(dir, home) : null;
    if (!cwd) throw refuse("bad_dir", `session.open ${callsign}: папка ${JSON.stringify(dir)} не от ~ и не полная`);
    const found = statSync(cwd, { throwIfNoEntry: false });
    if (found ? !found.isDirectory() : !f.mkdir) throw refuse("bad_dir", `session.open ${callsign}: папки ${String(dir)} нет`);
    return cwd;
  }

  /** Ведущий запроса wing_of: на этой машине, сам не ведомый, ведомого у него нет. */
  function leadOf(f: Frame): Session {
    const { wing_of: id, name, dir } = f;
    if (typeof id !== "string") throw refuse("bad_spec", "session.open: wing_of — callsign ведущего");
    if (name !== undefined || dir !== undefined) throw refuse("bad_spec", `session.open ведомого ${id}: имя и папку выводит машина`);
    const lead = host.session(id);
    if (!lead) throw refuse("offline", `session.open: ведущего ${id} нет на ${host.machine}`);
    if (partOf(lead).wing) throw refuse("bad_spec", `session.open: ${id} сам ведомый`);
    const wing = wingOf(lead);
    if (wing) throw refuse("has_wing", `session.open: у ${id} уже есть ведомый ${wing.info.callsign}`);
    return lead;
  }

  async function open(f: Frame): Promise<unknown> {
    const lead = f.wing_of === undefined ? undefined : leadOf(f);
    const { number } = f;
    const name = lead ? `${lead.info.callsign.split("@")[0]}-wing` : f.name;
    if (typeof name !== "string" || !NAME.test(name)) throw refuse("bad_name", `session.open: имя ${JSON.stringify(name)}`);
    if (number !== undefined && !isFlag(number)) throw refuse("bad_spec", `session.open ${name}: number`);
    checkSpec(f, `session.open ${name}`);
    const callsign = callsignOf(f, name);
    for (const [key, type] of Object.entries(OPEN_TYPES)) if (f[key] !== undefined && typeof f[key] !== type) throw refuse("bad_spec", `session.open ${callsign}: ${key}`);
    const cwd = lead ? lead.info.cwd : folderOf(f, callsign);

    opening.add(callsign);
    try {
      const s = await raising(callsign, () => host.open({ ...f, callsign, cwd, opening: f } as unknown as OpenSpec));
      const slot = (s.field("slot") as { name?: string } | undefined)?.name ?? null;
      ledger("session.opened", callsign, `${callsign} создана · ${lead ? tildePath(cwd, home) : String(f.dir)}${slot ? ` · слот ${slot}` : ""}`, f.from);
      return { callsign, session_id: s.info.session_id, slot };
    } finally {
      opening.delete(callsign);
    }
  }

  return {
    start: (h) => void (host = h),
    requests: {
      "session.open": open,
      async "session.update"(f) {
        const s = sessionOf(f);
        const { callsign } = s.info;
        checkSpec(f, `session.update ${callsign}`);
        const spec = given(f as Part, STORED);
        const flags = (Object.keys(SETTINGS) as Array<keyof typeof SETTINGS>).filter((k) => spec[k] !== undefined);
        const now: string[] = [];
        // запись — после согласия SDK: отвергнутая модель проваливала бы каждый ход после resume
        if (isLive(s)) {
          if (spec.model !== undefined) {
            await sdk(s, "setModel", spec.model);
            merge(s, { model: spec.model });
          }
          if (flags.length) await sdk(s, "applyFlagSettings", settingsOf(spec, flags));
          now.push(...Object.keys(spec));
        }
        if (Object.keys(spec).length) {
          merge(s, spec);
          s.refresh();
        }
        if (f.title !== undefined) {
          await sdk(s, "renameSession", f.title);
          now.push("title");
        }
        return { now };
      },

      "session.call"(f) {
        const s = sessionOf(f);
        const { method, args = [] } = f;
        const where = `session.call ${s.info.callsign}`;
        if (!CALLS.has(method)) throw refuse("unknown_method", `${where}: ${String(method)} — нет в списке открытых`);
        if (!Array.isArray(args)) throw refuse("bad_spec", `${where}: args не массив`);
        if (!isLive(s)) throw refuse("stopped", `${where}: ${String(method)} — сессия ${s.state}`);
        return sdk(s, method as string, ...args);
      },

      "session.reload"(f) {
        const s = sessionOf(f);
        if (!isLive(s)) throw refuse("stopped", `session.reload ${s.info.callsign}: сессия ${s.state}`);
        return reload(s);
      },

      async "session.spec"(f) {
        const s = sessionOf(f);
        const info = (await sdk(s, "getSessionInfo")) as { customTitle?: string; summary?: string } | undefined;
        const { model = null, effort = null } = partOf(s);
        return { dir: tildePath(s.info.cwd, home), model, effort, title: info?.customTitle ?? info?.summary ?? null };
      },

      async "session.start"(f) {
        const s = sessionOf(f);
        const { callsign } = s.info;
        const { point } = f;
        if (point !== undefined && typeof point !== "number") throw refuse("bad_spec", `session.start ${callsign}: point`);
        await raising(callsign, () => s.start({ point }));
        const wing = wingOf(s);
        // точка — только ведущего: разговор ведомого своей точки не называл
        if (wing) await raising(wing.info.callsign, () => wing.start());
      },

      async "session.remove"(f) {
        const s = sessionOf(f);
        const { after_turn: afterTurn, from } = f;
        if (afterTurn !== undefined && afterTurn !== true) throw refuse("bad_spec", `session.remove ${s.info.callsign}: after_turn`);
        // starting: после перезапуска Host ход идёт у держателя, вызов инструмента приходит до готовности
        if (afterTurn && (s.state === "starting" || s.state === "busy" || s.state === "waiting")) {
          merge(s, { remove_after_turn: from as string });
          return { after_turn: true };
        }
        return remove(s, from);
      },

      async "session.stop"(f) {
        const s = sessionOf(f);
        await wingOf(s)?.stop();
        await s.stop();
      },
    },
    fields: {
      model: (s) => partOf(s).model ?? s.info.model ?? undefined,
      effort: (s) => partOf(s).effort,
      parent: (s) => partOf(s).parent,
      wing: (s) => partOf(s).wing,
      mode: (s) => partOf(s).mode ?? MODE,
    },
    opening(s, req) {
      const lead = req.wing_of as string | undefined;
      const parent = lead ?? (req.from as string | undefined);
      const part = { ...given(req as Part, STORED), ...(parent ? { parent } : {}), ...(lead ? { wing: true } : {}) };
      if (Object.keys(part).length) s.store<Part>().set(part);
    },
    session(s): QueryPart {
      const { callsign } = s.info;
      const part = partOf(s);
      return {
        enableFileCheckpointing: true,
        permissionMode: part.mode ?? MODE,
        ...given(part, ["model", "effort"]),
        ...(opening.has(callsign) ? { title: nameOf(callsign) } : {}),
        settings: settingsOf(part, ["fast", "style", "thinking"]),
        hooks: {
          // модель сменили в claude.ai: выбор — то, что просили; resume только повторяет прежнюю
          PostModelSwitch: [
            {
              hooks: [
                async (input) => {
                  const { source, requested_model: requested } = input as unknown as { source?: string; requested_model?: string | null };
                  if (source !== "resume") {
                    s.store<Part>().update(({ model: _, ...rest } = {}) => (requested ? { ...rest, model: requested } : rest));
                  }
                  return {};
                },
              ],
            },
          ],
        },
      };
    },
    on: {
      event(s, msg) {
        const { permissionMode: mode } = msg as { permissionMode?: string };
        if (!mode || mode === (partOf(s).mode ?? MODE)) return;
        s.store<Part>().update(({ mode: _, ...rest } = {}) => (mode === MODE ? rest : { ...rest, mode }));
      },
      state(s, state) {
        const by = partOf(s).remove_after_turn;
        if (state === "idle" && by) return remove(s, by);
      },
    },
  };
}
