// Состояние чата страницы: разговоры по callsign, подписка на ленту, отправка и черновики.
// Разговор — журнал сообщений; вид — его свёртка. История вливается в журнал, и вид считается заново.
import type { Frame, Roster } from "@switchboard/relay";
import type { App, ModelInfo } from "@switchboard/web-ui";
import { accountChanges, createStore, duration, hhmm, isLive, sessionOf } from "@switchboard/web-ui";
import { machineOf as machineOfAddress } from "@switchboard/protocol";
import { exportMarkdown } from "./export.ts";
import { emptyView, fold, foldAll, type FoldEnv, type Msg, type View } from "./fold.ts";
import { refusalText } from "./words.ts";

export type Attachment = { name: string; media_type: string; data: string };
export type SendState = "sending" | "ok" | "echo" | "lost";
export type Send = { state: SendState; queued: boolean; text: string; files: Attachment[]; at: number };
export type Side = { id: number; question: string; state: "wait" | "done" | "bad"; answer: string };
export type Command = { name: string; description?: string };
export type Rewind = { uuid: string; text: string; tone: "" | "bad" | "ok"; ready: boolean };

/** Вложения, вернувшиеся в поле: n растёт, поле берёт их и черновик один раз. */
export type Fill = { n: number; files: Attachment[] };

export type Conv = {
  view: View;
  sends: Record<string, Send>;
  /** отказ подписки или истории: виден в ленте словом */
  error: string;
  more: boolean;
  unread: number;
  unreadText: string;
  sides: Side[];
  fill: Fill;
  focus: boolean;
  rewind?: Rewind;
  /** команды сессии: один запрос на разговор; null — запрос в пути */
  commands?: Command[] | null;
  /** модели SDK: null — запрос в пути; отказ — нет значения, следующий показ спросит снова */
  models?: ModelInfo[] | null;
};

type Root = { convs: Record<string, Conv> };

const LIMIT = 50;
const FILES_LIMIT = 20;
const env: FoldEnv = { duration, time: (t) => hhmm(t * 1000) };
const emptyConv = (): Conv => ({ view: emptyView(), sends: {}, error: "", more: false, unread: 0, unreadText: "", sides: [], fill: { n: 0, files: [] }, focus: false });
const EMPTY = emptyConv();
const machineOf = (cs: string) => machineOfAddress(cs) ?? "";

export type Chat = ReturnType<typeof createState>;

export function createState(app: App) {
  const store = createStore<Root>({ convs: {} }, () => app.changed());
  /** журналы вне снимка: разговор длинный, а вид из него считается */
  const logs = new Map<string, Msg[]>();
  /** кто смотрит разговор: экран и карточка могут стоять вместе */
  const refs = new Map<string, number>();
  /** подписка: какой обмен сейчас, новая отменяет прежний; новый запуск Host ядро объявляет через on.link */
  const subs = new Map<string, { token: number; seq: number | null; reading: boolean }>();
  const accounts = new Map<string, string>();
  let drafts: Record<string, string> = {};
  let tokenN = 0;
  let inboxN = 0;
  let sideN = 0;

  const conv = (cs: string): Conv => store.get().convs[cs] ?? EMPTY;
  const edit = (cs: string, fn: (c: Conv) => void) => store.set((d) => fn((d.convs[cs] ??= emptyConv()) as Conv));
  const logOf = (cs: string) => {
    let l = logs.get(cs);
    if (!l) logs.set(cs, (l = []));
    return l;
  };

  /** Новое сообщение: журнал и шаг свёртки; время прихода — у страницы. Эхо своего сообщения только отмечает его доставленным. */
  function add(cs: string, raw: Msg): void {
    const m: Msg = { ...raw, _at: Date.now() };
    const own = typeof m.uuid === "string" ? conv(cs).sends[m.uuid] : undefined;
    if (own && !m._own) return edit(cs, (c) => void (c.sends[m.uuid as string].state = "echo"));
    if (typeof m.uuid === "string" && m.type !== "stream_event") logOf(cs).push(m);
    const next = fold(conv(cs).view, m, env);
    edit(cs, (c) => void (c.view = next));
  }

  const rebuild = (cs: string) => {
    const next = foldAll(logOf(cs), env);
    edit(cs, (c) => void (c.view = next));
  };

  /** Страница истории: первая заменяет то, что нашла, и прежнее не из неё остаётся следом; более ранняя — перед журналом. */
  function merge(cs: string, page: Msg[], older: boolean): void {
    const log = logOf(cs);
    const ids = new Set(page.map((m) => m.uuid));
    const rest = log.filter((m) => !ids.has(m.uuid));
    let next: Msg[];
    if (older) next = [...page, ...rest];
    else {
      const first = log.findIndex((m) => ids.has(m.uuid));
      const head = first < 0 ? [] : log.slice(0, first);
      const headIds = new Set(head.map((m) => m.uuid));
      next = [...head, ...page, ...rest.filter((m) => !headIds.has(m.uuid))];
    }
    logs.set(cs, next);
    edit(cs, (c) => {
      for (const m of page) if (typeof m.uuid === "string" && c.sends[m.uuid]) c.sends[m.uuid].state = "echo";
    });
    rebuild(cs);
  }

  // ───────────── подписка ─────────────

  const can = (cs: string, name: string) => app.can(machineOf(cs), name) === true;

  async function readHistory(cs: string, token: () => boolean): Promise<void> {
    const sub = subs.get(cs);
    if (!sub) return;
    sub.reading = true;
    const r = await app.request<{ messages?: Msg[]; more?: boolean }>("session.history", { callsign: cs, before: null, limit: LIMIT });
    sub.reading = false;
    if (!token()) return;
    if (!r.ok) return edit(cs, (c) => void (c.error ||= `session.history: ${r.error}`));
    merge(cs, r.result?.messages ?? [], false);
    edit(cs, (c) => {
      c.more = r.result?.more === true;
      if (c.error.startsWith("session.history")) c.error = "";
    });
  }

  async function subscribe(cs: string): Promise<void> {
    const token = ++tokenN;
    subs.set(cs, { token, seq: null, reading: false });
    const fresh = () => subs.get(cs)?.token === token;
    if (can(cs, "session.watch")) {
      const w = await app.read("session.watch", { callsign: cs });
      if (!fresh()) return;
      edit(cs, (c) => void (c.error = w.ok ? "" : `session.watch: ${w.error}`));
    }
    if (can(cs, "session.history")) await readHistory(cs, fresh);
  }

  /** Открытые разговоры подписаны, когда их машина на связи. */
  function sync(): void {
    if (app.link() !== "open") return;
    for (const cs of refs.keys()) {
      if (!subs.has(cs) && (can(cs, "session.watch") || can(cs, "session.history"))) void subscribe(cs);
    }
  }

  function unwatch(cs: string): void {
    if (subs.delete(cs) && can(cs, "session.watch")) void app.read("session.unwatch", { callsign: cs });
  }

  const saveDrafts = () => app.store<Record<string, string>>("drafts").set(Object.fromEntries(Object.entries(drafts).filter(([, v]) => v)));

  function setDraft(cs: string, text: string): void {
    if (text) drafts[cs] = text;
    else delete drafts[cs];
  }

  function onEvents(f: Frame): void {
    const cs = String(f.from);
    const sub = subs.get(cs);
    if (!sub) return;
    for (const m of (f.events as Msg[] | undefined) ?? []) add(cs, m);
    if (typeof f.seq !== "number") return;
    const gap = sub.seq !== null && f.seq !== sub.seq + 1;
    sub.seq = f.seq;
    // разрыв seq: что пропало, знает история; подписка та же
    if (gap && !sub.reading && can(cs, "session.history")) void readHistory(cs, () => subs.get(cs) === sub);
  }

  function onMessage(f: Frame, open: boolean): void {
    const cs = String(f.from);
    const notify = f.notify as { body?: string } | undefined;
    const body = typeof f.text === "string" ? f.text : notify?.body;
    add(cs, { type: "_inbox", uuid: `inbox-${++inboxN}`, from: cs, text: body ?? "", push: typeof f.text !== "string" && !!notify, at: Date.now() });
    if (!refs.get(cs)) edit(cs, (c) => void ((c.unread += 1), (c.unreadText = body ?? "")));
    if (open) app.open("chat", { callsign: cs });
  }

  function onRoster(r: Roster): void {
    for (const x of accountChanges(r, (cs) => accounts.get(cs))) {
      accounts.set(x.callsign, x.account);
      if (x.from && store.get().convs[x.callsign]) add(x.callsign, { type: "_swap", uuid: `swap-${++inboxN}`, text: `аккаунт: ${x.from} → ${x.account}` });
    }
  }

  // ───────────── отправка ─────────────

  /** Методы query() доступны: у живой сессии на машине с session.call. */
  const canCall = (cs: string) => isLive(sessionOf(app, cs)?.state) && can(cs, "session.call");
  const word = <T,>(cs: string, r: Awaited<ReturnType<typeof app.request<T>>>) => (r.ok ? r : { ...r, error: refusalText(r.error, machineOf(cs)) });

  /** Метод query() сессии, который только читает: предел чтения. Отказ — словом для человека. */
  const ask = async <T = unknown,>(cs: string, method: string, args: unknown[] = []) => word<T>(cs, await app.read<T>("session.call", { callsign: cs, method, args }));

  /** Метод query() сессии, который меняет её или идёт долго. Отказ — словом для человека. */
  const call = async <T = unknown,>(cs: string, method: string, args: unknown[] = []) => word<T>(cs, await app.request<T>("session.call", { callsign: cs, method, args }));

  /** Метод по нажатию: отказ — тостом. */
  async function act<T = unknown>(cs: string, method: string, args: unknown[] = []): Promise<T | undefined> {
    const r = await call<T>(cs, method, args);
    if (r.ok) return r.result;
    app.toast(`${cs}: ${method} — ${r.error}`);
    return undefined;
  }

  const fillInput = (cs: string, files: Attachment[]) => edit(cs, (c) => void (c.fill = { n: c.fill.n + 1, files }));

  /** Своего пузыря больше нет: забыть сообщение и пересчитать ленту. */
  function forget(cs: string, uuid: string): void {
    logs.set(cs, logOf(cs).filter((m) => m.uuid !== uuid));
    edit(cs, (c) => void delete c.sends[uuid]);
    rebuild(cs);
  }

  /** Текст и вложения обратно в поле; напечатанное человеком не затирается. */
  function giveBack(cs: string, uuid: string | null, text: string, files: Attachment[]): void {
    if (!drafts[cs]) setDraft(cs, text);
    if (uuid) forget(cs, uuid);
    fillInput(cs, files);
  }

  async function deliver(cs: string, uuid: string, s: Send): Promise<void> {
    const r = await app.request("session.prompt", { callsign: cs, uuid, text: s.text, ...(s.files.length ? { attachments: s.files } : {}) });
    if (!conv(cs).sends[uuid]) return;
    if (r.ok)
      return edit(cs, (c) => {
        const x = c.sends[uuid];
        if (x.state === "sending") x.state = "ok";
        x.at = Date.now();
      });
    // ответа не дождались: дошло или нет — неизвестно; решает человек
    if (r.error === "timeout" || r.error === "disconnected")
      return edit(cs, (c) => {
        if (c.sends[uuid].state === "sending") c.sends[uuid].state = "lost";
      });
    // поле занято новым текстом — отказанный туда не вернётся; экран закрыт — вложениям негде ждать: сказать, а не обещать
    const typed = !!drafts[cs];
    const closed = !refs.get(cs) && s.files.length > 0;
    giveBack(cs, uuid, s.text, s.files);
    app.toast(`${cs}: не доставлено — ${refusalText(r.error, machineOf(cs))}. ${typed ? "В поле новый текст, отправленный текст не возвращён." : closed ? "Черновик цел, вложения не сохранены." : "Черновик цел."}`);
  }

  function send(cs: string, text: string, files: Attachment[]): void {
    const uuid = crypto.randomUUID();
    const state = sessionOf(app, cs)?.state;
    const s: Send = { state: "sending", queued: state === "busy" || state === "waiting", text, files, at: Date.now() };
    edit(cs, (c) => void (c.sends[uuid] = s));
    const pics = files.filter((f) => f.media_type.startsWith("image/")).map((f) => ({ type: "image", source: { type: "base64", media_type: f.media_type, data: f.data } }));
    add(cs, { type: "user", uuid, _own: true, message: { content: [...pics, { type: "text", text }] } });
    void deliver(cs, uuid, s);
  }

  /** «Отправить ещё раз»: тот же uuid. */
  function again(cs: string, uuid: string): void {
    const s = conv(cs).sends[uuid];
    if (!s) return;
    edit(cs, (c) => void (c.sends[uuid].state = "sending"));
    void deliver(cs, uuid, s);
  }

  /** Снять своё сообщение из очереди: снято — пузыря нет, текст и вложения в поле; Claude уже взял — пузырь остаётся. */
  async function cancel(cs: string, uuid: string): Promise<void> {
    const s = conv(cs).sends[uuid];
    if (!s) return;
    const r = await call<boolean>(cs, "cancelAsyncMessage", [uuid]);
    if (!r.ok) return app.toast(`${cs}: cancelAsyncMessage — ${r.error}`);
    if (!r.result) return app.toast("Claude уже взял это сообщение");
    giveBack(cs, uuid, s.text, s.files);
  }

  /** Вопрос сбоку: ответ по разговору без хода и без записи в разговор. Отказ — слово на его карточке. */
  async function side(cs: string, question: string): Promise<void> {
    const id = ++sideN;
    edit(cs, (c) => void c.sides.push({ id, question, state: "wait", answer: "" }));
    const r = await call<{ response?: string | null } | null>(cs, "askSideQuestion", [question]);
    edit(cs, (c) => {
      const x = c.sides.find((y) => y.id === id);
      if (!x) return;
      x.state = r.ok ? "done" : "bad";
      x.answer = r.ok ? (r.result?.response ?? "Claude не ответил") : r.error;
    });
  }

  /** Команды сессии — в снимок разговора: один запрос на разговор. */
  async function loadCommands(cs: string): Promise<void> {
    if (conv(cs).commands !== undefined) return;
    edit(cs, (c) => void (c.commands = null));
    const r = await ask<Command[]>(cs, "supportedCommands");
    edit(cs, (c) => void (c.commands = r.ok && Array.isArray(r.result) ? r.result : []));
  }

  /** Модели SDK — в снимок разговора: один запрос на разговор, а не на каждый показ экрана. */
  async function loadModels(cs: string): Promise<void> {
    if (conv(cs).models !== undefined) return;
    edit(cs, (c) => void (c.models = null));
    const r = await ask<ModelInfo[] | null>(cs, "supportedModels");
    edit(cs, (c) => {
      if (r.ok) c.models = Array.isArray(r.result) ? r.result : [];
      else delete c.models;
    });
  }

  /** Проба отката файлов к сообщению: сначала без правок, откат — по нажатию. */
  async function probeRewind(cs: string, uuid: string): Promise<void> {
    edit(cs, (c) => void (c.rewind = { uuid, text: "Проба отката…", tone: "", ready: false }));
    const r = await ask<{ canRewind?: boolean; filesChanged?: string[]; insertions?: number; deletions?: number; error?: string }>(cs, "rewindFiles", [uuid, { dryRun: true }]);
    if (conv(cs).rewind?.uuid !== uuid) return;
    edit(cs, (c) => {
      if (!r.ok || r.result?.canRewind === false) {
        c.rewind = { uuid, text: `Откатить нельзя: ${r.ok ? (r.result?.error ?? "canRewind: false") : r.error}`, tone: "bad", ready: false };
        return;
      }
      const n = r.result?.filesChanged?.length ?? 0;
      c.rewind = { uuid, text: `Откатить файлы к этому сообщению? ${n} файл${n === 1 ? "" : n < 5 ? "а" : "ов"} · +${r.result?.insertions ?? 0} −${r.result?.deletions ?? 0} · команды Bash не откатываются`, tone: "", ready: true };
    });
  }

  async function applyRewind(cs: string, uuid: string): Promise<void> {
    const r = await call(cs, "rewindFiles", [uuid]);
    edit(cs, (c) => void (c.rewind = { uuid, text: r.ok ? "Файлы откачены к этому сообщению." : `Не откатилось: ${r.error}`, tone: r.ok ? "ok" : "bad", ready: false }));
  }

  return {
    store,
    conv,
    can,
    canCall,
    send,
    again,
    cancel,
    side,
    ask,
    call,
    act,
    loadCommands,
    loadModels,
    probeRewind,
    applyRewind,
    cancelRewind: (cs: string) => edit(cs, (c) => void (c.rewind = undefined)),
    /** Перечитать плагины: команды спросятся заново. */
    async reloadPlugins(cs: string) {
      const r = await call(cs, "reloadPlugins");
      if (!r.ok) return app.toast(`${cs}: reloadPlugins — ${r.error}`);
      edit(cs, (c) => void (c.commands = undefined));
    },
    files: (cs: string, query: string) => app.read<string[]>("session.files", { callsign: cs, query, limit: FILES_LIMIT }),
    machineOf,
    draft: (cs: string) => drafts[cs] ?? "",
    setDraft,
    saveDrafts,
    closeSide: (cs: string, id: number) => edit(cs, (c) => void (c.sides = c.sides.filter((x) => x.id !== id))),
    /** Вернуть текст в поле: кнопка плашки «Изменить сообщение». */
    fillText: (cs: string, text: string) => giveBack(cs, null, text, []),
    toggleFocus: (cs: string) => edit(cs, (c) => void (c.focus = !c.focus)),
    exportMd: (cs: string) => exportMarkdown(conv(cs).view, cs),

    /** Экран разговора встал: подписка и снятие метки. */
    mount(cs: string): void {
      refs.set(cs, (refs.get(cs) ?? 0) + 1);
      edit(cs, (c) => void ((c.unread = 0), (c.unreadText = "")));
      sync();
    },
    /** Экран ушёл: черновик в хранилище, последний снимает подписку. */
    unmount(cs: string): void {
      void saveDrafts();
      const n = (refs.get(cs) ?? 1) - 1;
      if (n > 0) return void refs.set(cs, n);
      refs.delete(cs);
      unwatch(cs);
    },

    older: async (cs: string) => {
      const oldest = logOf(cs).find((m) => typeof m.uuid === "string" && !m._own)?.uuid;
      const r = await app.request<{ messages?: Msg[]; more?: boolean }>("session.history", { callsign: cs, before: oldest ?? null, limit: LIMIT });
      if (!r.ok) return app.toast(`${cs}: session.history — ${r.error}`);
      merge(cs, r.result?.messages ?? [], true);
      edit(cs, (c) => void (c.more = r.result?.more === true));
    },

    module: {
      frames: {
        "session.events": (f: Frame) => onEvents(f),
        message: (f: Frame, ctx: { open: boolean }) => onMessage(f, ctx.open),
      },
      on: {
        roster: onRoster,
        link(state: string, machine?: string) {
          if (state !== "open") return;
          for (const cs of subs.keys()) if (!machine || machineOf(cs) === machine) subs.delete(cs);
          sync();
        },
        show: () => sync(),
      },
      async start() {
        const saved = (await app.store<Record<string, string>>("drafts").get()) ?? {};
        // напечатанное, пока читалось хранилище, важнее сохранённого
        drafts = { ...saved, ...drafts };
      },
      /** Штатная остановка: дописать черновики, снять подписки. */
      async stop() {
        await saveDrafts();
        for (const cs of [...subs.keys()]) unwatch(cs);
      },
    },
  };
}
