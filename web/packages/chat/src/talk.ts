// Разговоры страницы: по сессии — сообщения SDK (история и живое), свои отправки, вопросы сбоку, поле ввода. Единственное место модуля, что говорит с Host.
import { accountChanges, createStore, isLive, plural, sessionOf, type App, type ModelInfo, type Result } from "@switchboard/web-ui";
import type { Frame, Roster } from "@switchboard/web-core";
import type { Msg } from "./fold.ts";
import { sayWord } from "./words.ts";

export type Att = { name: string; media_type: string; data: string };
/** Своё сообщение: в пути, принято, эхо из ленты или истории, обрыв до ответа. */
export type Send = { uuid: string; text: string; files: Att[]; at: number; state: "sending" | "ok" | "echo" | "lost"; queued: boolean };
export type Side = { id: number; q: string; state: "wait" | "done" | "bad"; a: string };
export type Rewind = { id: string; state: "probe" | "ask" | "bad" | "ok"; text: string };
export type Cmd = { name: string; description?: string };
export type Talk = {
  msgs: Msg[];
  more: boolean;
  loaded: boolean;
  seq?: number;
  refused: string;
  sends: Send[];
  sides: Side[];
  draft: string;
  files: Att[];
  unread: { count: number; text: string } | null;
  rewind: Rewind | null;
  models?: ModelInfo[] | "loading";
  commands?: Cmd[] | "loading";
  focus: boolean;
};

const HISTORY = 50;
const NOT_CONFIRMED = new Set(["timeout", "disconnected"]);
const blank = (draft = ""): Talk => ({ msgs: [], more: false, loaded: false, refused: "", sends: [], sides: [], draft, files: [], unread: null, rewind: null, focus: false });
export const machineOf = (cs: string) => cs.slice(cs.lastIndexOf("@") + 1);

/** Страница истории: что уже есть, остаётся на месте; новое — у своего соседа; кусочки живого заменяет история. Разрыв длиннее страницы: прежнему соседа нет, «Раньше» доберёт его по порядку. */
function merge(cur: readonly Msg[], page: readonly Msg[], more: boolean): Msg[] {
  const log = cur.filter((m) => m.type !== "stream_event");
  const at = new Map(log.flatMap((m, i) => (typeof m.uuid === "string" ? [[m.uuid, i] as const] : [])));
  if (more && page.length && !page.some((p) => at.has(p.uuid))) return [...page, ...log.filter((m) => m.own || String(m.uuid).startsWith("x:"))];
  const out: Msg[] = [];
  let waiting: Msg[] = [];
  let i = 0;
  for (const p of page) {
    const j = at.get(p.uuid);
    if (j === undefined) waiting.push(p);
    else if (j >= i) {
      out.push(...log.slice(i, j), ...waiting, log[j]);
      waiting = [];
      i = j + 1;
    }
  }
  return [...out, ...waiting, ...log.slice(i)];
}

/** Кусочки идущего сообщения: одна запись с накопленным текстом вместо тысячи маленьких; счётчики хода — одна запись; кусочки входа инструмента не рисуются. */
function addEvent(list: Msg[], m: Msg): void {
  const prev = list.at(-1);
  const d = m.type === "stream_event" && m.event?.type === "content_block_delta" ? m.event.delta : undefined;
  const key = d?.type === "text_delta" ? "text" : d?.type === "thinking_delta" ? "thinking" : undefined;
  if (d && !key) return;
  if (prev && key && prev.event?.delta?.type === d.type && prev.parent_tool_use_id === m.parent_tool_use_id) prev.event.delta[key] += d[key];
  else if (prev && (m.subtype === "thinking_tokens" ? prev.subtype === m.subtype : m.type === "tool_progress" && prev.tool_use_id === m.tool_use_id && prev.type === m.type)) list[list.length - 1] = m;
  else list.push(m);
}

/** Своё сообщение — в ленте сразу, как будет записано в разговоре: живой поток своих сообщений не возвращает, запись приходит только с историей. */
function ownEntry(s: Send): Msg {
  const isImage = (f: Att) => f.media_type.startsWith("image/");
  const blocks = s.files.filter(isImage).map((f) => ({ type: "image", source: { type: "base64", media_type: f.media_type, data: f.data } }));
  return { type: "user", uuid: s.uuid, own: true, files: s.files.filter((f) => !isImage(f)).map((f) => f.name), timestamp: new Date(s.at).toISOString(), message: { content: blocks.length ? [...blocks, ...(s.text ? [{ type: "text", text: s.text }] : [])] : s.text } };
}

/** Запись своего сообщения пришла: оно в разговоре. */
function echoed(t: Talk, msgs: readonly Msg[]) {
  for (const s of t.sends) if (msgs.some((m) => m.uuid === s.uuid)) s.state = "echo";
}

export function createTalks(app: App) {
  /** буква ввода не трогает страницу: поле пишется молча, рисует его сам ввод */
  let quiet = false;
  const store = createStore<Record<string, Talk>>({}, () => quiet || app.changed());
  let drafts: Record<string, string> = {};
  const opened = new Map<string, number>();
  const watching = new Set<string>();
  const known = new Map<string, string>();
  let n = 0;

  const get = (cs: string): Talk => store.get()[cs] ?? blank(drafts[cs]);
  const edit = (cs: string, fn: (t: Talk) => void) =>
    store.set((s) => {
      fn((s[cs] ??= blank(drafts[cs])) as Talk);
    });
  const can = (cs: string, name: string) => app.can(machineOf(cs), name) === true;
  const canAct = (cs: string) => can(cs, "session.call") && isLive(sessionOf(app, cs)?.state);
  const call = (cs: string, method: string, args: unknown[] = []) => app.request("session.call", { callsign: cs, method, args });
  const read = <T = unknown>(cs: string, method: string, args: unknown[] = []): Promise<Result<T>> => app.read<T>("session.call", { callsign: cs, method, args });
  const say = (cs: string, word: string) => sayWord(word, machineOf(cs));

  async function history(cs: string) {
    if (!can(cs, "session.history")) return edit(cs, (t) => void (t.loaded = true));
    const r = await app.request<{ messages: Msg[]; more: boolean }>("session.history", { callsign: cs, before: null, limit: HISTORY });
    edit(cs, (t) => {
      t.loaded = true;
      if (!r.ok) return void (t.refused ||= `session.history: ${r.error}`);
      echoed(t, r.result.messages);
      t.msgs = merge(t.msgs, r.result.messages, r.result.more);
      t.more = r.result.more;
    });
  }

  /** Подписка и история: при открытии, когда машина появилась, связь вернулась или Host поднялся заново. */
  async function watch(cs: string) {
    if (watching.has(cs) || app.link() !== "open" || app.can(machineOf(cs), "session.watch") === null) return;
    watching.add(cs);
    edit(cs, (t) => {
      t.refused = "";
      t.seq = undefined;
    });
    if (can(cs, "session.watch")) {
      const r = await app.read("session.watch", { callsign: cs });
      if (!r.ok) edit(cs, (t) => void (t.refused = `session.watch: ${r.error}`));
    }
    await history(cs);
  }

  function unwatch(cs: string) {
    if (watching.delete(cs) && can(cs, "session.watch")) void app.request("session.unwatch", { callsign: cs });
  }

  const saveDrafts = () => app.store<Record<string, string>>("drafts").set({ ...drafts });
  const setDraft = (cs: string, text: string) => {
    if (text) drafts[cs] = text;
    else delete drafts[cs];
  };

  /** Отказ: сообщения нет; что написал человек, не пропадает и новое не затирает. */
  function giveBack(cs: string, s: Send, word?: string) {
    const open = opened.has(cs);
    const empty = !get(cs).draft;
    edit(cs, (t) => {
      t.sends = t.sends.filter((x) => x.uuid !== s.uuid);
      t.msgs = t.msgs.filter((m) => m.uuid !== s.uuid);
      if (empty) t.draft = s.text;
      if (open) t.files.push(...s.files);
    });
    if (!open && empty) {
      setDraft(cs, s.text);
      void saveDrafts();
    }
    if (!word) return;
    const why = `${cs}: не доставлено — ${say(cs, word)}.`;
    if (!open) app.toast(`${why} Черновик цел${s.files.length ? ", вложения не сохранены" : ""}.`);
    else app.toast(`${why} ${empty ? "Черновик цел." : "В поле новый текст, отправленный текст не возвращён."}`);
  }

  async function deliver(cs: string, s: Send) {
    const r = await app.request("session.prompt", { callsign: cs, uuid: s.uuid, text: s.text, ...(s.files.length ? { attachments: s.files } : {}) });
    if (!r.ok && !NOT_CONFIRMED.has(r.error)) return giveBack(cs, s, r.error);
    edit(cs, (t) => {
      const x = t.sends.find((y) => y.uuid === s.uuid);
      if (x && x.state !== "echo") x.state = r.ok ? "ok" : "lost";
    });
  }

  async function act(cs: string, method: string, args: unknown[] = []) {
    const r = await call(cs, method, args);
    if (!r.ok) app.toast(`${cs}: ${method} — ${say(cs, r.error)}`);
  }

  return {
    store,
    get,
    edit,
    can,
    canAct,
    read,
    act,
    async start() {
      drafts = (await app.store<Record<string, string>>("drafts").get()) ?? {};
    },
    async stop() {
      for (const cs of [...watching]) unwatch(cs);
      for (const cs of opened.keys()) setDraft(cs, get(cs).draft);
      await saveDrafts();
    },
    /** Экран открыт: первый смотрящий подписывается, последний отписывается. */
    open(cs: string) {
      opened.set(cs, (opened.get(cs) ?? 0) + 1);
      edit(cs, (t) => void (t.unread = null));
      void watch(cs);
    },
    close(cs: string) {
      const left = (opened.get(cs) ?? 1) - 1;
      if (left > 0) return void opened.set(cs, left);
      opened.delete(cs);
      unwatch(cs);
      setDraft(cs, get(cs).draft);
      void saveDrafts();
    },
    async older(cs: string) {
      const first = get(cs).msgs.find((m) => typeof m.uuid === "string" && !m.uuid.startsWith("x:") && !m.own);
      const r = await app.request<{ messages: Msg[]; more: boolean }>("session.history", { callsign: cs, before: first?.uuid ?? null, limit: HISTORY });
      if (!r.ok) {
        app.toast(`${cs}: session.history — ${r.error}`);
        return false;
      }
      edit(cs, (t) => {
        const have = new Set(t.msgs.map((m) => m.uuid));
        t.msgs = [...r.result.messages.filter((m) => !have.has(m.uuid)), ...t.msgs];
        t.more = r.result.more;
      });
      return true;
    },
    typed(cs: string, text: string) {
      quiet = true;
      edit(cs, (t) => void (t.draft = text));
      quiet = false;
    },
    send(cs: string, text: string, files: Att[]) {
      const state = sessionOf(app, cs)?.state;
      const s: Send = { uuid: crypto.randomUUID(), text, files, at: Date.now(), state: "sending", queued: state === "busy" || state === "waiting" };
      edit(cs, (t) => {
        t.sends.push(s);
        t.msgs.push(ownEntry(s));
      });
      void deliver(cs, s);
    },
    again(cs: string, uuid: string) {
      const s = get(cs).sends.find((x) => x.uuid === uuid);
      if (!s) return;
      edit(cs, (t) => void (t.sends.find((x) => x.uuid === uuid)!.state = "sending"));
      void deliver(cs, s);
    },
    async cancel(cs: string, uuid: string) {
      const r = await call(cs, "cancelAsyncMessage", [uuid]);
      if (!r.ok) return app.toast(`${cs}: cancelAsyncMessage — ${say(cs, r.error)}`);
      const s = get(cs).sends.find((x) => x.uuid === uuid);
      if (r.result && s) giveBack(cs, s);
      else app.toast("Claude уже взял это сообщение");
    },
    async side(cs: string, q: string) {
      const id = ++n;
      edit(cs, (t) => void t.sides.push({ id, q, state: "wait", a: "" }));
      const r = await call(cs, "askSideQuestion", [q]);
      edit(cs, (t) => {
        const x = t.sides.find((y) => y.id === id);
        if (x) Object.assign(x, r.ok ? { state: "done", a: String((r.result as { response?: string } | null)?.response ?? "Claude не ответил") } : { state: "bad", a: say(cs, r.error) });
      });
    },
    async probe(cs: string, id: string) {
      edit(cs, (t) => void (t.rewind = { id, state: "probe", text: "Проба отката…" }));
      const r = await read<{ canRewind?: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }>(cs, "rewindFiles", [id, { dryRun: true }]);
      const why = !r.ok ? say(cs, r.error) : r.result.canRewind ? "" : (r.result.error ?? "canRewind: false");
      if (!r.ok || why) return edit(cs, (t) => void (t.rewind = { id, state: "bad", text: `Откатить нельзя: ${why}` }));
      const files = r.result.filesChanged?.length ?? 0;
      edit(cs, (t) => void (t.rewind = { id, state: "ask", text: `Откатить файлы к этому сообщению? ${files} ${plural(files, "файл", "файла", "файлов")} · +${r.result.insertions ?? 0} −${r.result.deletions ?? 0} · команды Bash не откатываются` }));
    },
    async apply(cs: string, id: string) {
      const r = await call(cs, "rewindFiles", [id]);
      edit(cs, (t) => void (t.rewind = r.ok ? { id, state: "ok", text: "Файлы откачены к этому сообщению." } : { id, state: "bad", text: `Не откатилось: ${say(cs, r.error)}` }));
    },
    /** Модели сессии: один запрос на разговор; отказ не запоминается. */
    async models(cs: string) {
      if (get(cs).models) return;
      edit(cs, (t) => void (t.models = "loading"));
      const r = await read<ModelInfo[]>(cs, "supportedModels");
      edit(cs, (t) => void (t.models = r.ok && Array.isArray(r.result) ? r.result : undefined));
    },
    /** Команды сессии: один раз на разговор; отказ — пустой список. */
    async commands(cs: string) {
      if (get(cs).commands) return;
      edit(cs, (t) => void (t.commands = "loading"));
      const r = await read<Cmd[]>(cs, "supportedCommands");
      edit(cs, (t) => void (t.commands = r.ok && Array.isArray(r.result) ? r.result : []));
    },
    async reloadPlugins(cs: string) {
      await act(cs, "reloadPlugins");
      edit(cs, (t) => void (t.commands = undefined));
    },
    frames: {
      "session.events"(f: Frame) {
        const cs = String(f.from);
        if (!watching.has(cs)) return;
        const seq = typeof f.seq === "number" ? f.seq : undefined;
        const was = get(cs).seq;
        const at = Date.now();
        edit(cs, (t) => {
          const events = (f.events ?? []) as Msg[];
          echoed(t, events);
          for (const m of events) if (!t.sends.some((s) => s.uuid === m.uuid)) addEvent(t.msgs, { ...m, _at: at });
          if (seq !== undefined) t.seq = seq;
        });
        if (seq !== undefined && was !== undefined && seq !== was + 1) void history(cs);
      },
      /** Сообщение сессии владельцу: закрытый чат получает метку; нажатый пуш открывает чат. */
      message(f: Frame, ctx: { open: boolean }) {
        const cs = String(f.from);
        const text = typeof f.text === "string" ? f.text : String((f.notify as { body?: string } | undefined)?.body ?? "");
        edit(cs, (t) => {
          t.msgs.push({ type: "owner", uuid: `x:${++n}`, from: cs, text, ...(typeof f.text === "string" ? {} : { tag: "из уведомления" }), timestamp: new Date().toISOString() });
          if (!opened.has(cs) && !ctx.open) t.unread = { count: (t.unread?.count ?? 0) + 1, text };
        });
        if (ctx.open) app.open("chat", { callsign: cs });
      },
    },
    /** Подмену аккаунта делает Host: строка в ленте, где эта сессия. */
    roster(r: Roster) {
      for (const c of accountChanges(r, (cs) => known.get(cs))) {
        known.set(c.callsign, c.account);
        if (c.from !== undefined && store.get()[c.callsign]) edit(c.callsign, (t) => void t.msgs.push({ type: "account", uuid: `x:${++n}`, from: c.from, to: c.account }));
      }
    },
    link(state: string, machine?: string) {
      if (state !== "open") return watching.clear();
      for (const cs of opened.keys())
        if (!machine || machineOf(cs) === machine) {
          watching.delete(cs);
          void watch(cs);
        }
    },
  };
}
export type Talks = ReturnType<typeof createTalks>;
