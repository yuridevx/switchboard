// Состояние чата и его действия. Один снимок на все разговоры; виды читают его выборкой, меняют только действия отсюда.
// Лента: session.watch + session.history, склейка по uuid; seq не следующий — снова история.
// Ввод: session.prompt, uuid ставит клиент; обрыв до ответа — «не подтверждено»; отказ — текст и вложения обратно в поле.
// Чего нет в contract машины — того нет на экране и в кадрах.
import type { App, Ctx, Frame, Roster } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { createStore } from "@switchboard/web-ui";
import { addMine, applyEvents, emptyFeed, withHistory, withOlder } from "./feed.ts";
import type { Feed, UserItem } from "./types.ts";
import type { WireMessage } from "./wire.ts";
import { exportMarkdown } from "./export.ts";

export type Attachment = { name: string; media_type: string; data: string };
export type Rewind = { uuid: string; text: string; tone: "" | "bad" | "ok"; ready: boolean };
export type Command = { name: string; description?: string; argumentHint?: string };
/** Что отправка вернула в поле: отказ session.prompt. */
export type Returned = { text: string; attachments: Attachment[] };

export type Conv = {
  feed: Feed;
  /** последний seq пачки; fresh — после session.watch первый кадр принимается с любым seq */
  seq: number | null;
  fresh: boolean;
  watching: boolean;
  /** машина не отдаёт ленту (нет session.watch в её contract) */
  noFeed: boolean;
  /** отказ session.watch или session.history — словом в ленте */
  refused?: string;
  unread: number;
  lastIn?: string;
  /** сколько экранов открыто */
  mounted: number;
  account?: string;
  focus: boolean;
  rewind?: Rewind;
  commands?: Command[] | null;
  returned?: Returned;
  /** уже есть более ранние записи и с какой продолжать */
  more: boolean;
  before: string | null;
};

const newConv = (): Conv => ({ feed: emptyFeed(), seq: null, fresh: true, watching: false, noFeed: false, unread: 0, mounted: 0, focus: false, more: false, before: null });
const EMPTY = newConv();
const PAGE = 50;
const LIVE = ["idle", "busy", "waiting"];
const uuid = (): string => crypto.randomUUID();
const dataUrl = (a: Attachment) => `data:${a.media_type};base64,${a.data}`;

export type ChatStore = ReturnType<typeof createChatStore>;

export function createChatStore() {
  let app: App;
  const store = createStore<{ convs: Record<string, Conv> }>({ convs: {} }, () => app.changed());
  /** черновики: поле ввода владеет текстом, пока открыто; здесь — что сохранить в хранилище */
  let drafts: Record<string, string> = {};
  let draftsLoaded = false;

  const read = (cs: string): Conv => store.get().convs[cs] ?? EMPTY;
  const edit = (cs: string, change: (c: Conv) => void) =>
    store.set((s) => {
      change((s.convs[cs] ??= newConv()) as Conv);
    });
  const fold = (cs: string, change: (f: Feed) => Feed) => edit(cs, (c) => void (c.feed = change(read(cs).feed)));

  const sessionOf = (cs: string) => app.roster()?.sessions.find((s) => s.callsign === cs);
  const isLive = (cs: string) => LIVE.includes(String(sessionOf(cs)?.state));
  const can = (cs: string, name: string) => {
    const m = machineOf(cs);
    return !!m && app.can(m, name) === true;
  };

  async function history(cs: string) {
    if (!can(cs, "session.history")) return;
    const r = await app.request<{ messages: WireMessage[]; more?: boolean }>("session.history", { callsign: cs, before: null, limit: PAGE });
    if (!r.ok) {
      edit(cs, (c) => void (c.refused ??= `session.history: ${r.error}`));
      return;
    }
    const messages = r.result.messages ?? [];
    edit(cs, (c) => {
      if (c.refused?.startsWith("session.history")) c.refused = undefined;
      c.feed = withHistory(read(cs).feed, messages);
      c.more = !!r.result.more;
      c.before = messages[0]?.uuid ?? null;
    });
  }

  /** Открыть ленту: сначала session.watch, потом session.history. */
  async function watch(cs: string) {
    const m = machineOf(cs) ?? "";
    // возможности — по roster: нет session.watch — ленты нет, переписка и ввод работают
    edit(cs, (c) => void (c.noFeed = app.can(m, "session.watch") === false));
    if (can(cs, "session.watch")) {
      const r = await app.request("session.watch", { callsign: cs });
      edit(cs, (c) => {
        c.refused = r.ok ? undefined : `session.watch: ${r.error}`;
        if (r.ok) {
          c.watching = true;
          c.fresh = true;
        }
      });
    }
    await history(cs);
  }

  async function unwatch(cs: string) {
    if (!read(cs).watching) return;
    edit(cs, (c) => void (c.watching = false));
    await app.request("session.unwatch", { callsign: cs });
  }

  async function saveDrafts() {
    await app.store<Record<string, string>>("drafts").set(Object.fromEntries(Object.entries(drafts).filter(([, v]) => v)));
  }

  function refusalText(cs: string, word: string): string {
    if (word === "offline") return `${machineOf(cs)} не на связи`;
    if (word === "stopped") return "сессия остановлена";
    return word;
  }

  const setMine = (cs: string, id: string, change: (it: UserItem) => void) =>
    edit(cs, (c) => {
      const it = c.feed.items.findLast((i) => i.id === id);
      if (it?.kind === "user") change(it);
    });

  async function deliver(cs: string, id: string, text: string, attachments: Attachment[]) {
    const r = await app.request("session.prompt", { callsign: cs, text, uuid: id, ...(attachments.length ? { attachments } : {}) });
    if (r.ok) {
      setMine(cs, id, (it) => {
        if (it.state === "sending") it.state = "ok";
        it.at = Date.now();
      });
    } else if (r.error === "disconnected") {
      // ответа не было: дошло или нет — неизвестно; после hello история покажет uuid
      setMine(cs, id, (it) => {
        if (it.state === "sending") it.state = "lost";
      });
    } else {
      edit(cs, (c) => {
        c.feed.items = c.feed.items.filter((i) => i.id !== id);
        c.returned = { text, attachments };
      });
      drafts[cs] = text;
      app.toast(`${cs}: не доставлено — ${refusalText(cs, r.error)}. Черновик цел.`);
    }
  }

  return {
    // ───── выборки ─────
    /** Выборка из разговора: компонент перерисуется, когда изменился её ответ. */
    useConv: <T,>(cs: string, select: (c: Conv) => T): T => app.use(() => select(read(cs))),
    /** Выборка из ядра: roster, метки, связь. */
    useApp: <T,>(select: () => T): T => app.use(select),
    get wide() {
      return app.wide;
    },
    get Slot() {
      return app.Slot;
    },
    nameOf: (cs: string) => app.mark("label.session", cs)?.text ?? cs,
    asked: (cs: string) => app.mark("asked", cs),
    sessionOf,
    isLive,
    can,
    open: (screen: string, params: Record<string, string>) => app.open(screen, params),
    draft: (cs: string) => drafts[cs] ?? "",
    setDraft: (cs: string, text: string) => void (drafts[cs] = text),
    /** Счётчик непрочитанного для метки unread. */
    unread(cs: string) {
      const c = store.get().convs[cs];
      return c?.unread ? { count: c.unread, text: c.lastIn ?? "" } : undefined;
    },

    // ───── жизненный цикл ─────
    async start(a: App) {
      app = a;
      if (!draftsLoaded) {
        drafts = { ...((await app.store<Record<string, string>>("drafts").get()) ?? {}), ...drafts };
        draftsLoaded = true;
      }
    },
    async stop() {
      await saveDrafts();
      for (const [cs, c] of Object.entries(store.get().convs)) if (c.watching) await unwatch(cs);
    },
    /** Экран открыт: подписка на ленту; возврат — закрыть экран. */
    mount(cs: string): () => void {
      edit(cs, (c) => {
        c.mounted++;
        c.unread = 0;
        c.account ??= sessionOf(cs)?.account as string | undefined;
      });
      void watch(cs);
      return () => {
        edit(cs, (c) => void c.mounted--);
        void saveDrafts();
        if (!read(cs).mounted) void unwatch(cs);
      };
    },

    // ───── кадры ядра ─────
    onEvents(f: Frame) {
      const cs = String(f.from);
      const c = read(cs);
      const seq = typeof f.seq === "number" ? f.seq : null;
      const gap = !c.fresh && c.seq !== null && seq !== null && seq !== c.seq + 1;
      edit(cs, (x) => {
        x.fresh = false;
        x.seq = seq;
        x.feed = applyEvents(read(cs).feed, (f.events as WireMessage[]) ?? []);
      });
      // разрыв (Host перезапущен, пачка пропала) — снова история
      if (gap) void history(cs);
    },
    onMessage(f: Frame, ctx: Ctx) {
      const cs = String(f.from);
      const notify = f.notify as { body?: string } | undefined;
      const text = typeof f.text === "string" ? f.text : (notify?.body ?? "");
      edit(cs, (c) => {
        c.feed.n++;
        c.feed.items.push({ kind: "in", id: `in${c.feed.n}`, text, at: Date.now(), push: typeof f.text !== "string" && !!notify });
        if (!c.mounted) {
          c.unread++;
          c.lastIn = text;
        }
      });
      if (ctx.open) app.open("chat", { callsign: cs });
    },
    /** Подмена аккаунта слота видна по roster: у сессии сменилось поле account — строка в ленте. */
    onRoster(r: Roster) {
      for (const s of r.sessions) {
        const known = store.get().convs[s.callsign];
        if (!known || typeof s.account !== "string" || known.account === s.account) continue;
        const account = s.account;
        edit(s.callsign, (c) => {
          if (c.account) {
            c.feed.n++;
            c.feed.items.push({ kind: "sys", id: `sw${c.feed.n}`, sys: { type: "swap", from: c.account, to: account }, at: Date.now() });
          }
          c.account = account;
        });
      }
    },
    /** После своего hello открыть ленты заново: relay перезапускался, подписки могли пропасть. */
    onLink(state: string) {
      if (state !== "open") return;
      for (const [cs, c] of Object.entries(store.get().convs)) {
        if (!c.mounted) continue;
        edit(cs, (x) => void (x.watching = false));
        void watch(cs);
      }
    },

    // ───── ввод ─────
    /** Сообщение человека сессии. Отказ не переотправляется сам. */
    send(cs: string, text: string, attachments: Attachment[]) {
      const id = uuid();
      const images = attachments.filter((a) => a.media_type.startsWith("image/"));
      const files = attachments.filter((a) => !a.media_type.startsWith("image/"));
      fold(cs, (f) => addMine(f, { id, text, images: images.map(dataUrl), files: files.map((a) => a.name), at: Date.now(), queued: sessionOf(cs)?.state === "busy" }));
      delete drafts[cs];
      void deliver(cs, id, text, attachments);
    },
    /** «Отправить ещё раз» пузыря без ответа: тот же uuid. */
    resend(cs: string, id: string, text: string) {
      setMine(cs, id, (it) => void (it.state = "sending"));
      void deliver(cs, id, text, []);
    },
    takeReturned: (cs: string) => edit(cs, (c) => void (c.returned = undefined)),
    /** Текст обратно в поле ввода: «Изменить сообщение» после отказа модели. */
    returnText: (cs: string, text: string) => edit(cs, (c) => void (c.returned = { text, attachments: [] })),
    /** Команды сессии: один запрос на разговор. */
    async commands(cs: string): Promise<Command[]> {
      const known = read(cs).commands;
      if (known) return known;
      if (known === null) return [];
      edit(cs, (c) => void (c.commands = null));
      const r = await app.request<Command[]>("session.call", { callsign: cs, method: "supportedCommands", args: [] });
      const list = r.ok && Array.isArray(r.result) ? r.result : [];
      edit(cs, (c) => void (c.commands = list));
      return list;
    },
    /** Файлы папки сессии для «@». */
    async files(cs: string, query: string): Promise<string[]> {
      const r = await app.request<string[]>("session.files", { callsign: cs, query, limit: 20 });
      return r.ok && Array.isArray(r.result) ? r.result : [];
    },

    // ───── лента ─────
    /** Более ранняя страница истории. */
    async older(cs: string) {
      const c = read(cs);
      if (!c.more || !c.before) return;
      const r = await app.request<{ messages: WireMessage[]; more?: boolean }>("session.history", { callsign: cs, before: c.before, limit: PAGE });
      if (!r.ok) return app.toast(`${cs}: session.history — ${r.error}`);
      const messages = r.result.messages ?? [];
      edit(cs, (x) => {
        x.feed = withOlder(read(cs).feed, messages);
        x.more = !!r.result.more;
        x.before = messages[0]?.uuid ?? null;
      });
    },
    toggleFocus: (cs: string) => edit(cs, (c) => void (c.focus = !c.focus)),
    exportMd: (cs: string) => exportMarkdown(read(cs).feed, cs),

    /** Метод query() сессии; отказ — тост словом. Возврат — ответ или undefined. */
    async call<T = unknown>(cs: string, method: string, args: unknown[] = []): Promise<T | undefined> {
      const r = await app.request<T>("session.call", { callsign: cs, method, args });
      if (r.ok) return r.result;
      app.toast(`${cs}: ${method} — ${r.error}`);
      return undefined;
    },
    // ───── откат файлов ─────
    async probeRewind(cs: string, id: string) {
      edit(cs, (c) => void (c.rewind = { uuid: id, text: "Проба отката…", tone: "", ready: false }));
      const r = await app.request<{ canRewind?: boolean; filesChanged?: string[]; insertions?: number; deletions?: number; error?: string }>("session.call", { callsign: cs, method: "rewindFiles", args: [id, { dryRun: true }] });
      if (read(cs).rewind?.uuid !== id) return;
      edit(cs, (c) => {
        if (!r.ok || r.result?.canRewind === false) {
          c.rewind = { uuid: id, text: `Откатить нельзя: ${r.ok ? (r.result?.error ?? "canRewind: false") : r.error}`, tone: "bad", ready: false };
          return;
        }
        const n = r.result?.filesChanged?.length ?? 0;
        c.rewind = { uuid: id, text: `Откатить файлы к этому сообщению? проба: ${n} файл${n === 1 ? "" : n < 5 ? "а" : "ов"} · +${r.result?.insertions ?? 0} −${r.result?.deletions ?? 0} · команды Bash не откатываются`, tone: "", ready: true };
      });
    },
    async applyRewind(cs: string, id: string) {
      const r = await app.request("session.call", { callsign: cs, method: "rewindFiles", args: [id] });
      edit(cs, (c) => void (c.rewind = { uuid: id, text: r.ok ? "Файлы откачены к этому сообщению." : `Не откатилось: ${r.error}`, tone: r.ok ? "ok" : "bad", ready: false }));
    },
    cancelRewind: (cs: string) => edit(cs, (c) => void (c.rewind = undefined)),
  };
}
