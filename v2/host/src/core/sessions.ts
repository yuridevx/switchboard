// Запросы ядра о сессиях: открыть, изменить документ, остановить, запустить, убрать, проход к SDK. Родитель и пара — здесь.
import { kindOf, ledgerAdd, Refusal, sessionRemove, sessionStart, sessionStop, type Spec, type SpecPatch } from "@sb/protocol";
import type { Ctx, Module, SessionApi } from "./contract.ts";
import { MODES, type Kernel } from "./kernel.ts";
import { quiet } from "./session.ts";

/** Ключи документа, которыми владеет ядро. */
export const CORE_KEYS = ["name", "cwd", "model", "effort", "mode", "parent", "wing", "project"] as const;

/** Имя запроса session.call → метод SDK. */
const SDK: Record<string, string> = {
  interrupt: "interrupt", contextUsage: "getContextUsage", commands: "supportedCommands", models: "supportedModels", agents: "supportedAgents",
  mcpStatus: "mcpServerStatus", mcpToggle: "toggleMcpServer", mcpReconnect: "reconnectMcpServer", mcpAuthenticate: "mcpAuthenticate",
  rewindFiles: "rewindFiles", tasks: "backgroundTasks", taskStop: "stopTask", taskOutput: "getTaskOutput", sideQuestion: "askSideQuestion",
  cancelMessage: "cancelAsyncMessage", status: "getStatus", hooks: "getHooksListing",
};
/** Предел шага перечитывания: как ступень остановки сессии. */
const RELOAD_MS = 30_000;

const live = (s: SessionApi) => s.state === "idle" || s.state === "busy" || s.state === "waiting";

async function sdk(s: SessionApi, method: string, ...args: unknown[]): Promise<unknown> {
  try {
    return await s.sdk(method, ...args);
  } catch (e) {
    throw new Refusal("sdk_error", `${s.callsign}: ${method} — ${(e as Error).message}`);
  }
}

export function coreModule(k: Kernel): Module {
  const self: Module = { name: "host" };
  const session = (callsign: string) => k.sessions.get(callsign)!;
  const ledger = (what: string, callsign: string, text: string) => quiet(k.call(ledgerAdd, { what, machine: k.machine, callsign, text }).catch(() => {}));
  /** Запрос паре: ведомый на этой или на другой машине — одна дорога. */
  const toWing = (def: typeof sessionStop, wing: string | undefined, ctx: Ctx) =>
    wing ? k.call(def, { to: wing }, { from: ctx.from, trace: ctx.trace }).catch((e: unknown) => ctx.log.warn("wing", { to: wing, type: def.name, why: (e as Error).message })) : undefined;
  const text = (v: unknown) => {
    if (typeof v !== "string" || !v) throw new Refusal("bad_spec", "значение — непустая строка");
  };

  self.requests = {
    async "session.open"({ spec, prompt }: { spec: Spec; prompt?: string }, ctx) {
      // сессия, открытая сессией, — её дочь: итог хода уйдёт родителю
      const child = kindOf(ctx.from) === "session" && !spec.parent ? { ...spec, parent: ctx.from } : spec;
      const s = await k.open(child, { by: ctx.from, prompt });
      ledger("session.opened", s.callsign, `${s.callsign} открыта · ${spec.cwd}`);
      return { callsign: s.callsign };
    },

    async "session.update"({ to, patch }: { to: string; patch: SpecPatch }, ctx) {
      const s = session(to);
      const view = s.facade(self);
      const keys = Object.keys(patch).filter((key) => (patch as Record<string, unknown>)[key] !== undefined);
      await k.checkSpec(patch as Record<string, unknown>, s);
      const cwd = patch.cwd === undefined ? s.rec.cwd : k.folder(patch.cwd);
      // запись — после согласия SDK: отвергнутая модель проваливала бы каждый ход после resume
      if (live(view)) {
        if (patch.model !== undefined) await sdk(view, "setModel", patch.model);
        if (patch.effort !== undefined) await sdk(view, "applyFlagSettings", { effortLevel: patch.effort });
        if (patch.mode !== undefined) await sdk(view, "setPermissionMode", MODES[patch.mode]);
      }
      s.rec.spec = { ...s.rec.spec, ...patch };
      s.rec.cwd = cwd;
      k.save();
      for (const m of k.mods) if (m.applied && m !== self) await m.applied(s.facade(m), keys);
      if (patch.cwd !== undefined) quiet(s.restart());
      s.sync();
      ctx.log.info("update", { callsign: to, keys });
      return {};
    },

    async "session.stop"({ to }: { to: string }, ctx) {
      const s = session(to);
      await toWing(sessionStop, s.rec.spec.wing, ctx);
      await s.stop();
      return {};
    },

    async "session.start"({ to }: { to: string }, ctx) {
      const s = session(to);
      try {
        await s.start();
      } catch (e) {
        throw new Refusal("open_failed", `${to}: ${(e as Error).message}`);
      }
      await toWing(sessionStart, s.rec.spec.wing, ctx);
      return {};
    },

    async "session.remove"({ to }: { to: string }, ctx) {
      const s = session(to);
      // снаружи пара — одна сессия: ведущий уходит вместе с ведомым, ведомый первым
      await toWing(sessionRemove, s.rec.spec.wing, ctx);
      await s.remove();
      ledger("session.removed", to, `${to} убрана`);
      return {};
    },

    async "session.call"({ to, method, args }: { to: string; method: string; args?: unknown }) {
      const s = session(to).facade(self);
      if (!live(s)) throw new Refusal("stopped", `session.call ${to}: ${method} — сессия ${s.state}`);
      const list = args === undefined ? [] : Array.isArray(args) ? args : [args];
      if (method === "reload") {
        // скилы и агенты с диска, затем внешние серверы плагинов: перечитывание запущенные серверы не трогает
        const step = (name: string, ...a: unknown[]) =>
          Promise.race([sdk(s, name, ...a), new Promise((_, rej) => setTimeout(() => rej(new Refusal("sdk_error", `${to}: ${name} — Claude не ответил за ${RELOAD_MS / 1000} с`)), RELOAD_MS))]);
        const { mcpServers = [] } = ((await step("reloadPlugins")) ?? {}) as { mcpServers?: Array<{ name: string; status: string }> };
        await Promise.all(mcpServers.filter((m) => m.name.startsWith("plugin:") && m.status === "connected").map((m) => step("reconnectMcpServer", m.name)));
        return {};
      }
      return sdk(s, SDK[method]!, ...list);
    },
  };

  self.spec = {
    name: text,
    cwd: (v) => void k.folder(v as string),
    model: text,
    effort: () => {},
    mode: () => {},
    parent: () => {},
    wing: () => {},
    project: () => {},
  };

  self.compose = (s) => k.corePart(s);

  self.on = {
    // режим сменили в самой сессии — документ следует за ней
    event(s, m) {
      const mode = (m as { permissionMode?: string }).permissionMode;
      if (!mode) return;
      const name = Object.keys(MODES).find((key) => MODES[key] === mode);
      const rec = k.sessions.get(s.callsign)?.rec;
      if (!name || !rec || (rec.spec.mode ?? "all") === name) return;
      rec.spec = { ...rec.spec, mode: name as Spec["mode"] };
      k.save();
    },
  };
  return self;
}
