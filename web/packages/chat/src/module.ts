// web-chat — лента сессии, ввод и переписка с владельцем.
// Лента: session.watch (watch Host) + session.history (chat Host), склейка по uuid; seq не следующий — снова история.
// Ввод: session.prompt — текст человека, uuid ставит клиент; обрыв до ответа — пузырь «не подтверждено».
// Переписка: кадр message с to = это приложение (сессия пишет владельцу), в том числе из уведомления.
// Широкий вид (пульт): ✓ — reply ok, ✓✓ — uuid пришёл в ленте; «@» — session.files, «/» — session.call
// supportedCommands; вложения, «В фон», откат файлов, фокус, выгрузка .md, строка подмены аккаунта из roster.
// Чего нет в contract машины — того нет на экране и в кадрах.
import { add, h, hhmm, sessionLine, stateLabel, type App, type AppModule, type Ctx, type Frame, type Roster, type ScreenHandle } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { CSS } from "./css.ts";
import { blocks, drawSdk, fleetOf, textOf, type SdkMsg, type Task, type Tool, type View } from "./render.ts";
import { SAMPLES } from "./gallery.ts";

type Item =
  | { k: "sdk"; uuid: string; msg: SdkMsg }
  | { k: "in"; text: string; at: number; push: boolean }
  | { k: "me"; uuid: string; text: string; at: number; st: "sending" | "ok" | "echo" | "lost"; queued: boolean }
  | { k: "swap"; from: string; to: string; at: number };

type Todo = { content?: string; activeForm?: string; status?: string };
type Rewind = { uuid: string; text: string; tone: "" | "bad" | "ok"; ready: boolean };
type Attachment = { name: string; media_type: string; data: string };

type Conv = {
  items: Item[];
  uuids: Set<string>;
  tools: Map<string, Tool>;
  tasks: Map<string, Task>;
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
  mounted: number;
  /** широкий вид */
  account?: string;
  suggestion?: string;
  todos?: Todo[];
  commands?: Array<{ name: string; description?: string }> | null;
  focus: boolean;
  rewind?: Rewind;
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
      c = { items: [], uuids: new Set(), tools: new Map(), tasks: new Map(), seq: null, fresh: true, watching: false, noFeed: false, unread: 0, mounted: 0, focus: false };
      convs.set(callsign, c);
    }
    return c;
  }

  /** Сообщение SDK → в ленту; повтор по uuid пропускается, итог инструмента и ход задачи — статусом. */
  function addSdk(c: Conv, m: SdkMsg, to: Item[] = c.items) {
    if (m.type === "tool_progress") {
      const t = c.tools.get(String(m.tool_use_id)) ?? { done: false, error: false };
      t.secs = m.elapsed_time_seconds;
      c.tools.set(String(m.tool_use_id), t);
      return;
    }
    if (m.type === "prompt_suggestion") {
      c.suggestion = typeof m.suggestion === "string" ? m.suggestion : undefined;
      return;
    }
    if (m.type === "system" && m.task_id && m.subtype !== "task_started") {
      // ход задачи субагента или фоновой — статусом её строки
      const t = c.tasks.get(m.task_id) ?? { desc: m.description ?? "", done: false, steps: 0 };
      t.steps++;
      if (m.summary || m.description) t.last = m.summary ?? m.description;
      if (m.subtype === "task_notification") t.done = true;
      c.tasks.set(m.task_id, t);
      return;
    }
    if (m.type !== "assistant" && m.type !== "user" && m.type !== "result" && m.type !== "system") return;
    if (m.type === "system" && !["compact_boundary", "api_retry", "task_started"].includes(String(m.subtype))) return;
    const id = m.uuid ?? uuid();
    if (c.uuids.has(id)) return;
    c.uuids.add(id);
    if (m.type === "system" && m.subtype === "task_started" && m.task_id && !c.tasks.has(m.task_id)) c.tasks.set(m.task_id, { desc: m.description ?? "", done: false, steps: 0 });
    for (const b of blocks(m)) {
      if (b.type === "tool_use" && b.id && !c.tools.has(b.id)) c.tools.set(b.id, { done: false, error: false, name: b.name });
      if (b.type === "tool_use" && b.name === "TodoWrite" && Array.isArray(b.input?.todos)) c.todos = b.input!.todos as Todo[];
      if (b.type === "tool_result" && b.tool_use_id) c.tools.set(b.tool_use_id, { ...(c.tools.get(b.tool_use_id) ?? {}), done: true, error: !!b.is_error });
    }
    if (m.type === "user") {
      // свой пузырь с этим uuid — значит, дошёл: ✓✓
      const mine = c.items.find((x) => x.k === "me" && x.uuid === id);
      if (mine && mine.k === "me") {
        mine.st = "echo";
        if (to !== c.items) to.push(mine);
        return;
      }
      if (!textOf(m)) return; // только итоги инструментов
      c.suggestion = undefined;
    }
    to.push({ k: "sdk", uuid: id, msg: m });
  }

  async function history(callsign: string) {
    if (!has(callsign, "session.history")) return;
    const r = await app.request<{ messages: SdkMsg[] }>("session.history", { callsign, before: null, limit: 50 });
    const c = conv(callsign);
    if (!r.ok) {
      c.refused ??= `session.history: ${r.error}`;
      return void app.changed();
    }
    if (c.refused?.startsWith("session.history")) c.refused = undefined;
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
      c.refused = r.ok ? undefined : `session.watch: ${r.error}`;
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

  /** Подмена аккаунта слота видна по roster: у сессии сменилось поле account — строка в ленте. */
  function onRoster(r: Roster) {
    for (const s of r.sessions) {
      const c = convs.get(s.callsign);
      if (!c || typeof s.account !== "string") continue;
      if (c.account && c.account !== s.account) c.items.push({ k: "swap", from: c.account, to: s.account, at: Date.now() });
      c.account = s.account;
    }
  }

  /** Сообщение человека сессии. Отказ не переотправляется сам. */
  async function prompt(callsign: string, text: string, id = uuid(), attachments: Attachment[] = []): Promise<void> {
    const c = conv(callsign);
    let it = c.items.find((x) => x.k === "me" && x.uuid === id) as Extract<Item, { k: "me" }> | undefined;
    const queued = app.roster()?.sessions.find((s) => s.callsign === callsign)?.state === "busy";
    if (!it) {
      it = { k: "me", uuid: id, text, at: Date.now(), st: "sending", queued };
      c.items.push(it);
    }
    it.st = "sending";
    app.changed();
    const r = await app.request("session.prompt", { callsign, text, uuid: id, ...(attachments.length ? { attachments } : {}) });
    if (r.ok) {
      if (it.st === "sending") it.st = "ok";
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

  // ───── карточки ─────

  function view(c: Conv, callsign: string, live: boolean): View {
    const call = (method: string, args: unknown[]) => async () => {
      const r = await app.request("session.call", { callsign, method, args });
      if (!r.ok) app.toast(`${callsign}: ${method} — ${r.error}`);
    };
    const can = live && has(callsign, "session.call");
    return {
      tools: c.tools,
      tasks: c.tasks,
      wide: app.wide,
      background: can ? (id) => void call("backgroundTasks", [id])() : undefined,
      stopTask: can ? (id) => void call("stopTask", [id])() : undefined,
    };
  }

  function meTail(it: Extract<Item, { k: "me" }>): string | null {
    if (it.st === "sending") return "отправляю…";
    if (it.st === "lost") return null;
    if (!app.wide) return `${hhmm(it.at)} · доставлено`;
    if (it.st === "echo") return `${hhmm(it.at)} · ✓✓`;
    return it.queued ? "в очереди · ✓" : `${hhmm(it.at)} · ✓`;
  }

  function drawItem(c: Conv, callsign: string, it: Item, v: View, rewind: ((uuid: string) => void) | null): HTMLElement | HTMLElement[] | null {
    if (it.k === "swap") return h("div", { class: "chat-sys swap" }, `⇄ аккаунт: ${it.from} → ${it.to}`);
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
      const tail = meTail(it);
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
        rewind && it.st !== "lost" && it.st !== "sending" ? rewindLink(it.uuid, rewind) : null,
      );
    }
    const out = drawSdk(it.msg, v);
    if (rewind && it.msg.type === "user" && !fleetOf(it.msg) && out[0]) out[0].append(rewindLink(it.uuid, rewind));
    return out;
  }

  const rewindLink = (id: string, go: (uuid: string) => void) => h("button", { class: "chat-rw", onclick: () => go(id) }, "↶ откатить файлы");

  /** Фокус: сообщения людей, итоговый ответ хода и сводка шагов; вопросы, ошибки, итог и сжатие — всегда. */
  function focused(c: Conv, callsign: string, v: View): HTMLElement[] {
    const out: HTMLElement[] = [];
    let steps: string[] = [];
    let lastText: HTMLElement | null = null;
    const flush = () => {
      if (steps.length) {
        const counts = new Map<string, number>();
        for (const s of steps) counts.set(s, (counts.get(s) ?? 0) + 1);
        const names = [...counts].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(" · ");
        out.push(h("button", { class: "chat-steps", onclick: () => ((c.focus = false), app.changed()) }, `${steps.length} шагов · ${names} — развернуть`));
      }
      if (lastText) out.push(lastText);
      steps = [];
      lastText = null;
    };
    for (const it of c.items) {
      if (it.k === "sdk" && it.msg.type === "assistant") {
        for (const b of blocks(it.msg)) {
          if (b.type === "tool_use") steps.push(b.name ?? "?");
          if (b.type === "text" && b.text) lastText = h("div", { class: "chat-txt" }, b.text);
        }
        continue;
      }
      if (it.k === "sdk" && it.msg.type === "system" && it.msg.subtype === "task_started") continue;
      flush();
      const d = drawItem(c, callsign, it, v, null);
      if (Array.isArray(d)) out.push(...d);
      else if (d) out.push(d);
    }
    flush();
    return out;
  }

  function mountChat(el: HTMLElement, params: Record<string, string>): ScreenHandle {
    const callsign = params.callsign ?? "";
    const c = conv(callsign);
    c.mounted++;
    c.unread = 0;
    c.account ??= app.roster()?.sessions.find((s) => s.callsign === callsign)?.account as string | undefined;
    const wide = app.wide;
    const feed = h("div", { class: "sb-pad chat-feed", "aria-live": "polite" });
    const askBox = h("div", { class: "chat-ask" });
    let askHandle: ScreenHandle | undefined;
    const bar = h("div", { class: "chat-bar", hidden: !wide });
    const strip = h("div", { class: "chat-strip" });
    const sug = h("div", { class: "chat-sug", role: "listbox" });
    const files = h("div", { class: "chat-files" });
    const tools = h("div", { class: "chat-tools" });
    const input = h("textarea", { class: "chat-inp", rows: 1, placeholder: `Написать ${callsign}`, "aria-label": `Написать ${callsign}` }) as HTMLTextAreaElement;
    input.value = drafts[callsign] ?? "";
    const sendBtn = h("button", { class: "chat-send", "aria-label": "Отправить", type: "submit" }, "↑") as HTMLButtonElement;
    const form = h("form", { class: "chat-comp" + (wide ? " wide" : "") }, h("div", { class: "chat-box" }, files, input, tools), sendBtn) as HTMLFormElement;
    const picker = h("input", { type: "file", multiple: true, hidden: true }) as HTMLInputElement;
    let pending: Attachment[] = [];
    let sugKind: "" | "files" | "cmd" = "";
    let sugList: string[] = [];
    let lastQuery: string | null = null;

    const sync = () => {
      drafts[callsign] = input.value;
      sendBtn.disabled = !input.value.trim() && !pending.length;
    };
    const send = () => {
      const text = input.value.trim();
      if (!text && !pending.length) return;
      const att = pending;
      pending = [];
      input.value = "";
      sync();
      delete drafts[callsign];
      closeSug();
      drawFiles();
      void prompt(callsign, text, uuid(), att);
    };

    // ───── подсказки «@» и «/» ─────
    function closeSug() {
      sugKind = "";
      sugList = [];
      sug.textContent = "";
    }
    function drawSug() {
      sug.textContent = "";
      if (!sugKind || !sugList.length) return;
      add(
        sug,
        h("div", { class: "chat-sugh" }, sugKind === "files" ? "файлы папки · session.files" : "команды · session.call supportedCommands"),
        sugList.map((x) => h("button", { type: "button", class: "chat-sugi", role: "option", onclick: () => pick(x) }, x)),
      );
    }
    function pick(x: string) {
      const v = input.value;
      if (sugKind === "cmd") input.value = `${x.split(" — ")[0]} `;
      else input.value = v.replace(/@([^\s@]*)$/, `@${x} `);
      closeSug();
      sync();
      input.focus();
    }
    async function suggest() {
      if (!wide) return;
      const v = input.value;
      const cmd = /^\/(\S*)$/.exec(v);
      if (cmd && has(callsign, "session.call")) {
        if (c.commands === undefined) {
          c.commands = null;
          const r = await app.request<Array<{ name: string; description?: string }>>("session.call", { callsign, method: "supportedCommands", args: [] });
          c.commands = r.ok && Array.isArray(r.result) ? r.result : [];
        }
        sugKind = "cmd";
        sugList = (c.commands ?? []).filter((x) => x.name.startsWith(cmd[1])).slice(0, 20).map((x) => `/${x.name}${x.description ? " — " + x.description : ""}`);
        return drawSug();
      }
      const at = /(?:^|\s)@([^\s@]*)$/.exec(v);
      if (at && has(callsign, "session.files")) {
        if (lastQuery === at[1]) return;
        lastQuery = at[1];
        const r = await app.request<string[]>("session.files", { callsign, query: at[1], limit: 20 });
        if (lastQuery !== at[1]) return;
        sugKind = "files";
        sugList = r.ok && Array.isArray(r.result) ? r.result : [];
        return drawSug();
      }
      lastQuery = null;
      closeSug();
    }

    // ───── вложения ─────
    function drawFiles() {
      files.textContent = "";
      for (const a of pending) files.append(h("span", { class: "chat-file" }, a.name, h("button", { type: "button", "aria-label": `убрать ${a.name}`, onclick: () => ((pending = pending.filter((x) => x !== a)), drawFiles(), sync()) }, "✕")));
    }
    picker.addEventListener("change", async () => {
      for (const f of [...(picker.files ?? [])]) {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = "";
        for (const b of buf) bin += String.fromCharCode(b);
        pending.push({ name: f.name, media_type: f.type || "application/octet-stream", data: btoa(bin) });
      }
      picker.value = "";
      drawFiles();
      sync();
    });

    input.addEventListener("input", () => {
      sync();
      void suggest();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !input.value && c.suggestion) {
        e.preventDefault();
        input.value = c.suggestion;
        sync();
        return;
      }
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
    el.append(h("div", { class: "chat" + (wide ? " wide" : "") }, bar, feed, strip, askBox, sug, form, picker));

    // ───── откат файлов к сообщению ─────
    async function rewind(id: string) {
      c.rewind = { uuid: id, text: "Проба отката…", tone: "", ready: false };
      app.changed();
      const r = await app.request<{ canRewind?: boolean; filesChanged?: string[]; insertions?: number; deletions?: number; error?: string }>("session.call", {
        callsign,
        method: "rewindFiles",
        args: [id, { dryRun: true }],
      });
      if (c.rewind?.uuid !== id) return;
      if (!r.ok || r.result?.canRewind === false) {
        c.rewind = { uuid: id, text: `Откатить нельзя: ${r.ok ? (r.result?.error ?? "canRewind: false") : r.error}`, tone: "bad", ready: false };
      } else {
        const n = r.result?.filesChanged?.length ?? 0;
        c.rewind = { uuid: id, text: `Откатить файлы к этому сообщению? проба: ${n} файл${n === 1 ? "" : n < 5 ? "а" : "ов"} · +${r.result?.insertions ?? 0} −${r.result?.deletions ?? 0} · команды Bash не откатываются`, tone: "", ready: true };
      }
      app.changed();
    }
    async function rewindNow(id: string) {
      const r = await app.request("session.call", { callsign, method: "rewindFiles", args: [id] });
      c.rewind = { uuid: id, text: r.ok ? "Файлы откачены к этому сообщению." : `Не откатилось: ${r.error}`, tone: r.ok ? "ok" : "bad", ready: false };
      app.changed();
    }

    /** Выгрузка разговора в .md — из того, что в ленте (история и живые пачки). */
    function exportMd(): string {
      const lines = [`# ${callsign}`, ""];
      for (const it of c.items) {
        if (it.k === "me") lines.push("## Вы", "", it.text, "");
        else if (it.k === "in") lines.push(`## ${callsign} → вам`, "", it.text, "");
        else if (it.k === "sdk" && it.msg.type === "user") lines.push("## Вы", "", textOf(it.msg), "");
        else if (it.k === "sdk" && it.msg.type === "assistant") {
          for (const b of blocks(it.msg)) {
            if (b.type === "text" && b.text) lines.push("## Claude", "", b.text, "");
            if (b.type === "tool_use") lines.push(`- \`${b.name}\` ${JSON.stringify(b.input ?? {})}`, "");
          }
        }
      }
      return lines.join("\n");
    }

    function drawBar() {
      bar.textContent = "";
      if (!wide) return;
      bar.append(
        h("button", { class: "chat-mini", "aria-pressed": c.focus ? "true" : "false", onclick: () => ((c.focus = !c.focus), app.changed()) }, "фокус"),
        h("a", { class: "chat-mini", download: `${callsign.replace("@", "-")}.md`, href: "#", onclick: (e: Event) => ((e.currentTarget as HTMLAnchorElement).href = "data:text/markdown;charset=utf-8," + encodeURIComponent(exportMd())) }, "выгрузить .md"),
      );
    }

    /** кнопки ввода: в широком виде — значок и слово, в узком — значок (имя — в aria-label) */
    function drawTools(live: boolean) {
      tools.textContent = "";
      const tool = (icon: string, word: string, label: string, onclick: () => void) => h("button", { type: "button", class: "chat-mini", "aria-label": label, onclick }, wide ? `${icon} ${word}` : icon);
      add(
        tools,
        tool("＋", "файл", "Вложить файл", () => picker.click()),
        has(callsign, "session.files") ? tool("@", "файл", "Файл папки", () => ((input.value += input.value && !input.value.endsWith(" ") ? " @" : "@"), sync(), void suggest(), input.focus())) : null,
        has(callsign, "session.call") && live ? tool("/", "команда", "Команда", () => ((input.value = "/"), sync(), void suggest(), input.focus())) : null,
      );
    }

    function draw() {
      const s = app.roster()?.sessions.find((x) => x.callsign === callsign);
      const live = ["idle", "busy", "waiting"].includes(String(s?.state));
      const v = view(c, callsign, live);
      const near = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
      feed.textContent = "";
      if (c.noFeed) feed.append(h("div", { class: "chat-note" }, `${machineOf(callsign)} не отдаёт ленту — только переписка и ввод`));
      const rw = wide && live && has(callsign, "session.call") ? (id: string) => void rewind(id) : null;
      if (wide && c.focus) feed.append(...focused(c, callsign, v));
      else {
        for (const it of c.items) {
          const d = drawItem(c, callsign, it, v, rw);
          if (Array.isArray(d)) feed.append(...d);
          else if (d) feed.append(d);
          if (c.rewind && "uuid" in it && it.uuid === c.rewind.uuid) {
            const r = c.rewind;
            feed.append(
              h(
                "div",
                { class: `chat-rwc ${r.tone}`, role: "status" },
                h("span", null, r.text),
                r.ready ? h("button", { class: "chat-mini", onclick: () => ((c.rewind = undefined), app.changed()) }, "Отмена") : null,
                r.ready ? h("button", { class: "chat-mini bad", onclick: () => void rewindNow(r.uuid) }, "Откатить") : null,
              ),
            );
          }
        }
      }
      if (c.refused) feed.append(h("div", { class: "chat-note", role: "alert" }, c.refused));
      else if (!c.items.length && !c.noFeed) feed.append(h("div", { class: "chat-note" }, "Сообщений пока нет"));
      if (near || feed.dataset.drawn !== "1") feed.scrollTop = feed.scrollHeight;
      feed.dataset.drawn = "1";
      // полоса над вводом: задачи Claude и подсказка следующего сообщения
      strip.textContent = "";
      if (wide && c.todos?.length) {
        const done = c.todos.filter((t) => t.status === "completed").length;
        const now = c.todos.find((t) => t.status === "in_progress");
        strip.append(h("div", { class: "chat-todo" }, h("b", null, "Задачи"), ` ${done} из ${c.todos.length}${now ? " · " + (now.activeForm ?? now.content ?? "") : ""}`));
      }
      if (wide && c.suggestion && !input.value) strip.append(h("button", { class: "chat-hint", onclick: () => ((input.value = c.suggestion ?? ""), sync(), input.focus()) }, `Подсказка: «${c.suggestion}» — Tab`));
      // вопрос сессии: узко — полоса, которая открывает экран вопроса; широко — экран ask в месте над вводом
      const asked = app.mark("asked", callsign) as string | undefined;
      if (wide) {
        // вопрос над вводом: открыт, пока открыт чат, — ответ «принят» или «уже ответили» остаётся виден
        if ((asked || s?.state === "waiting") && !askHandle) askHandle = app.open("ask", { callsign }, askBox);
        input.placeholder = s?.state === "busy" ? `В очередь ${callsign} — Claude возьмёт на границе шага` : `Сообщение ${callsign} — Enter; Shift+Enter — строка`;
      } else {
        askBox.textContent = "";
        if (asked) askBox.append(h("button", { class: "chat-askbar", onclick: () => app.open("ask", { callsign }) }, h("b", null, "?"), h("span", null, asked), h("em", null, "Ответить")));
      }
      drawBar();
      drawTools(live);
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

  /** Галерея карточек: образцы сообщений SDK той же формы, что в ленте; соединения нет. */
  function mountGallery(el: HTMLElement): ScreenHandle {
    const box = h("div", { class: "sb-pad chat-gal" });
    el.append(box);
    const c: Conv = { items: [], uuids: new Set(), tools: new Map(), tasks: new Map(), seq: null, fresh: true, watching: false, noFeed: false, unread: 0, mounted: 0, focus: false };
    for (const s of SAMPLES) {
      const before = c.items.length;
      for (const m of s.msgs) addSdk(c, m);
      const items = c.items.slice(before);
      const v: View = { tools: c.tools, tasks: c.tasks, wide: true, background: () => {}, stopTask: () => {} };
      const cards: HTMLElement[] = [];
      for (const it of items) {
        const d = drawItem(c, "site@laptop", it, v, null);
        if (Array.isArray(d)) cards.push(...d);
        else if (d) cards.push(d);
      }
      if (s.swap) cards.push(h("div", { class: "chat-sys swap" }, s.swap));
      if (s.hint) cards.push(h("div", { class: "chat-hint" }, s.hint));
      box.append(h("div", { class: "chat-galr" }, h("div", { class: "chat-galc" }, cards), h("div", { class: "chat-galn" }, h("b", null, s.title), h("span", null, s.when))));
    }
    return { head: () => ({ title: "Галерея карточек" }) };
  }

  async function store() {
    await app.store<Record<string, string>>("drafts").set(Object.fromEntries(Object.entries(drafts).filter(([, v]) => v)));
  }

  return {
    frames: { "session.events": onEvents, message: onMessage },
    on: {
      roster: onRoster,
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
    screens: { chat: { label: "Лента", mount: mountChat }, gallery: { label: "Галерея", path: "gallery", mount: mountGallery } },
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
