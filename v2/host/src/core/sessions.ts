// Запросы ядра о сессиях: открыть, изменить документ, остановить, запустить, убрать, список, проход к SDK. Родитель и пара — здесь.
import { randomUUID } from "node:crypto";
import { kindOf, ledgerAdd, message, Refusal, sessionName, sessionRemove, sessionStart, sessionStop, TOOL_METHODS, type Spec, type SpecPatch } from "@sb/protocol";
import { limited } from "./clock.ts";
import { tildePath } from "./paths.ts";
import type { Ctx, Module, SessionApi } from "./contract.ts";
import { FLAGS, MODES } from "./flags.ts";
import type { Kernel } from "./kernel.ts";
import { quiet, type Session } from "./session.ts";

/** Ключи документа, которыми владеет ядро. */
export const CORE_KEYS = ["name", "cwd", "model", "effort", "mode", "fast", "style", "thinking", "title", "parent", "wing", "project"] as const;

const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
/** Имя запроса session.call → метод SDK. */
const SDK: Record<string, string> = {
  interrupt: "interrupt", contextUsage: "getContextUsage", commands: "supportedCommands", models: "supportedModels", agents: "supportedAgents",
  mcpStatus: "mcpServerStatus", mcpToggle: "toggleMcpServer", mcpReconnect: "reconnectMcpServer", mcpAuthenticate: "mcpAuthenticate",
  tasks: "backgroundTasks", taskStop: "stopTask", taskOutput: "getTaskOutput", sideQuestion: "askSideQuestion",
  status: "getStatus", hooks: "getHooksListing",
  usage: USAGE, renameSession: "renameSession", getSessionInfo: "getSessionInfo", permissionRules: "listPermissionRules",
};
/** Методы, которым процесс не нужен: читают и правят файл разговора. */
const OFFLINE = new Set(["renameSession", "getSessionInfo"]);
/** Предел шага перечитывания: как ступень остановки сессии. */
const RELOAD_MS = 30_000;
/** Предел шага отката: как ступень остановки сессии. */
const REWIND_MS = 30_000;
type Said = { uuid?: string; type?: string; parent_tool_use_id?: string | null; message?: { content?: unknown } };
/** Сообщение, к которому можно откатить: реплика человека или задача от сессии, а не ответ инструмента. */
const spoken = (m: Said) => m.type === "user" && !(Array.isArray(m.message?.content) && (m.message!.content as Array<{ type?: string }>).some((b) => b.type === "tool_result"));
/** Текст реплики человека; задача от сессии приходит в обёртке — её в поле ввода не возвращают. */
function humanText(m: Said): string | undefined {
  const c = m.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? (c as Array<{ type?: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") : "";
  return text && !text.startsWith("<") ? text : undefined;
}
/** Имя ведомого пары. */
const wingName = (lead: string) => `${sessionName(lead)}-wing`;

const live = (s: SessionApi) => s.state === "idle" || s.state === "busy" || s.state === "waiting";
const midTurn = (s: Session) => s.state === "starting" || s.state === "busy" || s.state === "waiting";

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
  /** Весть ведущему о ведомом: старт и обрыв. Не дошла — строка журнала. */
  const tellLead = (wing: Session, words: string) => {
    const lead = [...k.sessions.values()].find((x) => x.rec.spec.wing === wing.callsign);
    if (!lead || !lead.live) return;
    quiet(k.call(message, { to: lead.callsign, text: words }, { from: wing.callsign }).catch((e: unknown) => k.log.warn("wing_news", { callsign: wing.callsign, to: lead.callsign, why: (e as Error).message })));
  };

  /** Открыть ведомого: та же папка и набор, что у ведущего; задачи ему даёт ведущий. */
  async function openWing(lead: Session, ctx: Ctx): Promise<string> {
    if (lead.rec.spec.wing) throw new Refusal("has_wing", `у ${lead.callsign} уже есть ведомый ${lead.rec.spec.wing}`);
    if ([...k.sessions.values()].some((x) => x.rec.spec.wing === lead.callsign)) throw new Refusal("pair_inside", `${lead.callsign} сам ведомый: пара в паре не открывается`);
    const { name: _name, wing: _wing, parent: _parent, title: _title, ...same } = lead.rec.spec;
    const wing = await k.open({ ...same, name: wingName(lead.callsign), parent: lead.callsign }, { by: ctx.from });
    lead.rec.spec = { ...lead.rec.spec, wing: wing.callsign };
    k.save();
    lead.sync();
    wing.sync();
    ledger("session.opened", wing.callsign, `${wing.callsign} открыта ведомым ${lead.callsign}`);
    tellLead(wing, `Ведомый ${wing.callsign} открыт: задачи ему — инструмент message, итог его хода придёт сам.`);
    return wing.callsign;
  }

  async function remove(s: Session, ctx: Pick<Ctx, "from" | "trace" | "log">): Promise<void> {
    // снаружи пара — одна сессия: ведущий уходит вместе с ведомым, ведомый первым
    await toWing(sessionRemove, s.rec.spec.wing, ctx as Ctx);
    // ведомого убрали отдельно — ведущий остаётся без пары
    const lead = [...k.sessions.values()].find((x) => x.rec.spec.wing === s.callsign);
    await s.remove();
    if (lead) {
      const { wing: _wing, ...rest } = lead.rec.spec;
      lead.rec.spec = rest;
      k.save();
      lead.sync();
    }
    ledger("session.removed", s.callsign, `${s.callsign} убрана`);
  }

  self.requests = {
    async "session.open"({ spec, prompt, mkdir, number, resume, fork, pair }: { spec: Spec; prompt?: string; mkdir?: boolean; number?: boolean; resume?: string; fork?: boolean; pair?: boolean }, ctx) {
      if (fork && !resume) throw new Refusal("bad_spec", "fork — копия разговора: нужен resume с его id");
      if (spec.wing && pair) throw new Refusal("bad_spec", "pair открывает нового ведомого: wing в документе при этом не называют");
      // сессия, открытая сессией, — её дочь: итог хода уйдёт родителю
      const child = kindOf(ctx.from) === "session" && !spec.parent ? { ...spec, parent: ctx.from } : spec;
      const s = await k.open(child, { by: ctx.from, prompt, mkdir, number, resume, fork });
      ledger("session.opened", s.callsign, `${s.callsign} открыта · ${spec.cwd}`);
      const wing = pair ? await openWing(s, ctx) : undefined;
      return { callsign: s.callsign, ...(wing ? { wing } : {}) };
    },

    async "session.update"({ to, patch: given, pair }: { to: string; patch: SpecPatch & { wing?: string | null }; pair?: boolean }, ctx) {
      const s = session(to);
      const view = s.facade(self);
      // wing: null — снять ведомого; в документ null не идёт
      const dropWing = given.wing === null;
      const { wing: _wing, ...rest } = given;
      const patch = (dropWing ? rest : given) as SpecPatch;
      const keys = Object.keys(patch).filter((key) => (patch as Record<string, unknown>)[key] !== undefined);
      await k.checkSpec(patch as Record<string, unknown>, s);
      const cwd = patch.cwd === undefined ? s.rec.cwd : k.folder(patch.cwd);
      const alive = live(view);
      // запись — после согласия SDK: отвергнутая модель проваливала бы каждый ход после resume
      if (alive) {
        if (patch.model !== undefined) await sdk(view, "setModel", patch.model);
        const flags = Object.fromEntries((Object.keys(FLAGS) as Array<keyof typeof FLAGS>).filter((f) => patch[f] !== undefined).map((f) => [FLAGS[f], patch[f]]));
        if (Object.keys(flags).length) await sdk(view, "applyFlagSettings", flags);
        if (patch.mode !== undefined) await sdk(view, "setPermissionMode", MODES[patch.mode]);
      }
      if (patch.title !== undefined) {
        // заголовок живёт в файле разговора: файла ещё нет — он встанет с первым процессом
        await sdk(view, "renameSession", patch.title).catch((e: unknown) => ctx.log.warn("title", { callsign: to, why: (e as Error).message }));
        s.rec.title = patch.title;
      }
      s.rec.spec = { ...s.rec.spec, ...patch };
      s.rec.cwd = cwd;
      if (dropWing && s.rec.spec.wing) {
        await toWing(sessionRemove, s.rec.spec.wing, ctx);
        const { wing: _gone, ...left } = s.rec.spec;
        s.rec.spec = left;
      }
      k.save();
      // что вступит в силу только с новым процессом: хозяин ключа попросил перезапуск после хода
      const later = new Set<string>();
      for (const m of k.mods) {
        if (!m.applied || m === self) continue;
        const before = s.restarts;
        await m.applied(s.facade(m), keys);
        if (s.restarts > before) for (const key of keys) if (k.specOwner(key) === m) later.add(key);
      }
      if (patch.cwd !== undefined && alive) {
        later.add("cwd");
        quiet(s.restart());
      }
      const wing = pair ? await openWing(s, ctx) : undefined;
      s.sync();
      ctx.log.info("update", { callsign: to, keys });
      return { now: keys.filter((key) => !later.has(key)), later: [...later], ...(wing ? { wing } : {}) };
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

    async "session.remove"({ to, after_turn: afterTurn }: { to: string; after_turn?: boolean }, ctx) {
      const s = session(to);
      // starting: после подмены Host ход идёт у держателя, вызов инструмента приходит до готовности
      if (afterTurn && midTurn(s)) {
        s.rec.removeAfter = ctx.from;
        k.save();
        return { after_turn: true };
      }
      await remove(s, ctx);
      return {};
    },

    /** Откат разговора в той же сессии: показать → прервать ход → файлы → перезапуск на обрезанном разговоре → сказать. Без upto — /clear самого Claude. */
    async "session.rewind"({ to, upto, files, dry }: { to: string; upto?: string; files?: boolean; dry?: boolean }) {
      const s = session(to);
      const api = s.facade(self);
      if (!live(api)) throw new Refusal("stopped", `session.rewind ${to}: сессия ${api.state}`);
      const step = <T>(name: string, ...a: unknown[]) =>
        limited(k.clock, sdk(api, name, ...a) as Promise<T>, REWIND_MS, () => new Refusal("sdk_error", `${to}: ${name} — Claude не ответил за ${REWIND_MS / 1000} с`));
      const said = ((await step<Said[]>("getSessionMessages", { includeSystemMessages: true })) ?? []).filter((m) => !m.parent_tool_use_id);
      const at = upto ? said.findIndex((m) => m.uuid === upto) : 0;
      if (at < 0) throw new Refusal("not_found", `session.rewind ${to}: сообщения ${upto} в разговоре нет`);
      if (upto && !spoken(said[at]!)) throw new Refusal("bad_input", `session.rewind ${to}: ${upto} — не сообщение, а ответ инструмента`);
      const text = upto ? humanText(said[at]!) : undefined;
      const cut = said.slice(at).filter((m) => m.type !== "system").length;
      type Back = { canRewind?: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number };
      const back = async (dryRun: boolean): Promise<Back> => {
        const r = (await step<Back>("rewindFiles", upto, { dryRun })) ?? {};
        if (r.canRewind === false) throw new Refusal("no_checkpoint", `session.rewind ${to}: файлы к этому сообщению не вернуть — ${r.error ?? "снимка нет"}`);
        return r;
      };
      // показ не отказывает из-за файлов: разговор откатить можно и без них — причина уходит в ответ
      const probe = upto && files ? await step<Back>("rewindFiles", upto, { dryRun: true }).then((r) => r ?? {}) : undefined;
      if (probe?.canRewind === false && !dry) throw new Refusal("no_checkpoint", `session.rewind ${to}: файлы к этому сообщению не вернуть — ${probe.error ?? "снимка нет"}`);
      const changed = probe && probe.canRewind !== false ? probe : undefined;
      const out = { cut, ...(text ? { text } : {}), ...(probe?.canRewind === false ? { nofiles: probe.error ?? "снимка файлов нет" } : {}), ...(changed ? { files: (changed.filesChanged ?? []).map((f) => tildePath(f)), plus: changed.insertions ?? 0, minus: changed.deletions ?? 0 } : {}) };
      if (dry) return out;
      if (!(await s.halt())) throw new Refusal("busy", `session.rewind ${to}: ход не прервался за ${REWIND_MS / 1000} с — откат не начат`);
      if (changed) await back(false);
      const kept = upto && at > 0 ? said.slice(0, at).filter((m) => m.type !== "system").at(-1)?.uuid : undefined;
      if (!kept) {
        // очистка и откат к первому сообщению: разговор начинается заново командой самого Claude — событие сброса придёт от него
        api.input("/clear", { priority: "now" });
        tellLead(s, `Ведомый ${to} очищен: разговор начат заново.`);
        return out;
      }
      try {
        await s.rewind(kept);
      } catch (e) {
        throw new Refusal("open_failed", `session.rewind ${to}: ${(e as Error).message}`);
      }
      const words = `Откат к ${text ? `«${text.slice(0, 60)}»` : "полученной задаче"}${changed ? ` · файлы возвращены: ${changed.filesChanged?.length ?? 0}` : ""}`;
      // след отката — в ленту и в историю: встаёт за последней оставшейся записью
      s.tell({ type: "conversation_reset", uuid: randomUUID(), after: kept, text: words });
      tellLead(s, `Ведомый ${to} откачен${text ? ` к сообщению «${text.slice(0, 60)}»` : " к полученной задаче"}: ушло записей — ${cut}${changed ? ", файлы возвращены" : ""}.`);
      k.log.info("rewind", { callsign: to, cut, files: !!changed });
      return out;
    },

    /** Разговоры папки на диске машины: что можно продолжить новой сессией и какой из них ведёт сессия. */
    async "machine.conversations"({ cwd }: { cwd: string }) {
      const dir = k.folder(cwd);
      const list = ((await limited(k.clock, Promise.resolve(k.sdk.functions.listSessions!({ dir })), REWIND_MS, () => new Refusal("sdk_error", `machine.conversations ${cwd}: список не получен за ${REWIND_MS / 1000} с`))) ?? []) as Array<{ sessionId: string; summary?: string; customTitle?: string; firstPrompt?: string; lastModified: number; fileSize?: number }>;
      const held = new Map([...k.sessions.values()].map((x) => [x.rec.sessionId, x.callsign]));
      return {
        conversations: list
          .sort((a, b) => b.lastModified - a.lastModified)
          .map((c) => ({ id: c.sessionId, title: c.customTitle ?? c.firstPrompt ?? c.summary ?? "", at: c.lastModified, size: c.fileSize ?? 0, ...(held.has(c.sessionId) ? { live: held.get(c.sessionId)! } : {}) })),
      };
    },

    async "session.call"({ to, method, args }: { to: string; method: string; args?: unknown }, ctx) {
      const s = session(to).facade(self);
      if (!live(s) && !OFFLINE.has(method)) throw new Refusal("stopped", `session.call ${to}: ${method} — сессия ${s.state}`);
      const list = args === undefined ? [] : Array.isArray(args) ? args : [args];
      if (method === "reload") {
        // скилы и агенты с диска, затем внешние серверы плагинов: перечитывание запущенные серверы не трогает
        const step = (name: string, ...a: unknown[]) =>
          limited(k.clock, sdk(s, name, ...a), RELOAD_MS, () => new Refusal("sdk_error", `${to}: ${name} — Claude не ответил за ${RELOAD_MS / 1000} с`));
        const { mcpServers = [] } = ((await step("reloadPlugins")) ?? {}) as { mcpServers?: Array<{ name: string; status: string }> };
        await Promise.all(mcpServers.filter((m) => m.name.startsWith("plugin:") && m.status === "connected").map((m) => step("reconnectMcpServer", m.name)));
        return {};
      }
      // сессия зовёт у другой сессии только действия из закрытого списка
      if (kindOf(ctx.from) === "session" && !(TOOL_METHODS as readonly string[]).includes(method)) throw new Refusal("forbidden", `session.call ${to}: ${method} — сессии доступны ${TOOL_METHODS.join(", ")}`);
      if (method === "compact") {
        // сжатие — команда самого Claude: идёт вводом, как её набрал бы человек
        s.input("/compact", { priority: "next" });
        return {};
      }
      if (method === "usage") return sdk(s, USAGE, { skipBehaviors: true });
      if (method === "mcpStatus") {
        // у сервера флота в настройках лежит пропуск машины: заголовки и окружение серверов наружу не уходят
        const servers = (await sdk(s, "mcpServerStatus")) as Array<{ config?: Record<string, unknown> }> | undefined;
        return (servers ?? []).map((m) => {
          if (!m.config) return m;
          const { headers: _headers, env: _env, ...config } = m.config;
          return { ...m, config };
        });
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
    fast: () => {},
    style: text,
    thinking: () => {},
    title: text,
    parent: () => {},
    wing: () => {},
    project: () => {},
  };

  /** «Изменилось» от служб — всем модулям: каждый перечитывает своё. */
  self.frames = {
    changed(f) {
      k.changed(String(f.what));
    },
  };

  self.compose = (s) => k.corePart(s);

  self.on = {
    // режим сменили в самой сессии — документ следует за ней
    event(s, m) {
      // ведущая узнаёт, что ведомого сжали
      if (m?.type === "system" && m.subtype === "compact_boundary") {
        const wing = k.sessions.get(s.callsign);
        const meta = (m.compact_metadata ?? m.compactMetadata ?? {}) as { pre_tokens?: number; post_tokens?: number; preTokens?: number; postTokens?: number };
        const pre = meta.pre_tokens ?? meta.preTokens, post = meta.post_tokens ?? meta.postTokens;
        if (wing) tellLead(wing, `Ведомый ${s.callsign} сжат${pre ? `: ${Math.round(pre / 1000)} К${post ? ` → ${Math.round(post / 1000)} К` : ""} токенов` : ""}.`);
      }
      const mode = (m as { permissionMode?: string }).permissionMode;
      if (!mode) return;
      const name = Object.keys(MODES).find((key) => MODES[key] === mode);
      const rec = k.sessions.get(s.callsign)?.rec;
      if (!name || !rec || (rec.spec.mode ?? "all") === name) return;
      rec.spec = { ...rec.spec, mode: name as Spec["mode"] };
      k.save();
    },
    // ведущая узнаёт, что ведомый ждёт человека; вопрос самой ведущей уже пришёл ей вопросом
    asked(view, ask) {
      const s = k.sessions.get(view.callsign);
      if (!s) return;
      const lead = [...k.sessions.values()].find((x) => x.rec.spec.wing === s.callsign);
      if (!lead || (ask.kind === "question" && ask.to === lead.callsign)) return;
      tellLead(s, `Ведомый ${s.callsign} ждёт ответа человека: ${ask.kind === "question" ? "вопрос" : ask.kind === "plan" ? "план" : ask.kind === "permission" ? "разрешение" : "форма сервера"} — ${(ask.title ?? ask.text).slice(0, 120)}.`);
    },
    state(view, state, was) {
      const s = k.sessions.get(view.callsign);
      if (!s) return;
      // ведущий узнаёт о ведомом: поднялся и оборвался
      // подмена Host — не новость: процесс ведомого тот же
      if (was === "starting" && (state === "idle" || state === "busy") && s.launched !== "attach" && s.launched !== "spawn") tellLead(s, `Ведомый ${s.callsign} снова на связи.`);
      if (state === "failed") tellLead(s, `Ведомый ${s.callsign} остановился со сбоем: ${s.rec.error ?? "причина в журнале машины"}.`);
      // просили убрать после хода — ход кончился
      const by = s.rec.removeAfter;
      if (by && (state === "idle" || state === "stopped" || state === "failed")) {
        s.rec.removeAfter = undefined;
        quiet(remove(s, { from: by, log: k.log }).catch((e: unknown) => k.log.warn("remove_after", { callsign: s.callsign, why: (e as Error).message })));
      }
    },
  };
  return self;
}
