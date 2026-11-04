// Состояние чата и его действия. Один снимок на все разговоры; виды читают его выборкой, меняют только действия отсюда.
// Лента: session.watch + session.history, склейка по uuid; seq не следующий — снова история.
// Ввод: session.prompt, uuid ставит клиент; обрыв до ответа — «не подтверждено»; отказ — текст и вложения обратно в поле.
// Чего нет в contract машины — того нет на экране и в кадрах.
import type { App, Ctx, Frame, Roster } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import type { ModelInfo } from "@switchboard/web-ui";
import { accountChanges, createStore, isLive as stateIsLive, sessionLabel, sessionOf as findSession, linkText, type Result } from "@switchboard/web-ui";
import { addIn, addMine, addSwap, applyEvents, dropItem, editMine, emptyFeed, withHistory, withOlder } from "./feed.ts";
import type { Feed, UserItem } from "./types.ts";
import type { WireMessage } from "./wire.ts";
import { exportMarkdown } from "./export.ts";

export type Attachment = { name: string; media_type: string; data: string };
export type Rewind = { uuid: string; text: string; tone: "" | "bad" | "ok"; ready: boolean };
export type Command = { name: string; description?: string; argumentHint?: string };
export type Model = ModelInfo;
/** Что отправка вернула в поле: отказ session.prompt. id — чьё: второй такой же отказ тоже возвращает. */
/** Вопрос сбоку: в разговор не попадает. Нет ни ответа, ни отказа — Claude думает. */
export type Side = { id: string; q: string; a?: string; err?: string };

/** Что вернулось в поле: id делает каждый возврат новым значением выборки. */
export type Returned = { id: string; attachments: Attachment[] };

export type Conv = {
  feed: Feed;
  /** последний seq пачки; fresh — после session.watch первый кадр принимается с любым seq */
  seq: number | null;
  fresh: boolean;
  watching: boolean;
  /** подписка и чтение истории в пути: второй такой же обмен не нужен */
  opening?: boolean;
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
  /** модели SDK: null — запрос в пути; отказ — нет значения, следующий экран спросит снова */
  models?: Model[] | null;
  returned?: Returned;
  /** уже есть более ранние записи и с какой продолжать */
  more: boolean;
  before: string | null;
  /** машина вернулась, пока подписка шла: отказ прежнего Host — спросить заново */
  again?: boolean;
  /** вложения сообщений без ответа: «отправить ещё раз» шлёт их снова */
  held: Record<string, Attachment[]>;
  sides: Side[];
};

const newConv = (): Conv => ({ feed: emptyFeed(), seq: null, fresh: true, watching: false, noFeed: false, unread: 0, mounted: 0, focus: false, more: false, before: null, held: {}, sides: [] });
const EMPTY = newConv();
const PAGE = 50;
const uuid = (): string => crypto.randomUUID();
const dataUrl = (a: Attachment) => `data:${a.media_type};base64,${a.data}`;

export type ChatStore = ReturnType<typeof createChatStore>;

export function createChatStore(app: App) {
  const store = createStore<{ convs: Record<string, Conv> }>({ convs: {} }, () => app.changed());
  /** Черновики — вне снимка: текстом владеет поле ввода, выборок на них нет; буква не будит экраны. Здесь — что сохранить в хранилище. */
  const drafts: Record<string, string> = {};
  const setDraftOf = (cs: string, text: string) => void (drafts[cs] = text);
  const dropDraft = (cs: string) => void delete drafts[cs];

  const read = (cs: string): Conv => store.get().convs[cs] ?? EMPTY;
  const edit = (cs: string, change: (c: Conv) => void) =>
    store.set((s) => {
      change((s.convs[cs] ??= newConv()) as Conv);
    });
  const fold = (cs: string, change: (f: Feed) => Feed) => edit(cs, (c) => void (c.feed = change(read(cs).feed)));

  const sessionOf = (cs: string) => findSession(app, cs);
  const isLive = (cs: string) => stateIsLive(sessionOf(cs)?.state);
  const can = (cs: string, name: string) => {
    const m = machineOf(cs);
    return !!m && app.can(m, name) === true;
  };
  /** Методы query() доступны: у живой сессии на машине с session.call. */
  const canCall = (cs: string) => isLive(cs) && can(cs, "session.call");

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
      // ранние страницы уже в ленте: «Раньше» продолжает с них, а не с начала этой страницы
      const pagedBack = c.before && c.feed.seen[c.before] && !messages.some((m) => m.uuid === c.before);
      c.feed = withHistory(read(cs).feed, messages);
      if (pagedBack) return;
      c.more = !!r.result.more;
      c.before = messages[0]?.uuid ?? null;
    });
  }

  /** Открыть ленту: сначала session.watch, потом session.history. */
  async function watch(cs: string) {
    const was = read(cs);
    if (was.opening) return;
    const m = machineOf(cs) ?? "";
    // возможности — по roster: нет session.watch — ленты нет, переписка и ввод работают
    edit(cs, (c) => {
      c.noFeed = app.can(m, "session.watch") === false;
      c.opening = true;
      c.watching = false;
    });
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
    edit(cs, (c) => void (c.opening = false));
    // отказал прежний Host, а новый уже в roster: его подписку пропустили, пока шла эта
    const again = read(cs).again;
    if (again) edit(cs, (c) => void (c.again = false));
    if (again && read(cs).refused && read(cs).mounted) await watch(cs);
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
    if (word === "stopped") return "сессия остановлена";
    if (word === "sdk_error") return "Claude отказал, причина в журнале машины";
    return linkText(word, machineOf(cs));
  }

  const setMine = (cs: string, id: string, change: (it: UserItem) => void) => fold(cs, (f) => editMine(f, id, change));

  /** Метод query() сессии как есть: отказ словом для человека достаётся вызывающему. */
  const ask = async <T,>(cs: string, method: string, args: unknown[] = []) => {
    const r = (await app.request<T>("session.call", { callsign: cs, method, args })) as Result<T>;
    return r.ok ? r : { ...r, error: refusalText(cs, r.error) };
  };

  /** Ход идёт: ввод ждёт в очереди, ход можно прервать. Сессия, ждущая человека, — тоже посреди хода. */
  const inTurn = (cs: string) => {
    const st = sessionOf(cs)?.state;
    return st === "busy" || st === "waiting";
  };

  /** Текст и вложения обратно в поле, своего пузыря больше нет. Напечатанное человеком не затирается. */
  function giveBack(cs: string, id: string, text: string, attachments: Attachment[] = []) {
    if (!drafts[cs]) setDraftOf(cs, text);
    fold(cs, (f) => dropItem(f, id));
    edit(cs, (c) => {
      c.returned = { id, attachments };
      delete c.held[id];
    });
  }

  async function deliver(cs: string, id: string, text: string, attachments: Attachment[]) {
    const r = await app.request("session.prompt", { callsign: cs, text, uuid: id, ...(attachments.length ? { attachments } : {}) });
    if (r.ok) {
      setMine(cs, id, (it) => {
        if (it.state === "sending") it.state = "ok";
        it.at = Date.now();
      });
      // в занятой сессии вложения ждут эха: снятое из очереди возвращает их в поле
      const queued = read(cs).feed.items.some((i) => i.id === id && i.kind === "user" && i.queued);
      if (!queued) edit(cs, (c) => void delete c.held[id]);
    } else if (r.error === "disconnected" || r.error === "timeout") {
      // ответа не было: дошло или нет — неизвестно; после hello история покажет uuid
      setMine(cs, id, (it) => {
        if (it.state === "sending") it.state = "lost";
      });
    } else {
      // поле занято новым текстом — отказанный туда не вернётся; экран закрыт — вложениям негде ждать: сказать, а не обещать
      const typed = !!drafts[cs];
      const closed = !read(cs).mounted && attachments.length > 0;
      giveBack(cs, id, text, attachments);
      app.toast(`${cs}: не доставлено — ${refusalText(cs, r.error)}. ${typed ? "В поле новый текст, отправленный текст не возвращён." : closed ? "Черновик цел, вложения не сохранены." : "Черновик цел."}`);
    }
  }

  return {
    // ───── выборки ─────
    conv: read,
    nameOf: (cs: string) => sessionLabel(app, cs).text,
    sessionOf,
    isLive,
    can,
    canCall,
    draft: (cs: string) => drafts[cs] ?? "",
    setDraft: setDraftOf,
    /** Счётчик непрочитанного для метки unread. */
    unread(cs: string) {
      const c = store.get().convs[cs];
      return c?.unread ? { count: c.unread, text: c.lastIn ?? "" } : undefined;
    },

    // ───── жизненный цикл ─────
    async start() {
      const saved = (await app.store<Record<string, string>>("drafts").get()) ?? {};
      // напечатанное, пока читалось хранилище, важнее сохранённого
      for (const [cs, text] of Object.entries(saved)) drafts[cs] ??= text;
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
        for (const id of Object.keys(x.held)) {
          const it = x.feed.items.find((i) => i.id === id);
          if (it?.kind === "user" && it.state === "echo") delete x.held[id];
        }
      });
      // разрыв (Host перезапущен, пачка пропала) — снова история
      if (gap) void history(cs);
    },
    onMessage(f: Frame, ctx: Ctx) {
      const cs = String(f.from);
      const notify = f.notify as { body?: string } | undefined;
      const text = typeof f.text === "string" ? f.text : (notify?.body ?? "");
      fold(cs, (feed) => addIn(feed, text, Date.now(), typeof f.text !== "string" && !!notify));
      edit(cs, (c) => {
        if (!c.mounted) {
          c.unread++;
          c.lastIn = text;
        }
      });
      if (ctx.open) app.open("chat", { callsign: cs });
    },
    /** Подмена аккаунта слота видна по roster: у сессии сменилось поле account — строка в ленте. Машина появилась или поднялась заново — открытая лента подписывается снова. */
    onRoster(r: Roster) {
      for (const { callsign, from, account } of accountChanges(r, (cs) => store.get().convs[cs]?.account)) {
        if (!store.get().convs[callsign]) continue;
        if (from) fold(callsign, (f) => addSwap(f, from, account, Date.now()));
        edit(callsign, (c) => void (c.account = account));
      }
    },
    /** После своего hello открыть ленты заново: relay перезапускался, подписки могли пропасть. */
    onLink(state: string, machine?: string) {
      if (state !== "open") return;
      for (const [cs, c] of Object.entries(store.get().convs)) {
        if (!c.mounted || (machine && machineOf(cs) !== machine)) continue;
        if (c.opening) edit(cs, (x) => void (x.again = true));
        void watch(cs);
      }
    },

    // ───── ввод ─────
    /** Сообщение человека сессии. Отказ не переотправляется сам. */
    send(cs: string, text: string, attachments: Attachment[]) {
      const id = uuid();
      const images = attachments.filter((a) => a.media_type.startsWith("image/"));
      const files = attachments.filter((a) => !a.media_type.startsWith("image/"));
      fold(cs, (f) => addMine(f, { id, text, images: images.map(dataUrl), files: files.map((a) => a.name), at: Date.now(), queued: inTurn(cs) }));
      if (attachments.length) edit(cs, (c) => void (c.held[id] = attachments));
      dropDraft(cs);
      void deliver(cs, id, text, attachments);
    },
    /** «Отправить ещё раз» пузыря без ответа: тот же uuid. */
    resend(cs: string, id: string, text: string) {
      setMine(cs, id, (it) => void (it.state = "sending"));
      void deliver(cs, id, text, read(cs).held[id] ?? []);
    },
    /** Снять своё сообщение из очереди: снято — пузыря нет, текст и вложения обратно в поле; Claude уже взял — пузырь остаётся. */
    async unqueue(cs: string, id: string, text: string) {
      const r = await ask<boolean>(cs, "cancelAsyncMessage", [id]);
      if (!r.ok) return app.toast(`${cs}: cancelAsyncMessage — ${r.error}`);
      if (!r.result) return app.toast("Claude уже взял это сообщение");
      giveBack(cs, id, text, [...(read(cs).held[id] ?? [])]);
    },
    /** Вопрос сбоку: ответ по разговору без хода и без записи в разговор. Отказ — слово на его карточке. */
    async askSide(cs: string, q: string) {
      const id = uuid();
      edit(cs, (c) => void c.sides.push({ id, q }));
      const r = await ask<{ response?: string | null } | null>(cs, "askSideQuestion", [q]);
      edit(cs, (c) => {
        const s = c.sides.find((x) => x.id === id);
        if (!s) return;
        if (r.ok) s.a = r.result?.response ?? "Claude не ответил";
        else s.err = r.error;
      });
    },
    dropSide: (cs: string, id: string) => edit(cs, (c) => void (c.sides = c.sides.filter((x) => x.id !== id))),
    ask,
    inTurn,
    /** Перечитать плагины: команды спросятся заново. */
    async reloadPlugins(cs: string) {
      const r = await ask(cs, "reloadPlugins");
      if (!r.ok) return app.toast(`${cs}: reloadPlugins — ${r.error}`);
      edit(cs, (c) => void (c.commands = undefined));
    },
    /** Текст обратно в поле ввода: «Изменить сообщение» после отказа модели. */
    returnText(cs: string, text: string) {
      giveBack(cs, uuid(), text);
    },
    /** Команды сессии — в снимок разговора: один запрос на разговор. */
    async loadCommands(cs: string) {
      if (read(cs).commands !== undefined) return;
      edit(cs, (c) => void (c.commands = null));
      const r = await ask<Command[]>(cs, "supportedCommands");
      edit(cs, (c) => void (c.commands = r.ok && Array.isArray(r.result) ? r.result : []));
    },
    /** Модели SDK — в снимок разговора: один запрос на разговор, а не на каждый показ экрана. */
    /** Модели сессии для метки: ответ SDK за разговор. */
    models: (cs: string) => read(cs).models,
    async loadModels(cs: string) {
      if (read(cs).models !== undefined) return;
      edit(cs, (c) => void (c.models = null));
      const r = await ask<Model[] | null>(cs, "supportedModels");
      edit(cs, (c) => {
        if (r.ok) c.models = Array.isArray(r.result) ? r.result : [];
        else delete c.models;
      });
    },
    /** Файлы папки сессии для «@». */
    files: (cs: string, query: string) => app.request<string[]>("session.files", { callsign: cs, query, limit: 20 }),

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
      const r = await ask<T>(cs, method, args);
      if (r.ok) return r.result;
      app.toast(`${cs}: ${method} — ${r.error}`);
      return undefined;
    },
    // ───── откат файлов ─────
    async probeRewind(cs: string, id: string) {
      edit(cs, (c) => void (c.rewind = { uuid: id, text: "Проба отката…", tone: "", ready: false }));
      const r = await ask<{ canRewind?: boolean; filesChanged?: string[]; insertions?: number; deletions?: number; error?: string }>(cs, "rewindFiles", [id, { dryRun: true }]);
      if (read(cs).rewind?.uuid !== id) return;
      edit(cs, (c) => {
        if (!r.ok || r.result?.canRewind === false) {
          c.rewind = { uuid: id, text: `Откатить нельзя: ${r.ok ? (r.result?.error ?? "canRewind: false") : r.error}`, tone: "bad", ready: false };
          return;
        }
        const n = r.result?.filesChanged?.length ?? 0;
        c.rewind = { uuid: id, text: `Откатить файлы к этому сообщению? ${n} файл${n === 1 ? "" : n < 5 ? "а" : "ов"} · +${r.result?.insertions ?? 0} −${r.result?.deletions ?? 0} · команды Bash не откатываются`, tone: "", ready: true };
      });
    },
    async applyRewind(cs: string, id: string) {
      const r = await ask(cs, "rewindFiles", [id]);
      edit(cs, (c) => void (c.rewind = { uuid: id, text: r.ok ? "Файлы откачены к этому сообщению." : `Не откатилось: ${r.error}`, tone: r.ok ? "ok" : "bad", ready: false }));
    },
    cancelRewind: (cs: string) => edit(cs, (c) => void (c.rewind = undefined)),
  };
}
