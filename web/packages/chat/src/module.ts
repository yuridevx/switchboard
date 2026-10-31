// web-chat — лента сессии, ввод и переписка с владельцем.
// Лента: session.watch (watch Host) + session.history (chat Host), склейка по uuid; seq не следующий — снова история.
// Ввод: session.prompt — текст человека, uuid ставит клиент; обрыв до ответа — пузырь «не подтверждено».
// Переписка: кадр message с to = это приложение (сессия пишет владельцу), в том числе из уведомления.
import { h, hhmm, duration, sessionLine, stateLabel, type App, type AppModule, type Ctx, type Frame, type ScreenHandle } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { CSS } from "./css.ts";

type Block = { type: string; text?: string; name?: string; id?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean };
/** Сообщение SDK в ленте и истории: рисуются assistant, user, tool_progress, result; прочие пропускаются. */
type SdkMsg = {
  type: string;
  uuid?: string;
  subtype?: string;
  duration_ms?: number;
  tool_use_id?: string;
  elapsed_time_seconds?: number;
  message?: { content?: string | Block[] };
};

type Item =
  | { k: "sdk"; uuid: string; msg: SdkMsg }
  | { k: "in"; text: string; at: number; push: boolean }
  | { k: "me"; uuid: string; text: string; at: number; st: "sending" | "ok" | "lost" };

type Tool = { done: boolean; error: boolean; secs?: number };

type Conv = {
  items: Item[];
  uuids: Set<string>;
  tools: Map<string, Tool>;
  /** последний seq пачки; fresh — после session.watch первый кадр принимается с любым seq */
  seq: number | null;
  fresh: boolean;
  watching: boolean;
  /** машина не отдаёт ленту (нет session.watch в её contract) */
  noFeed: boolean;
  unread: number;
  lastIn?: string;
  mounted: number;
};

const uuid = (): string => crypto.randomUUID();

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createChat(): AppModule {
  let app: App;
  const convs = new Map<string, Conv>();
  let drafts: Record<string, string> = {};
  let draftsLoaded = false;

  function conv(callsign: string): Conv {
    let c = convs.get(callsign);
    if (!c) {
      c = { items: [], uuids: new Set(), tools: new Map(), seq: null, fresh: true, watching: false, noFeed: false, unread: 0, mounted: 0 };
      convs.set(callsign, c);
    }
    return c;
  }

  const blocks = (m: SdkMsg): Block[] => (Array.isArray(m.message?.content) ? (m.message!.content as Block[]) : []);

  /** Сообщение SDK → в ленту; повтор по uuid пропускается, итог инструмента — статусом вызова. */
  function addSdk(c: Conv, m: SdkMsg, to: Item[] = c.items) {
    if (m.type === "tool_progress") {
      const t = c.tools.get(String(m.tool_use_id)) ?? { done: false, error: false };
      t.secs = m.elapsed_time_seconds;
      c.tools.set(String(m.tool_use_id), t);
      return;
    }
    if (m.type !== "assistant" && m.type !== "user" && m.type !== "result") return;
    const id = m.uuid ?? uuid();
    if (c.uuids.has(id)) return;
    c.uuids.add(id);
    for (const b of blocks(m)) {
      if (b.type === "tool_use" && b.id && !c.tools.has(b.id)) c.tools.set(b.id, { done: false, error: false });
      if (b.type === "tool_result" && b.tool_use_id) c.tools.set(b.tool_use_id, { ...(c.tools.get(b.tool_use_id) ?? {}), done: true, error: !!b.is_error });
    }
    if (m.type === "user") {
      // свой пузырь с этим uuid — значит, дошёл
      const mine = c.items.find((x) => x.k === "me" && x.uuid === id);
      if (mine && mine.k === "me") {
        mine.st = "ok";
        if (to !== c.items) to.push(mine);
        return;
      }
      if (!textOf(m)) return; // только итоги инструментов
    }
    to.push({ k: "sdk", uuid: id, msg: m });
  }

  function textOf(m: SdkMsg): string {
    const ct = m.message?.content;
    if (typeof ct === "string") return ct;
    return blocks(m)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
  }

  async function history(callsign: string) {
    if (!has(callsign, "session.history")) return;
    const r = await app.request<{ messages: SdkMsg[] }>("session.history", { callsign, before: null, limit: 50 });
    if (!r.ok) return;
    const c = conv(callsign);
    // история — сначала, затем то, чего в ней нет (живые пачки, переписка, свои пузыри)
    const old = c.items;
    const next: Item[] = [];
    c.uuids = new Set();
    for (const m of r.result.messages ?? []) addSdk(c, m, next);
    for (const it of old) {
      if (it.k === "sdk") {
        if (!c.uuids.has(it.uuid)) {
          c.uuids.add(it.uuid);
          next.push(it);
        }
      } else if (!next.includes(it)) next.push(it);
    }
    c.items = next;
    app.changed();
  }

  function has(callsign: string, name: string): boolean {
    const m = machineOf(callsign);
    return !!m && app.provides(m)?.[name] !== undefined;
  }

  /** Открыть ленту: сначала session.watch, потом session.history. */
  async function watch(callsign: string) {
    const c = conv(callsign);
    const m = machineOf(callsign) ?? "";
    // возможности — по roster: нет session.watch — ленты нет, переписка и ввод работают
    c.noFeed = !!app.provides(m) && !has(callsign, "session.watch");
    if (has(callsign, "session.watch")) {
      const r = await app.request("session.watch", { callsign });
      if (r.ok) {
        c.watching = true;
        c.fresh = true;
      }
    }
    await history(callsign);
    app.changed();
  }

  async function unwatch(callsign: string) {
    const c = conv(callsign);
    if (!c.watching) return;
    c.watching = false;
    await app.request("session.unwatch", { callsign });
  }

  function onEvents(f: Frame) {
    const callsign = String(f.from);
    const c = conv(callsign);
    const seq = typeof f.seq === "number" ? f.seq : null;
    const gap = !c.fresh && c.seq !== null && seq !== null && seq !== c.seq + 1;
    c.fresh = false;
    c.seq = seq;
    for (const m of (f.events as SdkMsg[]) ?? []) addSdk(c, m);
    // разрыв (Host перезапущен, пачка пропала) — снова история
    if (gap) void history(callsign);
    app.changed();
  }

  function onMessage(f: Frame, ctx: Ctx) {
    const callsign = String(f.from);
    const c = conv(callsign);
    const notify = f.notify as { body?: string } | undefined;
    const text = typeof f.text === "string" ? f.text : (notify?.body ?? "");
    c.items.push({ k: "in", text, at: Date.now(), push: typeof f.text !== "string" && !!notify });
    if (!c.mounted) {
      c.unread++;
      c.lastIn = text;
    }
    if (ctx.open) app.open("chat", { callsign });
    app.changed();
  }

  /** Сообщение человека сессии. Отказ не переотправляется сам. */
  async function prompt(callsign: string, text: string, id = uuid()): Promise<void> {
    const c = conv(callsign);
    let it = c.items.find((x) => x.k === "me" && x.uuid === id) as Extract<Item, { k: "me" }> | undefined;
    if (!it) {
      it = { k: "me", uuid: id, text, at: Date.now(), st: "sending" };
      c.items.push(it);
    }
    it.st = "sending";
    app.changed();
    const r = await app.request("session.prompt", { callsign, text, uuid: id });
    if (r.ok) {
      it.st = "ok";
      it.at = Date.now();
    } else if (r.error === "disconnected") {
      // ответа не было: дошло или нет — неизвестно; после hello история покажет uuid
      if (it.st === "sending") it.st = "lost";
    } else {
      c.items.splice(c.items.indexOf(it), 1);
      drafts[callsign] = text;
      app.toast(`${callsign}: не доставлено — ${why(callsign, r.error)}. Черновик цел.`);
    }
    app.changed();
  }

  function why(callsign: string, word: string): string {
    if (word === "offline") return `${machineOf(callsign)} не на связи`;
    if (word === "stopped") return "сессия остановлена";
    return word;
  }

  // ───── экран ─────

  function drawItem(c: Conv, callsign: string, it: Item): HTMLElement | HTMLElement[] | null {
    if (it.k === "in") {
      return h(
        "div",
        { class: "chat-in" },
        h("div", { class: "chat-from" }, `${callsign} → вам`, it.push ? h("span", { class: "chat-tag" }, "из уведомления") : null),
        it.text,
        h("small", null, hhmm(it.at)),
      );
    }
    if (it.k === "me") {
      const tail =
        it.st === "ok"
          ? `${hhmm(it.at)} · доставлено`
          : it.st === "sending"
            ? "отправляю…"
            : null;
      return h(
        "div",
        { class: "chat-me" + (it.st === "lost" ? " pend" : "") },
        it.text,
        tail
          ? h("small", null, tail)
          : h(
              "small",
              null,
              "связь оборвалась до ответа — не подтверждено · ",
              h("button", { class: "chat-again", onclick: () => void prompt(callsign, it.text, it.uuid) }, "отправить ещё раз"),
            ),
      );
    }
    const m = it.msg;
    if (m.type === "result") {
      const ok = m.subtype === "success";
      return h("div", { class: "chat-res" }, ok ? `ход закончен${m.duration_ms ? " · " + duration(m.duration_ms) : ""}` : `ход прерван · ${m.subtype}`);
    }
    if (m.type === "user") return h("div", { class: "chat-me" }, textOf(m));
    const out: HTMLElement[] = [];
    for (const b of blocks(m)) {
      if (b.type === "text" && b.text) out.push(h("div", { class: "chat-txt" }, b.text));
      if (b.type === "tool_use") {
        const t = c.tools.get(String(b.id));
        const st = t?.done ? (t.error ? "✗" : "✓") : t?.secs !== undefined ? `${Math.round(t.secs)} с` : "…";
        out.push(h("div", { class: "chat-tool" + (t?.done ? "" : " run") + (t?.error ? " err" : "") }, h("b", null, b.name ?? "?"), h("span", null, toolLine(b.input)), h("em", null, st)));
      }
    }
    return out;
  }

  function mountChat(el: HTMLElement, params: Record<string, string>): ScreenHandle {
    const callsign = params.callsign ?? "";
    const c = conv(callsign);
    c.mounted++;
    c.unread = 0;
    const feed = h("div", { class: "sb-pad chat-feed", "aria-live": "polite" });
    const askBox = h("div", { class: "chat-ask" });
    let askHandle: ScreenHandle | undefined;
    const input = h("textarea", { class: "chat-inp", rows: 1, placeholder: `Написать ${callsign}`, "aria-label": `Написать ${callsign}` }) as HTMLTextAreaElement;
    input.value = drafts[callsign] ?? "";
    const sendBtn = h("button", { class: "chat-send", "aria-label": "Отправить", type: "submit" }, "↑") as HTMLButtonElement;
    const form = h("form", { class: "chat-comp" }, input, sendBtn) as HTMLFormElement;
    const sync = () => {
      drafts[callsign] = input.value;
      sendBtn.disabled = !input.value.trim();
    };
    const send = () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      sync();
      delete drafts[callsign];
      void prompt(callsign, text);
    };
    input.addEventListener("input", sync);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      send();
    });
    sync();
    el.append(h("div", { class: "chat" }, feed, askBox, form));

    function draw() {
      const near = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
      feed.textContent = "";
      if (c.noFeed) feed.append(h("div", { class: "chat-note" }, `${machineOf(callsign)} не отдаёт ленту — только переписка и ввод`));
      for (const it of c.items) {
        const d = drawItem(c, callsign, it);
        if (Array.isArray(d)) feed.append(...d);
        else if (d) feed.append(d);
      }
      if (!c.items.length && !c.noFeed) feed.append(h("div", { class: "chat-note" }, "Сообщений пока нет"));
      if (near || feed.dataset.drawn !== "1") feed.scrollTop = feed.scrollHeight;
      feed.dataset.drawn = "1";
      // вопрос сессии: узко — полоса, которая открывает экран вопроса; широко — экран ask в месте над вводом
      const asked = app.mark("asked", callsign) as string | undefined;
      if (app.wide) {
        if (asked && !askHandle) askHandle = app.open("ask", { callsign }, askBox);
        if (!asked && askHandle) {
          askHandle.close?.();
          askHandle = undefined;
          askBox.textContent = "";
        }
      } else {
        askBox.textContent = "";
        if (asked) askBox.append(h("button", { class: "chat-askbar", onclick: () => app.open("ask", { callsign }) }, h("b", null, "?"), h("span", null, asked), h("em", null, "Ответить")));
      }
    }

    void watch(callsign);
    draw();
    return {
      head: () => {
        const s = app.roster()?.sessions.find((x) => x.callsign === callsign);
        if (!s) return { title: callsign, mono: true, sub: `${machineOf(callsign)} не на связи` };
        const st = stateLabel(s.state);
        return { title: callsign, mono: true, sub: sessionLine(s, true), pill: { text: st.text, tone: st.tone } };
      },
      refresh: () => {
        c.unread = 0;
        if (input.value !== (drafts[callsign] ?? "") && document.activeElement !== input) input.value = drafts[callsign] ?? "";
        sync();
        draw();
      },
      close: () => {
        c.mounted--;
        askHandle?.close?.();
        void store();
        if (!c.mounted) void unwatch(callsign);
      },
    };
  }

  async function store() {
    await app.store<Record<string, string>>("drafts").set(Object.fromEntries(Object.entries(drafts).filter(([, v]) => v)));
  }

  return {
    frames: { "session.events": onEvents, message: onMessage },
    on: {
      link: (s) => {
        // после своего hello — открыть ленты заново: relay перезапускался, подписки могли пропасть
        if (s !== "open") return;
        for (const [callsign, c] of convs) {
          if (!c.mounted) continue;
          c.watching = false;
          void watch(callsign);
        }
      },
    },
    screens: { chat: { label: "Лента", mount: mountChat } },
    marks: {
      unread: (callsign: string) => {
        const c = convs.get(callsign);
        return c?.unread ? { count: c.unread, text: c.lastIn ?? "" } : undefined;
      },
    },
    store: ["drafts"],
    css: CSS,
    async start(a) {
      app = a;
      if (!draftsLoaded) {
        drafts = { ...((await app.store<Record<string, string>>("drafts").get()) ?? {}), ...drafts };
        draftsLoaded = true;
      }
    },
    async stop() {
      await store();
      for (const [callsign, c] of convs) if (c.watching) await unwatch(callsign);
    },
  };
}

/** Одна строка вызова инструмента: команда, файл, шаблон или адрес. */
function toolLine(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  for (const k of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    if (typeof input[k] === "string") return input[k] as string;
  }
  const s = JSON.stringify(input);
  return s === "{}" ? "" : s;
}
