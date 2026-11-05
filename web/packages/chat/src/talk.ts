// Разговоры страницы: по сессии — сообщения SDK (история и живое), свои отправки, вопросы сбоку, поле ввода. Связь с Host — только запросами и кадрами контракта.
import { accountChanges, createStore, isLive, linkText, plural, sessionOf, type App, type ModelInfo, type Result } from "@switchboard/web-ui";
import type { Frame, Roster } from "@switchboard/web-core";
import type { Msg } from "./fold.ts";
import { refusal } from "./words.ts";

export type Att = { name: string; media_type: string; data: string };
export type Send = { uuid: string; text: string; files: Att[]; at: number; state: "sending" | "ok" | "queued" | "pend" };
export type Side = { id: number; q: string; state: "wait" | "done" | "bad"; a?: string };
export type Rewind = { state: "probe" | "ask" | "no" | "apply" | "done" | "bad"; text: string };
export type Cmd = { name: string; description?: string };
export type Talk = {
  msgs: Msg[];
  more: boolean;
  seq?: number;
  note?: string;
  sends: Send[];
  sides: Side[];
  draft: string;
  files: Att[];
  unread: number;
  unreadText?: string;
  rewinds: Record<string, Rewind>;
  models?: ModelInfo[] | "loading";
  commands?: Cmd[] | "loading";
  focus: boolean;
};

const HISTORY = 50;
const blank = (draft = ""): Talk => ({ msgs: [], more: false, sends: [], sides: [], draft, files: [], unread: 0, rewinds: {}, focus: false });
export const machineOf = (cs: string) => cs.slice(cs.lastIndexOf("@") + 1);
const uuids = (msgs: readonly Msg[]) => new Set(msgs.map((m) => m.uuid).filter(Boolean));

/** Страница истории поверх известного: что раньше страницы — впереди, что не вошло в неё — следом. Кусочки живого заменяет история. */
function merge(cur: readonly Msg[], page: readonly Msg[]): Msg[] {
  const inPage = uuids(page);
  const first = cur.findIndex((m) => m.uuid && m.uuid === page[0]?.uuid);
  const before = first > 0 ? cur.slice(0, first) : [];
  const after = cur.slice(Math.max(first, 0)).filter((m) => m.type !== "stream_event" && !(m.uuid && inPage.has(m.uuid)));
  return [...before, ...page, ...after];
}

export function createTalks(app: App) {
  const store = createStore<Record<string, Talk>>({}, () => app.changed());
  let drafts: Record<string, string> = {};
  const opened = new Map<string, number>();
  const watching = new Set<string>();
  const known: Record<string, string> = {};
  let n = 0;

  const get = (cs: string): Talk => store.get()[cs] ?? blank(drafts[cs]);
  const edit = (cs: string, fn: (t: Talk) => void) =>
    store.set((s) => {
      fn((s[cs] ??= blank(drafts[cs])) as Talk);
    });
  const live = (cs: string) => isLive(sessionOf(app, cs)?.state);
  const can = (cs: string, name: string) => app.can(machineOf(cs), name) === true;
  const call = <T = unknown>(cs: string, method: string, args: unknown[] = [], read = false): Promise<Result<T>> => (read ? app.read<T> : app.request<T>)("session.call", { callsign: cs, method, args });
  const say = (cs: string, word: string) => refusal(word, machineOf(cs));

  async function history(cs: string) {
    if (!can(cs, "session.history")) return;
    const r = await app.request<{ messages: Msg[]; more: boolean }>("session.history", { callsign: cs, before: null, limit: HISTORY });
    edit(cs, (t) => {
      if (!r.ok) return void (t.note ??= `session.history: ${r.error}`);
      t.msgs = merge(t.msgs, r.result.messages);
      t.more = r.result.more;
    });
  }

  async function watch(cs: string) {
    if (watching.has(cs) || app.link() !== "open" || !app.roster()?.machines.some((m) => m.machine === machineOf(cs))) return;
    if (!can(cs, "session.watch")) return edit(cs, (t) => void (t.note = `${machineOf(cs)} не отдаёт ленту — только переписка и ввод`));
    watching.add(cs);
    const r = await app.read("session.watch", { callsign: cs });
    edit(cs, (t) => void (t.note = r.ok ? undefined : `session.watch: ${r.error}`));
    await history(cs);
  }

  function unwatch(cs: string) {
    if (!watching.delete(cs)) return;
    void app.request("session.unwatch", { callsign: cs });
  }

  const saveDrafts = () => void app.store<Record<string, string>>("drafts").set(drafts);
  const keepDraft = (cs: string) => {
    const d = get(cs).draft;
    if (d.trim()) drafts[cs] = d;
    else delete drafts[cs];
  };

  /** Отправленное не дошло: текст — в поле, если оно пусто, вложения — к набранным; тост словами. */
  function giveBack(cs: string, s: Send, word?: string) {
    const open = (opened.get(cs) ?? 0) > 0;
    const t = get(cs);
    const empty = !t.draft.trim();
    edit(cs, (x) => {
      x.sends = x.sends.filter((y) => y.uuid !== s.uuid);
      if (empty) x.draft = s.text;
      if (open) x.files.push(...s.files);
    });
    if (!open && empty) {
      drafts[cs] = s.text;
      saveDrafts();
    }
    if (word) app.toast(`${cs}: не доставлено — ${say(cs, word)}. ${!open ? "Черновик цел, вложения не сохранены." : empty ? "Черновик цел." : "В поле новый текст, отправленный текст не возвращён."}`, "bad");
  }

  async function deliver(cs: string, s: Send) {
    const busy = ["busy", "waiting"].includes(String(sessionOf(app, cs)?.state));
    const r = await app.request("session.prompt", { callsign: cs, uuid: s.uuid, text: s.text, ...(s.files.length ? { attachments: s.files } : {}) });
    if (r.ok || r.error === "timeout" || r.error === "disconnected")
      return edit(cs, (t) => {
        const x = t.sends.find((y) => y.uuid === s.uuid);
        if (x) x.state = r.ok ? (busy ? "queued" : "ok") : "pend";
      });
    giveBack(cs, s, r.error);
  }

  return {
    store,
    get,
    edit,
    live,
    can,
    call,
    async start() {
      drafts = (await app.store<Record<string, string>>("drafts").get()) ?? {};
    },
    stop() {
      for (const cs of [...watching]) unwatch(cs);
      for (const cs of opened.keys()) keepDraft(cs);
      saveDrafts();
    },
    /** Экран открыт: лента и чтение заново; непрочитанное снято. */
    open(cs: string) {
      opened.set(cs, (opened.get(cs) ?? 0) + 1);
      edit(cs, (t) => {
        t.unread = 0;
        t.unreadText = undefined;
      });
      void watch(cs);
    },
    close(cs: string) {
      const left = (opened.get(cs) ?? 1) - 1;
      if (left > 0) return void opened.set(cs, left);
      opened.delete(cs);
      unwatch(cs);
      keepDraft(cs);
      saveDrafts();
    },
    isOpen: (cs: string) => (opened.get(cs) ?? 0) > 0,
    async older(cs: string) {
      const first = get(cs).msgs.find((m) => m.uuid && !String(m.uuid).startsWith("x:"));
      const r = await app.request<{ messages: Msg[]; more: boolean }>("session.history", { callsign: cs, before: first?.uuid ?? null, limit: HISTORY });
      if (!r.ok) return app.toast(`${cs}: session.history — ${r.error}`, "bad");
      edit(cs, (t) => {
        const have = uuids(t.msgs);
        t.msgs = [...r.result.messages.filter((m) => !have.has(m.uuid)), ...t.msgs];
        t.more = r.result.more;
      });
    },
    send(cs: string, text: string, files: Att[]) {
      const s: Send = { uuid: crypto.randomUUID(), text, files, at: Date.now(), state: "sending" };
      edit(cs, (t) => {
        t.sends.push(s);
        t.draft = "";
        t.files = [];
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
      const r = await call<boolean>(cs, "cancelAsyncMessage", [uuid]);
      const s = get(cs).sends.find((x) => x.uuid === uuid);
      if (!r.ok) return app.toast(`${cs}: cancelAsyncMessage — ${say(cs, r.error)}`, "bad");
      if (r.result && s) giveBack(cs, s);
      else app.toast("Claude уже взял это сообщение", "bad");
    },
    /** Действие сессии: отказ — тост «позывной: метод — слово». */
    async act(cs: string, method: string, args: unknown[] = []) {
      const r = await call(cs, method, args);
      if (!r.ok) app.toast(`${cs}: ${method} — ${say(cs, r.error)}`, "bad");
      return r;
    },
    async side(cs: string, q: string) {
      const id = ++n;
      edit(cs, (t) => {
        t.sides.push({ id, q, state: "wait" });
        t.draft = "";
      });
      const r = await call<{ response?: string | null }>(cs, "askSideQuestion", [q]);
      edit(cs, (t) => {
        const x = t.sides.find((y) => y.id === id);
        if (x) Object.assign(x, r.ok ? { state: "done", a: r.result?.response ?? undefined } : { state: "bad", a: say(cs, r.error) });
      });
    },
    async rewind(cs: string, uuid: string, apply: boolean) {
      edit(cs, (t) => void (t.rewinds[uuid] = { state: apply ? "apply" : "probe", text: apply ? "Откатываю…" : "Проба отката…" }));
      const r = await call<{ canRewind?: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }>(cs, "rewindFiles", apply ? [uuid] : [uuid, { dryRun: true }]);
      const word = (e: string) => linkText(e, machineOf(cs));
      edit(cs, (t) => {
        if (apply) t.rewinds[uuid] = r.ok ? { state: "done", text: "Файлы откачены к этому сообщению." } : { state: "bad", text: `Не откатилось: ${word(r.error)}` };
        else if (!r.ok) t.rewinds[uuid] = { state: "no", text: `Откатить нельзя: ${word(r.error)}` };
        else if (!r.result?.canRewind) t.rewinds[uuid] = { state: "no", text: `Откатить нельзя: ${r.result?.error ?? "canRewind: false"}` };
        else t.rewinds[uuid] = { state: "ask", text: probeText(r.result) };
      });
    },
    async models(cs: string) {
      if (get(cs).models || !live(cs) || !can(cs, "session.call")) return;
      edit(cs, (t) => void (t.models = "loading"));
      const r = await call<ModelInfo[]>(cs, "supportedModels", [], true);
      edit(cs, (t) => void (t.models = r.ok ? r.result : undefined));
    },
    async commands(cs: string) {
      if (get(cs).commands || !can(cs, "session.call")) return;
      edit(cs, (t) => void (t.commands = "loading"));
      const r = await call<Cmd[]>(cs, "supportedCommands", [], true);
      edit(cs, (t) => void (t.commands = r.ok && Array.isArray(r.result) ? r.result : []));
    },
    frames: {
      "session.events"(f: Frame) {
        const cs = String(f.from);
        if (!watching.has(cs)) return;
        const t = get(cs);
        const gap = t.seq !== undefined && typeof f.seq === "number" && f.seq !== t.seq + 1;
        const at = Date.now();
        edit(cs, (x) => {
          x.msgs.push(...((f.events ?? []) as Msg[]).map((m) => ({ ...m, _at: at })));
          if (typeof f.seq === "number") x.seq = f.seq;
        });
        if (gap) void history(cs);
      },
      message(f: Frame, ctx: { open: boolean }) {
        const cs = String(f.from);
        if (ctx.open) app.open("chat", { callsign: cs });
        const text = typeof f.text === "string" ? f.text : undefined;
        const body = (f.notify as { body?: string } | undefined)?.body;
        edit(cs, (t) => {
          t.msgs.push({ type: "x-message", uuid: `x:${++n}`, text: text ?? body ?? "", push: text === undefined, at: Date.now() });
          if ((opened.get(cs) ?? 0) > 0) return;
          t.unread += 1;
          t.unreadText = text ?? body;
        });
      },
    },
    roster(r: Roster) {
      for (const c of accountChanges(r, (cs) => known[cs])) {
        known[c.callsign] = c.account;
        if (c.from !== undefined && store.get()[c.callsign]) edit(c.callsign, (t) => void t.msgs.push({ type: "x-account", uuid: `x:${++n}`, from: c.from, to: c.account }));
      }
    },
    link(state: string, machine?: string) {
      if (state !== "open") {
        watching.clear();
        return;
      }
      for (const cs of opened.keys())
        if (!machine || machineOf(cs) === machine) {
          watching.delete(cs);
          void watch(cs);
        }
    },
  };
}
export type Talks = ReturnType<typeof createTalks>;

function probeText(r: { filesChanged?: string[]; insertions?: number; deletions?: number }): string {
  const files = r.filesChanged?.length ?? 0;
  return `Откатить файлы к этому сообщению? ${files} ${plural(files, "файл", "файла", "файлов")} · +${r.insertions ?? 0} −${r.deletions ?? 0} · команды Bash не откатываются`;
}
