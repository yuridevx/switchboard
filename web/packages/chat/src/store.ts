// Разговоры страницы: журнал каждой сессии, подписка, отправка, действия. Единственное место модуля, что говорит с Host.
// Журнал — источник: живая пачка дописывается и идёт шагом свёртки; история, снятое сообщение и отозванный ответ — свёртка заново.
import { machineOf } from "@switchboard/protocol";
import type { App, ModelInfo } from "@switchboard/web-ui";
import { accountChanges, createStore, isLive, plural, sessionLabel, sessionOf } from "@switchboard/web-ui";
import { emptyView, fold, step, type Msg, type View } from "./fold.ts";
import { sayWord } from "./words.ts";

export type Attachment = { name: string; media_type: string; data: string };
/** Своё сообщение: в пути, принято, эхо из ленты, обрыв до ответа. */
export type Send = { state: "sending" | "sent" | "echo" | "lost"; queued: boolean };
export type Rewind = { id: string; state: "probe" | "ask" | "bad" | "ok"; text: string };
export type Side = { id: number; q: string; state: "wait" | "done" | "bad"; a: string };
export type Command = { name: string; description?: string };

export type Conv = {
  view: View;
  sends: Record<string, Send>;
  more: boolean;
  loaded: boolean;
  refused: string;
  unread: { count: number; text: string } | null;
  focus: boolean;
  rewind: Rewind | null;
  sides: Side[];
  models: ModelInfo[] | null;
  commands: Command[] | null;
};

const emptyConv = (): Conv => ({ view: emptyView(), sends: {}, more: false, loaded: false, refused: "", unread: null, focus: false, rewind: null, sides: [], models: null, commands: null });
const NOTHING = emptyConv();

/** Поле ввода открытого экрана. */
export type ComposerHandle = { text(): string; put(text: string, files: Attachment[]): void };

/** Что не рисуется: журнал и текущие дела сессии. */
type Run = {
  log: Msg[];
  seen: Set<string>;
  /** идущее сообщение: родитель → id */
  current: Record<string, string>;
  seq?: number;
  viewers: number;
  composer: ComposerHandle | null;
  outbox: Map<string, { text: string; attachments: Attachment[] }>;
  sides: number;
  asked: Set<string>;
};

/** Вид разговора для строк ленты: галерея стенда подаёт свой. */
export type Env = {
  callsign: string;
  view(): View;
  send(id: string): Send | undefined;
  rewind(): Rewind | null;
  /** сессия жива и машина умеет session.call */
  canAct(): boolean;
  label(callsign: string): string;
  /** запрос разрешения этого инструмента ждёт человека */
  waiting(tool: string): boolean;
  act(method: string, args?: unknown[]): void;
  again(id: string): void;
  cancel(id: string): void;
  probe(id: string): void;
  apply(id: string): void;
  cancelRewind(): void;
  fill(text: string): void;
};

export type Chats = ReturnType<typeof createChats>;

/** Страница истории и обновление истории: что уже есть, остаётся на месте; новое — у своего соседа. */
export function merge(log: Msg[], page: Msg[]): Msg[] {
  const at = new Map(log.flatMap((m, i) => (typeof m.uuid === "string" ? [[m.uuid, i] as const] : [])));
  const out: Msg[] = [];
  let i = 0;
  let waiting: Msg[] = [];
  for (const p of page) {
    const j = typeof p.uuid === "string" ? at.get(p.uuid) : undefined;
    if (j === undefined) {
      waiting.push(p);
    } else if (j >= i) {
      out.push(...log.slice(i, j), ...waiting, log[j]);
      waiting = [];
      i = j + 1;
    }
  }
  return [...out, ...waiting, ...log.slice(i)];
}

const HISTORY_PAGE = 50;
const NOT_CONFIRMED = new Set(["timeout", "disconnected"]);

export function createChats(app: App) {
  const store = createStore<{ chats: Record<string, Conv> }>({ chats: {} }, () => app.changed());
  const runs = new Map<string, Run>();
  const envs = new Map<string, Env>();
  let drafts: Record<string, string> = {};
  const accounts = new Map<string, string>();

  const conv = (cs: string): Conv => store.get().chats[cs] ?? NOTHING;
  const edit = (cs: string, fn: (c: Conv) => void) => store.set((d) => fn((d.chats[cs] ??= emptyConv())));
  const machine = (cs: string) => machineOf(cs) ?? "";
  const can = (cs: string, name: string) => app.can(machine(cs), name) === true;
  const canAct = (cs: string) => can(cs, "session.call") && isLive(sessionOf(app, cs)?.state);
  const say = (cs: string, word: string) => sayWord(word, machine(cs));

  function runOf(cs: string): Run {
    let r = runs.get(cs);
    if (!r) runs.set(cs, (r = { log: [], seen: new Set(), current: {}, viewers: 0, composer: null, outbox: new Map(), sides: 0, asked: new Set() }));
    return r;
  }

  const call = (cs: string, method: string, args: unknown[] = []) => app.request("session.call", { callsign: cs, method, args });
  const read = <T,>(cs: string, method: string, args: unknown[] = []) => app.read<T>("session.call", { callsign: cs, method, args });

  /** Кусочек идущего сообщения: одна запись с накопленным текстом вместо тысячи маленьких. */
  function delta(run: Run, c: Conv, m: Msg) {
    const e = m.event ?? {};
    const parent: string = m.parent_tool_use_id ?? "";
    if (e.type === "message_start") run.current[parent] = e.message?.id;
    if (e.type !== "content_block_delta") return;
    const text = e.delta?.type === "text_delta" ? String(e.delta.text ?? "") : "";
    const think = e.delta?.type === "thinking_delta" ? String(e.delta.thinking ?? "") : "";
    const id = run.current[parent];
    if ((!text && !think) || !id) return;
    let entry = run.log.findLast((x) => x.type === "partial" && x.id === id);
    if (!entry) run.log.push((entry = { type: "partial", id, parent, text: "", think: "" }));
    entry.text += text;
    entry.think += think;
    step(c.view, { ...entry });
  }

  /** Сообщение ленты или истории: в журнал и шаг свёртки; повтор по uuid не задваивает, своё сообщение получает эхо. */
  function take(run: Run, c: Conv, m: Msg, draw = true) {
    if (m.type === "stream_event") return delta(run, c, m);
    if (m.type === "tool_progress" || (m.type === "system" && m.subtype === "thinking_tokens")) return step(c.view, m);
    if (typeof m.uuid === "string") {
      if (c.sends[m.uuid]) c.sends[m.uuid].state = "echo";
      if (run.seen.has(m.uuid)) return;
      run.seen.add(m.uuid);
    }
    if (m.type === "assistant" && m.message?.id) run.log = run.log.filter((x) => x.type !== "partial" || x.id !== m.message.id);
    if (draw) {
      run.log.push(m);
      step(c.view, m);
    }
  }

  /** Страницу истории — в журнал, строки заново. */
  function takePage(cs: string, page: Msg[]) {
    const run = runOf(cs);
    edit(cs, (c) => {
      for (const m of page) take(run, c, m, false);
      run.log = merge(run.log, page);
      c.view = fold(run.log);
    });
  }

  async function history(cs: string) {
    if (!can(cs, "session.history")) return edit(cs, (c) => void (c.loaded = true));
    const r = await app.request<{ messages?: Msg[]; more?: boolean }>("session.history", { callsign: cs, before: null, limit: HISTORY_PAGE });
    if (r.ok) takePage(cs, r.result.messages ?? []);
    edit(cs, (c) => {
      c.loaded = true;
      if (r.ok) c.more = !!r.result.more;
      else c.refused ||= `session.history: ${r.error}`;
    });
  }

  async function older(cs: string) {
    const first = runOf(cs).log.find((m) => typeof m.uuid === "string" && !conv(cs).sends[m.uuid]);
    const r = await app.request<{ messages?: Msg[]; more?: boolean }>("session.history", { callsign: cs, before: first?.uuid ?? null, limit: HISTORY_PAGE });
    if (!r.ok) return app.toast(`${cs}: session.history — ${r.error}`);
    takePage(cs, r.result.messages ?? []);
    edit(cs, (c) => void (c.more = !!r.result.more));
  }

  /** Подписка и история: при открытии, когда машина появилась, связь вернулась или Host поднялся заново. */
  async function subscribe(cs: string) {
    if (app.link() !== "open" || app.can(machine(cs), "session.watch") === null) return;
    runOf(cs).seq = undefined;
    edit(cs, (c) => void (c.refused = ""));
    if (can(cs, "session.watch")) {
      const w = await app.read("session.watch", { callsign: cs });
      if (!w.ok) edit(cs, (c) => void (c.refused = `session.watch: ${w.error}`));
    }
    await history(cs);
  }

  function saveDrafts() {
    return app.store<Record<string, string>>("drafts").set({ ...drafts });
  }

  function setDraft(cs: string, text: string) {
    if (text) drafts[cs] = text;
    else delete drafts[cs];
  }

  /** Экран открыт: первый смотрящий подписывается, последний отписывается. */
  function open(cs: string) {
    const run = runOf(cs);
    if (++run.viewers === 1) {
      edit(cs, (c) => void (c.unread = null));
      void subscribe(cs);
    }
    return () => {
      if (--run.viewers > 0) return;
      void app.request("session.unwatch", { callsign: cs });
      void saveDrafts();
    };
  }

  function removeOwn(cs: string, uuid: string) {
    const run = runOf(cs);
    run.log = run.log.filter((m) => m.uuid !== uuid);
    run.seen.delete(uuid);
    edit(cs, (c) => {
      delete c.sends[uuid];
      c.view = fold(run.log);
    });
  }

  /** Отказ: сообщения нет; что написал человек, не пропадает и новое не затирает. */
  function refused(cs: string, uuid: string, word: string) {
    const run = runOf(cs);
    const sent = run.outbox.get(uuid)!;
    run.outbox.delete(uuid);
    removeOwn(cs, uuid);
    const why = `${cs}: не доставлено — ${say(cs, word)}.`;
    const field = run.composer;
    if (!field) {
      if (!drafts[cs]) setDraft(cs, sent.text);
      void saveDrafts();
      return app.toast(`${why} Черновик цел${sent.attachments.length ? ", вложения не сохранены" : ""}.`);
    }
    if (field.text()) {
      field.put(field.text(), sent.attachments);
      return app.toast(`${why} В поле новый текст, отправленный текст не возвращён.`);
    }
    field.put(sent.text, sent.attachments);
    app.toast(`${why} Черновик цел.`);
  }

  async function deliver(cs: string, uuid: string) {
    const { text, attachments } = runOf(cs).outbox.get(uuid)!;
    const r = await app.request("session.prompt", { callsign: cs, uuid, text, ...(attachments.length ? { attachments } : {}) });
    if (!r.ok && !NOT_CONFIRMED.has(r.error)) return refused(cs, uuid, r.error);
    edit(cs, (c) => {
      const s = c.sends[uuid];
      if (s && s.state !== "echo") s.state = r.ok ? "sent" : "lost";
    });
  }

  /** Своё сообщение — в ленте сразу, как будет записано в разговоре. */
  function ownEntry(uuid: string, text: string, attachments: Attachment[]): Msg {
    const blocks = attachments.map((a) => (a.media_type.startsWith("image/") ? { type: "image", source: { type: "base64", media_type: a.media_type, data: a.data } } : { type: "document", title: a.name }));
    return { type: "user", uuid, timestamp: new Date().toISOString(), message: { content: blocks.length ? [...blocks, ...(text ? [{ type: "text", text }] : [])] : text } };
  }

  function send(cs: string, text: string, attachments: Attachment[] = []) {
    const uuid = crypto.randomUUID();
    const run = runOf(cs);
    run.outbox.set(uuid, { text, attachments });
    const state = sessionOf(app, cs)?.state;
    edit(cs, (c) => {
      take(run, c, ownEntry(uuid, text, attachments));
      c.sends[uuid] = { state: "sending", queued: state === "busy" || state === "waiting" };
    });
    void deliver(cs, uuid);
  }

  function again(cs: string, uuid: string) {
    edit(cs, (c) => void (c.sends[uuid].state = "sending"));
    void deliver(cs, uuid);
  }

  async function cancel(cs: string, uuid: string) {
    const r = await call(cs, "cancelAsyncMessage", [uuid]);
    if (!r.ok) return app.toast(`${cs}: cancelAsyncMessage — ${say(cs, r.error)}`);
    if (!r.result) return app.toast("Claude уже взял это сообщение");
    const sent = runOf(cs).outbox.get(uuid)!;
    removeOwn(cs, uuid);
    runOf(cs).composer?.put(sent.text, sent.attachments);
  }

  async function act(cs: string, method: string, args: unknown[] = []) {
    const r = await call(cs, method, args);
    if (!r.ok) app.toast(`${cs}: ${method} — ${say(cs, r.error)}`);
    return r;
  }

  async function probe(cs: string, id: string) {
    edit(cs, (c) => void (c.rewind = { id, state: "probe", text: "Проба отката…" }));
    const r = await read<{ canRewind?: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }>(cs, "rewindFiles", [id, { dryRun: true }]);
    const why = !r.ok ? say(cs, r.error) : r.result.canRewind ? "" : (r.result.error ?? "canRewind: false");
    if (!r.ok || why) return edit(cs, (c) => void (c.rewind = { id, state: "bad", text: `Откатить нельзя: ${why}` }));
    const n = r.result;
    const files = n.filesChanged?.length ?? 0;
    edit(cs, (c) => void (c.rewind = { id, state: "ask", text: `Откатить файлы к этому сообщению? ${files} ${plural(files, "файл", "файла", "файлов")} · +${n.insertions ?? 0} −${n.deletions ?? 0} · команды Bash не откатываются` }));
  }

  async function apply(cs: string, id: string) {
    const r = await call(cs, "rewindFiles", [id]);
    edit(cs, (c) => void (c.rewind = r.ok ? { id, state: "ok", text: "Файлы откачены к этому сообщению." } : { id, state: "bad", text: `Не откатилось: ${say(cs, r.error)}` }));
  }

  async function side(cs: string, q: string) {
    const id = ++runOf(cs).sides;
    edit(cs, (c) => void c.sides.push({ id, q, state: "wait", a: "" }));
    const r = await call(cs, "askSideQuestion", [q]);
    edit(cs, (c) => {
      const s = c.sides.find((x) => x.id === id);
      if (!s) return;
      s.state = r.ok ? "done" : "bad";
      s.a = r.ok ? String((r.result as { response?: string } | null)?.response ?? "Claude не ответил") : say(cs, r.error);
    });
  }

  /** Команды сессии: один раз на разговор; отказ — пустой список. */
  async function loadCommands(cs: string) {
    const run = runOf(cs);
    if (run.asked.has("commands")) return;
    run.asked.add("commands");
    const r = await read<Command[]>(cs, "supportedCommands");
    edit(cs, (c) => void (c.commands = r.ok && Array.isArray(r.result) ? r.result : []));
  }

  async function reloadPlugins(cs: string) {
    await act(cs, "reloadPlugins");
    runOf(cs).asked.delete("commands");
    edit(cs, (c) => void (c.commands = null));
  }

  /** Модели сессии: один запрос на разговор; отказ не запоминается. */
  async function loadModels(cs: string) {
    const run = runOf(cs);
    if (run.asked.has("models")) return;
    run.asked.add("models");
    const r = await read<ModelInfo[]>(cs, "supportedModels");
    if (r.ok) edit(cs, (c) => void (c.models = Array.isArray(r.result) ? r.result : null));
    else run.asked.delete("models");
  }

  function env(cs: string): Env {
    let e = envs.get(cs);
    if (e) return e;
    e = {
      callsign: cs,
      view: () => conv(cs).view,
      send: (id) => conv(cs).sends[id],
      rewind: () => conv(cs).rewind,
      canAct: () => canAct(cs),
      label: (x) => sessionLabel(app, x).text,
      waiting: (tool) => app.mark("asked.tool", cs, tool) === true,
      act: (method, args) => void act(cs, method, args),
      again: (id) => again(cs, id),
      cancel: (id) => void cancel(cs, id),
      probe: (id) => void probe(cs, id),
      apply: (id) => void apply(cs, id),
      cancelRewind: () => edit(cs, (c) => void (c.rewind = null)),
      fill: (text) => runOf(cs).composer?.put(text, []),
    };
    envs.set(cs, e);
    return e;
  }

  return {
    conv,
    env,
    open,
    older,
    send,
    side,
    act,
    loadCommands,
    reloadPlugins,
    loadModels,
    canAct,
    can,
    closeSide: (cs: string, id: number) => edit(cs, (c) => void (c.sides = c.sides.filter((s) => s.id !== id))),
    toggleFocus: (cs: string) => edit(cs, (c) => void (c.focus = !c.focus)),
    draft: (cs: string) => drafts[cs] ?? "",
    setDraft,
    bindComposer: (cs: string, handle: ComposerHandle | null) => void (runOf(cs).composer = handle),
    read,

    async start() {
      drafts = (await app.store<Record<string, string>>("drafts").get()) ?? {};
    },
    async stop() {
      for (const [cs, run] of runs) if (run.viewers) void app.request("session.unwatch", { callsign: cs });
      await saveDrafts();
    },

    onEvents(f: { from?: string; seq?: unknown; events?: unknown }) {
      const cs = String(f.from);
      const run = runOf(cs);
      if (!run.viewers) return;
      const seq = typeof f.seq === "number" ? f.seq : undefined;
      const gap = seq !== undefined && run.seq !== undefined && seq !== run.seq + 1;
      if (seq !== undefined) run.seq = seq;
      edit(cs, (c) => {
        for (const m of (f.events ?? []) as Msg[]) take(run, c, m);
      });
      if (gap) void history(cs);
    },

    /** Сообщение сессии владельцу: закрытый чат получает метку; нажатый пуш открывает чат. */
    onMessage(f: { from?: string; text?: unknown; notify?: { body?: string } }, opened: boolean) {
      const cs = String(f.from);
      const run = runOf(cs);
      const text = typeof f.text === "string" ? f.text : String(f.notify?.body ?? "");
      edit(cs, (c) => {
        take(run, c, { type: "owner", uuid: crypto.randomUUID(), from: cs, text, ...(typeof f.text === "string" ? {} : { tag: "из уведомления" }), timestamp: new Date().toISOString() });
        if (!run.viewers && !opened) c.unread = { count: (c.unread?.count ?? 0) + 1, text };
      });
      if (opened) app.open("chat", { callsign: cs });
    },

    onLink(state: string, only?: string) {
      if (state !== "open") return;
      for (const [cs, run] of runs) if (run.viewers && (!only || machine(cs) === only)) void subscribe(cs);
    },

    /** Подмену аккаунта делает Host: строка в ленте, где эта сессия. */
    onRoster(r: Parameters<typeof accountChanges>[0]) {
      for (const x of accountChanges(r, (cs) => accounts.get(cs))) {
        accounts.set(x.callsign, x.account);
        if (x.from !== undefined) edit(x.callsign, (c) => take(runOf(x.callsign), c, { type: "system", subtype: "account_swap", uuid: crypto.randomUUID(), from: x.from, to: x.account }));
      }
    },
  };
}
