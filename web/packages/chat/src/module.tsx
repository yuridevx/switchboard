// web-chat — лента сессии, ввод и переписка с владельцем.
// Лента: session.watch (watch Host) + session.history (chat Host), склейка по uuid; seq не следующий — снова история.
// Ввод: session.prompt — текст человека, uuid ставит клиент; обрыв до ответа — пузырь «не подтверждено».
// Переписка: кадр message с to = это приложение (сессия пишет владельцу), в том числе из уведомления.
// Широкий вид (пульт): ✓ — reply ok, ✓✓ — uuid пришёл в ленте; «@» — session.files, «/» — session.call
// supportedCommands; вложения, «В фон», откат файлов, фокус, выгрузка .md, строка подмены аккаунта из roster.
// Чего нет в contract машины — того нет на экране и в кадрах.
// Вид: лента выбирает список сообщений, строка — memo-компонент; новое сообщение рисует одну карточку.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { App, AppModule, Ctx, Frame, Roster, ScreenProps } from "@switchboard/web-core";
import type {} from "@switchboard/web-ask";
import type {} from "@switchboard/web-labels";
import { machineOf } from "@switchboard/protocol";
import { hhmm, Pad, sessionLine, stateLabel } from "@switchboard/web-ui";
import css from "./chat.css";
import { blocks, fleetOf, SdkCards, textOf, type SdkMsg, type Task, type Tool, type View } from "./render.tsx";
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

/** Ключ строки ленты: у сообщения — uuid, у переписки и подмены аккаунта — номер объекта. */
const itemIds = new WeakMap<Item, number>();
let nextItemId = 0;
function keyOf(it: Item): string {
  if ("uuid" in it) return it.uuid;
  let n = itemIds.get(it);
  if (n === undefined) {
    n = ++nextItemId;
    itemIds.set(it, n);
  }
  return `#${n}`;
}

const newConv = (): Conv => ({ items: [], uuids: new Set(), tools: new Map(), tasks: new Map(), seq: null, fresh: true, watching: false, noFeed: false, unread: 0, mounted: 0, focus: false });

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createChat(): AppModule {
  let app: App;
  /** человеческое имя сессии; адрес в протоколе не меняется */
  const nameOf = (c: string) => app.mark("label.session", c)?.text ?? c;
  const convs = new Map<string, Conv>();
  let drafts: Record<string, string> = {};
  let draftsLoaded = false;

  function conv(callsign: string): Conv {
    let c = convs.get(callsign);
    if (!c) {
      c = newConv();
      convs.set(callsign, c);
    }
    return c;
  }

  const sessionOf = (callsign: string) => app.roster()?.sessions.find((s) => s.callsign === callsign);
  const isLive = (callsign: string) => ["idle", "busy", "waiting"].includes(String(sessionOf(callsign)?.state));

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
      // сводка сжатия после живой границы: строку «контекст сжат» та уже нарисовала
      const prev = to.at(-1);
      if (m.isCompactSummary && prev?.k === "sdk" && prev.msg.subtype === "compact_boundary") return;
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
    return !!m && app.can(m, name) === true;
  }

  /** Открыть ленту: сначала session.watch, потом session.history. */
  async function watch(callsign: string) {
    const c = conv(callsign);
    const m = machineOf(callsign) ?? "";
    // возможности — по roster: нет session.watch — ленты нет, переписка и ввод работают
    c.noFeed = app.can(m, "session.watch") === false;
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
    const queued = sessionOf(callsign)?.state === "busy";
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

  // ───── откат файлов к сообщению ─────
  async function rewind(callsign: string, id: string) {
    const c = conv(callsign);
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

  async function rewindNow(callsign: string, id: string) {
    const c = conv(callsign);
    const r = await app.request("session.call", { callsign, method: "rewindFiles", args: [id] });
    c.rewind = { uuid: id, text: r.ok ? "Файлы откачены к этому сообщению." : `Не откатилось: ${r.error}`, tone: r.ok ? "ok" : "bad", ready: false };
    app.changed();
  }

  /** Выгрузка разговора в .md — из того, что в ленте (история и живые пачки). */
  function exportMd(c: Conv, callsign: string): string {
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

  // ───── карточки ─────

  /** Что карточкам живой ленты: состояние разговора и кнопки, если сессия жива и машина умеет session.call. */
  function viewOf(c: Conv, callsign: string, can: boolean): View {
    const call = (method: string, args: unknown[]) => async () => {
      const r = await app.request("session.call", { callsign, method, args });
      if (!r.ok) app.toast(`${callsign}: ${method} — ${r.error}`);
    };
    return {
      tools: c.tools,
      tasks: c.tasks,
      wide: app.wide,
      use: app.use,
      background: can ? (id) => void call("backgroundTasks", [id])() : undefined,
      stopTask: can ? (id) => void call("stopTask", [id])() : undefined,
    };
  }

  function RewindLink({ callsign, id }: { callsign: string; id: string }) {
    return (
      <button className="chat-rw" onClick={() => void rewind(callsign, id)}>
        ↶ откатить файлы
      </button>
    );
  }

  /** Свой пузырь: состояние доставки меняет только его. */
  function MeCard({ it, callsign, rw }: { it: Extract<Item, { k: "me" }>; callsign: string; rw: boolean }) {
    const st = app.use(() => it.st);
    const at = app.use(() => it.at);
    const tail = st === "sending" ? "отправляю…" : st === "lost" ? null : !app.wide ? `${hhmm(at)} · доставлено` : st === "echo" ? `${hhmm(at)} · ✓✓` : it.queued ? "в очереди · ✓" : `${hhmm(at)} · ✓`;
    return (
      <div className={"chat-me" + (st === "lost" ? " pend" : "")}>
        {it.text}
        {tail ? (
          <small>{tail}</small>
        ) : (
          <small>
            связь оборвалась до ответа — не подтверждено ·{" "}
            <button className="chat-again" onClick={() => void prompt(callsign, it.text, it.uuid)}>
              отправить ещё раз
            </button>
          </small>
        )}
        {rw && st !== "lost" && st !== "sending" ? <RewindLink callsign={callsign} id={it.uuid} /> : null}
      </div>
    );
  }

  /** Сообщение сессии владельцу. */
  function InCard({ it, callsign }: { it: Extract<Item, { k: "in" }>; callsign: string }) {
    const name = app.use(() => nameOf(callsign));
    return (
      <div className="chat-in">
        <div className="chat-from">
          {`${name} → вам`}
          {it.push ? <span className="chat-tag">из уведомления</span> : null}
        </div>
        {it.text}
        <small>{hhmm(it.at)}</small>
      </div>
    );
  }

  function ItemCard({ it, callsign, v, rw }: { it: Item; callsign: string; v: View; rw: boolean }) {
    if (it.k === "swap") return <div className="chat-sys swap">{`⇄ аккаунт: ${it.from} → ${it.to}`}</div>;
    if (it.k === "in") return <InCard it={it} callsign={callsign} />;
    if (it.k === "me") return <MeCard it={it} callsign={callsign} rw={rw} />;
    return <SdkCards m={it.msg} v={v} after={rw && it.msg.type === "user" && !fleetOf(it.msg) ? <RewindLink callsign={callsign} id={it.uuid} /> : undefined} />;
  }

  /** Плашка отката под сообщением. */
  function RewindCard({ callsign, id }: { callsign: string; id: string }) {
    const r = app.use(() => {
      const x = conv(callsign).rewind;
      return x?.uuid === id ? x : null;
    });
    if (!r) return null;
    return (
      <div className={`chat-rwc ${r.tone}`} role="status">
        <span>{r.text}</span>
        {r.ready ? (
          <button
            className="chat-mini"
            onClick={() => {
              conv(callsign).rewind = undefined;
              app.changed();
            }}
          >
            Отмена
          </button>
        ) : null}
        {r.ready ? (
          <button className="chat-mini bad" onClick={() => void rewindNow(callsign, r.uuid)}>
            Откатить
          </button>
        ) : null}
      </div>
    );
  }

  /** Строка ленты: новое сообщение не перерисовывает остальные. */
  const Row = memo(function Row({ it, callsign, v, rw }: { it: Item; callsign: string; v: View; rw: boolean }) {
    return (
      <>
        <ItemCard it={it} callsign={callsign} v={v} rw={rw} />
        {"uuid" in it ? <RewindCard callsign={callsign} id={it.uuid} /> : null}
      </>
    );
  });

  /** Фокус: сообщения людей, итоговый ответ хода и сводка шагов; вопросы, ошибки, итог и сжатие — всегда. */
  function Focused({ c, list, callsign, v }: { c: Conv; list: Item[]; callsign: string; v: View }) {
    const out: ReactNode[] = [];
    let steps: string[] = [];
    let lastText: string | null = null;
    const flush = () => {
      if (steps.length) {
        const counts = new Map<string, number>();
        for (const s of steps) counts.set(s, (counts.get(s) ?? 0) + 1);
        const names = [...counts].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(" · ");
        out.push(
          <button
            key={`s${out.length}`}
            className="chat-steps"
            onClick={() => {
              c.focus = false;
              app.changed();
            }}
          >
            {`${steps.length} шагов · ${names} — развернуть`}
          </button>,
        );
      }
      if (lastText) {
        out.push(
          <div key={`t${out.length}`} className="chat-txt">
            {lastText}
          </div>,
        );
      }
      steps = [];
      lastText = null;
    };
    for (const it of list) {
      if (it.k === "sdk" && it.msg.type === "assistant") {
        for (const b of blocks(it.msg)) {
          if (b.type === "tool_use") steps.push(b.name ?? "?");
          if (b.type === "text" && b.text) lastText = b.text;
        }
        continue;
      }
      if (it.k === "sdk" && it.msg.type === "system" && it.msg.subtype === "task_started") continue;
      flush();
      out.push(<ItemCard key={keyOf(it)} it={it} callsign={callsign} v={v} rw={false} />);
    }
    flush();
    return <>{out}</>;
  }

  /** Лента: список выбирается копией, строки те же — рисуется только новое; у низа остаётся у низа. */
  function Feed({ c, callsign }: { c: Conv; callsign: string }) {
    const list = app.use(() => [...c.items]);
    const noFeed = app.use(() => c.noFeed);
    const refused = app.use(() => c.refused);
    const focus = app.use(() => c.focus);
    const can = app.use(() => isLive(callsign) && has(callsign, "session.call"));
    // плашка отката меняет высоту ленты: прилипание к низу пересчитывается и для неё
    app.use(() => c.rewind?.text);
    const v = useMemo(() => viewOf(c, callsign, can), [c, callsign, can]);
    const rw = app.wide && can;
    const box = useRef<HTMLDivElement>(null);
    const el = box.current;
    const near = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    useLayoutEffect(() => {
      if (near && box.current) box.current.scrollTop = box.current.scrollHeight;
    });
    return (
      <Pad ref={box} className="chat-feed" aria-live="polite">
        {noFeed ? <div className="chat-note">{`${machineOf(callsign)} не отдаёт ленту — только переписка и ввод`}</div> : null}
        {app.wide && focus ? <Focused c={c} list={list} callsign={callsign} v={v} /> : list.map((it) => <Row key={keyOf(it)} it={it} callsign={callsign} v={v} rw={rw} />)}
        {refused ? (
          <div className="chat-note" role="alert">
            {refused}
          </div>
        ) : !list.length && !noFeed ? (
          <div className="chat-note">Сообщений пока нет</div>
        ) : null}
      </Pad>
    );
  }

  /** Полоса фокуса и выгрузки над лентой: широкий вид. */
  function Bar({ c, callsign }: { c: Conv; callsign: string }) {
    const focus = app.use(() => c.focus);
    return (
      <>
        <button
          className="chat-mini"
          aria-pressed={focus ? "true" : "false"}
          onClick={() => {
            c.focus = !c.focus;
            app.changed();
          }}
        >
          фокус
        </button>
        <a
          className="chat-mini"
          download={`${callsign.replace("@", "-")}.md`}
          href="#"
          onClick={(e) => {
            e.currentTarget.href = "data:text/markdown;charset=utf-8," + encodeURIComponent(exportMd(c, callsign));
          }}
        >
          выгрузить .md
        </a>
      </>
    );
  }

  /** Вопрос сессии: узко — полоса, которая открывает экран вопроса; широко — экран ask в месте над вводом. */
  function AskBox({ callsign }: { callsign: string }) {
    const asked = app.use(() => app.mark("asked", callsign));
    const waiting = app.use(() => sessionOf(callsign)?.state === "waiting");
    // вопрос над вводом: открыт, пока открыт чат, — ответ «принят» или «уже ответили» остаётся виден
    const opened = useRef(false);
    if (asked || waiting) opened.current = true;
    return (
      <div className="chat-ask">
        {app.wide ? (
          opened.current ? (
            <app.Slot screen="ask" params={{ callsign }} />
          ) : null
        ) : asked ? (
          <button className="chat-askbar" onClick={() => app.open("ask", { callsign })}>
            <b>?</b>
            <span>{asked}</span>
            <em>Ответить</em>
          </button>
        ) : null}
      </div>
    );
  }

  /** Полоса задач и подсказки, вопрос, подсказки «@» и «/», ввод с вложениями. */
  function Composer({ c, callsign }: { c: Conv; callsign: string }) {
    const wide = app.wide;
    const inp = useRef<HTMLTextAreaElement>(null);
    const picker = useRef<HTMLInputElement>(null);
    const [text, setText] = useState(drafts[callsign] ?? "");
    const [pending, setPending] = useState<Attachment[]>([]);
    const [sugKind, setSugKind] = useState<"" | "files" | "cmd">("");
    const [sugList, setSugList] = useState<string[]>([]);
    const lastQuery = useRef<string | null>(null);

    const name = app.use(() => nameOf(callsign));
    const busy = app.use(() => sessionOf(callsign)?.state === "busy");
    const live = app.use(() => isLive(callsign));
    const canFiles = app.use(() => has(callsign, "session.files"));
    const canCall = app.use(() => has(callsign, "session.call"));
    const suggestion = app.use(() => c.suggestion);
    const todos = app.use(() => c.todos);
    const draft = app.use(() => drafts[callsign] ?? "");

    const sync = () => {
      const v = inp.current!.value;
      drafts[callsign] = v;
      setText(v);
    };

    // черновик вернулся (отказ session.prompt) — в поле, если человек сейчас не печатает
    useEffect(() => {
      const el = inp.current!;
      if (el.value !== draft && el.ownerDocument.activeElement !== el) {
        el.value = draft;
        setText(draft);
      }
    }, [draft]);

    function closeSug() {
      setSugKind("");
      setSugList([]);
    }

    function send() {
      const value = inp.current!.value.trim();
      if (!value && !pending.length) return;
      const att = pending;
      setPending([]);
      inp.current!.value = "";
      sync();
      delete drafts[callsign];
      closeSug();
      void prompt(callsign, value, uuid(), att);
    }

    // ───── подсказки «@» и «/» ─────
    function pick(x: string) {
      const el = inp.current!;
      if (sugKind === "cmd") el.value = `${x.split(" — ")[0]} `;
      else el.value = el.value.replace(/@([^\s@]*)$/, `@${x} `);
      closeSug();
      sync();
      el.focus();
    }

    async function suggest() {
      if (!wide) return;
      const v = inp.current!.value;
      const cmd = /^\/(\S*)$/.exec(v);
      if (cmd && has(callsign, "session.call")) {
        if (c.commands === undefined) {
          c.commands = null;
          const r = await app.request<Array<{ name: string; description?: string }>>("session.call", { callsign, method: "supportedCommands", args: [] });
          c.commands = r.ok && Array.isArray(r.result) ? r.result : [];
        }
        setSugKind("cmd");
        setSugList((c.commands ?? []).filter((x) => x.name.startsWith(cmd[1])).slice(0, 20).map((x) => `/${x.name}${x.description ? " — " + x.description : ""}`));
        return;
      }
      const at = /(?:^|\s)@([^\s@]*)$/.exec(v);
      if (at && has(callsign, "session.files")) {
        if (lastQuery.current === at[1]) return;
        lastQuery.current = at[1];
        const r = await app.request<string[]>("session.files", { callsign, query: at[1], limit: 20 });
        if (lastQuery.current !== at[1]) return;
        setSugKind("files");
        setSugList(r.ok && Array.isArray(r.result) ? r.result : []);
        return;
      }
      lastQuery.current = null;
      closeSug();
    }

    // ───── вложения ─────
    async function attach() {
      const el = picker.current!;
      const added: Attachment[] = [];
      for (const f of [...(el.files ?? [])]) {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = "";
        for (const b of buf) bin += String.fromCharCode(b);
        added.push({ name: f.name, media_type: f.type || "application/octet-stream", data: btoa(bin) });
      }
      el.value = "";
      setPending((p) => [...p, ...added]);
    }

    /** кнопка ввода: в широком виде — значок и слово, в узком — значок (имя — в aria-label) */
    const tool = (icon: string, word: string, label: string, onClick: () => void) => (
      <button key={label} type="button" className="chat-mini" aria-label={label} onClick={onClick}>
        {wide ? `${icon} ${word}` : icon}
      </button>
    );
    const done = todos?.filter((t) => t.status === "completed").length ?? 0;
    const now = todos?.find((t) => t.status === "in_progress");

    return (
      <>
        <div className="chat-strip">
          {wide && todos?.length ? (
            <div className="chat-todo">
              <b>Задачи</b>
              {` ${done} из ${todos.length}${now ? " · " + (now.activeForm ?? now.content ?? "") : ""}`}
            </div>
          ) : null}
          {wide && suggestion && !text ? (
            <button
              className="chat-hint"
              onClick={() => {
                inp.current!.value = c.suggestion ?? "";
                sync();
                inp.current!.focus();
              }}
            >
              {`Подсказка: «${suggestion}» — Tab`}
            </button>
          ) : null}
        </div>
        <AskBox callsign={callsign} />
        <div className="chat-sug" role="listbox">
          {sugKind && sugList.length ? (
            <>
              <div className="chat-sugh">{sugKind === "files" ? "файлы папки · session.files" : "команды · session.call supportedCommands"}</div>
              {sugList.map((x) => (
                <button key={x} type="button" className="chat-sugi" role="option" onClick={() => pick(x)}>
                  {x}
                </button>
              ))}
            </>
          ) : null}
        </div>
        <form
          className={"chat-comp" + (wide ? " wide" : "")}
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <div className="chat-box">
            <div className="chat-files">
              {pending.map((a) => (
                <span key={a.name} className="chat-file">
                  {a.name}
                  <button type="button" aria-label={`убрать ${a.name}`} onClick={() => setPending((p) => p.filter((x) => x !== a))}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <textarea
              ref={inp}
              className="chat-inp"
              rows={1}
              placeholder={wide ? (busy ? `В очередь ${name} — Claude возьмёт на границе шага` : `Сообщение ${name} — Enter; Shift+Enter — строка`) : `Написать ${name}`}
              aria-label={`Написать ${name}`}
              defaultValue={drafts[callsign] ?? ""}
              onInput={() => {
                sync();
                void suggest();
              }}
              onKeyDown={(e) => {
                const el = e.currentTarget;
                if (e.key === "Tab" && !el.value && c.suggestion) {
                  e.preventDefault();
                  el.value = c.suggestion;
                  sync();
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="chat-tools">
              {tool("＋", "файл", "Вложить файл", () => picker.current!.click())}
              {canFiles
                ? tool("@", "файл", "Файл папки", () => {
                    const el = inp.current!;
                    el.value += el.value && !el.value.endsWith(" ") ? " @" : "@";
                    sync();
                    void suggest();
                    el.focus();
                  })
                : null}
              {canCall && live
                ? tool("/", "команда", "Команда", () => {
                    inp.current!.value = "/";
                    sync();
                    void suggest();
                    inp.current!.focus();
                  })
                : null}
            </div>
          </div>
          <button className="chat-send" aria-label="Отправить" type="submit" disabled={!text.trim() && !pending.length}>
            ↑
          </button>
        </form>
        <input ref={picker} type="file" multiple hidden onChange={() => void attach()} />
      </>
    );
  }

  function Chat({ params }: ScreenProps) {
    const callsign = params.callsign ?? "";
    const c = conv(callsign);
    useEffect(() => {
      c.mounted++;
      c.unread = 0;
      c.account ??= sessionOf(callsign)?.account as string | undefined;
      void watch(callsign);
      app.changed();
      return () => {
        c.mounted--;
        void store();
        if (!c.mounted) void unwatch(callsign);
      };
    }, [c, callsign]);
    return (
      <div className={"chat" + (app.wide ? " wide" : "")}>
        <div className="chat-bar" hidden={!app.wide}>
          {app.wide ? <Bar c={c} callsign={callsign} /> : null}
        </div>
        <Feed c={c} callsign={callsign} />
        <Composer c={c} callsign={callsign} />
      </div>
    );
  }

  /** Галерея карточек: образцы сообщений SDK той же формы, что в ленте; соединения нет. */
  function Gallery() {
    const { c, rows } = useMemo(() => {
      const c = newConv();
      const rows = SAMPLES.map((s) => {
        const before = c.items.length;
        for (const m of s.msgs) addSdk(c, m);
        return { s, items: c.items.slice(before) };
      });
      return { c, rows };
    }, []);
    const v: View = { tools: c.tools, tasks: c.tasks, wide: true, use: app.use, background: () => {}, stopTask: () => {} };
    return (
      <Pad className="chat-gal">
        {rows.map(({ s, items }) => (
          <div key={s.title} className="chat-galr">
            <div className="chat-galc">
              {items.map((it) => (
                <ItemCard key={keyOf(it)} it={it} callsign="site@laptop" v={v} rw={false} />
              ))}
              {s.swap ? <div className="chat-sys swap">{s.swap}</div> : null}
              {s.hint ? <div className="chat-hint">{s.hint}</div> : null}
            </div>
            <div className="chat-galn">
              <b>{s.title}</b>
              <span>{s.when}</span>
            </div>
          </div>
        ))}
      </Pad>
    );
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
    screens: {
      chat: {
        label: "Лента",
        view: Chat,
        head: (params) => {
          const callsign = params.callsign ?? "";
          const s = sessionOf(callsign);
          if (!s) return { title: nameOf(callsign), mono: true, sub: `${machineOf(callsign)} не на связи` };
          const st = stateLabel(s.state);
          return { title: nameOf(callsign), mono: true, sub: sessionLine(s, true), pill: { text: st.text, tone: st.tone } };
        },
      },
      gallery: { label: "Галерея", path: "gallery", view: Gallery, head: () => ({ title: "Галерея карточек" }) },
    },
    marks: {
      unread: (callsign: string) => {
        const c = convs.get(callsign);
        return c?.unread ? { count: c.unread, text: c.lastIn ?? "" } : undefined;
      },
    },
    store: ["drafts"],
    css,
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
