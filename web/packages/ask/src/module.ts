// web-ask — вопросы сессий: кадры question и answered, запросы answer и question.list, экран вопроса,
// метка asked для списка. Ждущие вопросы держит модуль questions на Host — здесь только память экрана.
import { h, hhmm, type App, type AppModule, type Frame, type Roster } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { CSS } from "./css.ts";

/** Вопрос AskUserQuestion: 1–4 на кадр, по 2–4 варианта; «Свой ответ» есть всегда. */
export type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
};

type Status = "waiting" | "sending" | "ok" | "late" | "cancelled" | "gone" | "error";

/** Вопрос сессии в памяти модуля. */
type Rec = {
  id: string;
  callsign: string;
  kind: string;
  questions: Question[];
  /** форма MCP: message, schema, url, server */
  frame: Frame;
  to: string[];
  at: number;
  status: Status;
  error?: string;
  /** кто ответил и что — из answered или свой ответ */
  by?: string;
  answers?: Record<string, string>;
};

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createAsk(): AppModule {
let app: App;
const recs = new Map<string, Rec>();
/** позывные, у которых надо взять question.list: пришёл пуш без вопросов */
const need = new Set<string>();
/** у кого question.list уже взят после этого hello */
const listed = new Set<string>();
/** позывной → идёт загрузка списка */
const loading = new Set<string>();
/** позывной → слово отказа последнего question.list */
const refused = new Map<string, string>();

function upsert(callsign: string, f: Frame | Record<string, unknown>, to: string[] = []) {
  const id = String(f.question);
  const old = recs.get(id);
  if (old) return old;
  const r: Rec = {
    id,
    callsign,
    kind: typeof f.kind === "string" ? f.kind : "ask",
    questions: Array.isArray(f.questions) ? (f.questions as Question[]) : [],
    frame: f as Frame,
    to,
    at: Date.now(),
    status: "waiting",
  };
  recs.set(id, r);
  return r;
}

const waitingOf = (callsign: string) => [...recs.values()].filter((r) => r.callsign === callsign && r.status === "waiting");

/** Ждущие вопросы сессии — у модуля questions её Host. */
async function list(callsign: string, force = false) {
  if (!force && listed.has(callsign)) return;
  listed.add(callsign);
  loading.add(callsign);
  app.changed();
  const r = await app.request<Array<Record<string, unknown>>>("question.list", { callsign });
  loading.delete(callsign);
  if (r.ok) {
    refused.delete(callsign);
    need.delete(callsign);
    const ids = new Set(r.result.map((q) => String(q.question)));
    // ждущие, которых Host больше не знает, — на них уже ответили
    for (const w of waitingOf(callsign)) if (!ids.has(w.id)) recs.delete(w.id);
    for (const q of r.result) upsert(callsign, q);
  } else {
    // отказ — словом на экране вопроса, а не «нет ждущих вопросов»
    refused.set(callsign, r.error);
    listed.delete(callsign);
  }
  app.changed();
}

function onQuestion(f: Frame, ctx: { open: boolean }) {
  const callsign = String(f.from);
  if (Array.isArray(f.questions) || f.kind === "form") upsert(callsign, f, Array.isArray(f.to) ? (f.to as string[]) : []);
  else {
    // из уведомления: в пуше только notify — сам вопрос берём у Host
    need.add(callsign);
    if (app.link() === "open") void list(callsign, true);
  }
  if (ctx.open) app.open("ask", { callsign });
  app.changed();
}

function onAnswered(f: Frame) {
  const r = recs.get(String(f.question));
  if (!r) return;
  if (f.cancelled) r.status = "cancelled";
  else if (r.status !== "ok") {
    r.by = typeof f.by === "string" ? f.by : undefined;
    r.answers = f.answers as Record<string, string> | undefined;
    r.status = r.by === app.name && r.status === "sending" ? "ok" : "late";
  }
  app.changed();
}

/** Машина сессии на связи: её соединение открыто и её roster пришёл — вопросы спрашиваются у её Host. */
const present = (callsign: string) => !!app.roster()?.machines.some((m) => m.machine === machineOf(callsign));

/** Сессии, чьи вопросы нужно спросить: из уведомлений без тела и с ждущими вопросами. */
const wanted = () => new Set([...need, ...[...recs.values()].filter((r) => r.status === "waiting").map((r) => r.callsign)]);

function onRoster(ro: Roster) {
  // машина появилась в roster флота — спросить вопросы её сессий, которых ждём
  for (const c of wanted()) if (present(c)) void list(c);
  // широкий вид (пульт) спрашивает question.list при открытии чата сессии, а не по roster
  if (app.wide) return;
  for (const s of ro.sessions) if (s.state === "waiting" && !waitingOf(s.callsign).length) void list(s.callsign);
}

function onLink(s: string) {
  if (s !== "open") return;
  listed.clear();
  for (const c of wanted()) if (present(c)) void list(c);
}

/** Метка для списка: текст первого ждущего вопроса сессии. */
function asked(callsign: string): string | undefined {
  const r = waitingOf(callsign)[0];
  if (!r) return undefined;
  return r.questions[0]?.question ?? (typeof r.frame.message === "string" ? r.frame.message : "форма");
}

// ───── экран вопроса ─────

function mountAsk(el: HTMLElement, params: Record<string, string>) {
  const callsign = params.callsign ?? "";
  let shown: string | null = null;
  // выбор человека: текст вопроса → выбранные варианты; свой ответ — текстом
  const picks = new Map<string, Set<string>>();
  const own = new Map<string, string>();
  const ownOn = new Set<string>();
  const formVals: Record<string, unknown> = {};

  // показанный вопрос держится, пока он ждёт ответа; закрыт — следующий ждущий, нет его — итог показанного
  const current = (): Rec | undefined => {
    const s = shown ? recs.get(shown) : undefined;
    return s && (s.status === "waiting" || s.status === "sending" || s.status === "error") ? s : (waitingOf(callsign)[0] ?? s);
  };

  function answersOf(r: Rec): Record<string, string> | null {
    const out: Record<string, string> = {};
    for (const q of r.questions) {
      const vals = [...(picks.get(q.question) ?? [])];
      if (ownOn.has(q.question)) {
        const t = (own.get(q.question) ?? "").trim();
        if (!t) return null;
        vals.push(t);
      }
      if (!vals.length) return null;
      out[q.question] = vals.join(", ");
    }
    return out;
  }

  async function send(r: Rec, body: Record<string, unknown>, mine?: Record<string, string>) {
    r.status = "sending";
    r.error = undefined;
    draw();
    const res = await app.request("answer", { callsign: r.callsign, question: r.id, ...body });
    if (res.ok) {
      r.status = "ok";
      r.by = app.name;
      r.answers = mine;
    } else if (res.error === "already_answered") {
      // первый ответ выигрывает: свой повторно не шлём
      if (r.status === "sending") r.status = "late";
    } else if (res.error === "unknown_question") r.status = "gone";
    else {
      r.status = "error";
      r.error = res.error;
    }
    app.changed();
  }

  function pick(q: Question, label: string) {
    const set = picks.get(q.question) ?? new Set<string>();
    if (q.multiSelect) {
      if (set.has(label)) set.delete(label);
      else set.add(label);
    } else {
      set.clear();
      set.add(label);
      ownOn.delete(q.question);
    }
    picks.set(q.question, set);
    draw();
  }

  function toggleOwn(q: Question) {
    if (ownOn.has(q.question)) ownOn.delete(q.question);
    else {
      ownOn.add(q.question);
      if (!q.multiSelect) picks.delete(q.question);
    }
    draw();
    [...el.querySelectorAll<HTMLInputElement>("input[data-own]")].find((x) => x.dataset.own === q.question)?.focus();
  }

  function askBody(r: Rec, locked: boolean): HTMLElement[] {
    const n = r.questions.length;
    return r.questions.map((q, i) => {
      const set = picks.get(q.question) ?? new Set<string>();
      const opts = q.options.map((o) =>
        h(
          "button",
          { class: "ask-opt" + (q.multiSelect ? " multi" : ""), "aria-pressed": set.has(o.label) ? "true" : "false", disabled: locked, onclick: () => pick(q, o.label) },
          h("span", null, h("b", null, o.label), o.description ? h("span", null, o.description) : null),
        ),
      );
      const ownBtn = h(
        "button",
        { class: "ask-opt own", "aria-pressed": ownOn.has(q.question) ? "true" : "false", disabled: locked, onclick: () => toggleOwn(q) },
        h("span", null, h("b", null, "Свой ответ"), h("span", null, "Написать сессии текстом")),
      );
      const input = ownOn.has(q.question)
        ? (h("input", { class: "ask-own", type: "text", "data-own": q.question, placeholder: "Ваш ответ", disabled: locked, value: own.get(q.question) ?? "" }) as HTMLInputElement)
        : null;
      input?.addEventListener("input", () => {
        own.set(q.question, input.value);
        syncCta();
      });
      return h(
        "div",
        { class: "ask-q" },
        h("div", { class: "ask-qh" }, q.header ? h("span", { class: "ask-chip" }, q.header) : h("span"), h("span", { class: "ask-qn" }, `вопрос ${i + 1} из ${n}`)),
        h("div", { class: "ask-qt" }, q.question),
        h("div", { class: "ask-opts" }, opts, ownBtn, input),
      );
    });
  }

  function formBody(r: Rec, locked: boolean): HTMLElement[] {
    const f = r.frame;
    const out: HTMLElement[] = [h("div", { class: "ask-qt" }, String(f.message ?? "Форма"))];
    if (typeof f.url === "string") {
      out.push(h("a", { class: "ask-url", href: f.url, target: "_blank", rel: "noopener" }, f.url));
      return [h("div", { class: "ask-q" }, out)];
    }
    const props = ((f.schema as { properties?: Record<string, { type?: string; enum?: string[]; title?: string; description?: string }> })?.properties ?? {});
    for (const [k, p] of Object.entries(props)) {
      let input: HTMLInputElement | HTMLSelectElement;
      if (p.enum) {
        input = h("select", { class: "ask-own", disabled: locked }, h("option", { value: "" }, "—"), p.enum.map((v) => h("option", { value: v, selected: formVals[k] === v }, v))) as HTMLSelectElement;
        input.addEventListener("change", () => (formVals[k] = input.value || undefined));
      } else if (p.type === "boolean") {
        input = h("input", { type: "checkbox", disabled: locked, checked: formVals[k] === true }) as HTMLInputElement;
        input.addEventListener("change", () => (formVals[k] = (input as HTMLInputElement).checked));
      } else {
        const num = p.type === "number" || p.type === "integer";
        input = h("input", { class: "ask-own", type: num ? "number" : "text", disabled: locked, value: formVals[k] === undefined ? "" : String(formVals[k]) }) as HTMLInputElement;
        input.addEventListener("input", () => (formVals[k] = num ? Number(input.value) : input.value));
      }
      out.push(h("label", { class: "ask-field" }, h("span", null, p.title ?? k), input, p.description ? h("small", null, p.description) : null));
    }
    return [h("div", { class: "ask-q" }, out)];
  }

  let cta: HTMLButtonElement | null = null;
  function syncCta() {
    const r = current();
    if (cta && r && r.kind !== "form") cta.disabled = !answersOf(r) || r.status === "sending";
  }

  function result(r: Rec): HTMLElement | null {
    const first = r.answers ? Object.values(r.answers).join("; ") : "";
    switch (r.status) {
      case "ok":
        return h("div", { class: "sb-okc", role: "status" }, h("b", null, first ? `Ответ «${first}» принят.` : "Ответ принят."), h("span", null, `${r.callsign} продолжила работу.`));
      case "late":
        return h(
          "div",
          { class: "sb-waitc", role: "status" },
          h("b", null, r.by ? `Уже ответили с ${r.by}${first ? `: «${first}»` : ""}.` : "Уже ответили."),
          h("span", null, "Первый ответ выигрывает — ваш не отправлен повторно."),
        );
      case "cancelled":
        return h("div", { class: "sb-waitc", role: "status" }, h("b", null, "Вопрос снят."), h("span", null, "Ход прервали — ответ больше не нужен."));
      case "gone":
        return h("div", { class: "sb-waitc", role: "status" }, h("b", null, "Вопроса больше нет."), h("span", null, `${r.callsign} его не ждёт: unknown_question.`));
      case "error":
        return h("div", { class: "sb-badc", role: "alert" }, h("b", null, `Не отправлено: ${r.error}`), h("span", null, "Ответ не дошёл — можно отправить ещё раз."));
      default:
        return null;
    }
  }

  function draw() {
    const r = current();
    if (r) shown = r.id;
    el.textContent = "";
    if (!r) {
      el.append(
        h(
          "div",
          { class: "sb-pad" },
          h(
            "div",
            { class: "ask-empty" },
            loading.has(callsign) ? "Загружаю вопросы…" : refused.has(callsign) ? `question.list: ${refused.get(callsign)}` : `У ${callsign} нет ждущих вопросов.`,
          ),
        ),
      );
      return;
    }
    const locked = r.status !== "waiting" && r.status !== "error";
    const body = r.kind === "form" ? formBody(r, locked) : askBody(r, locked);
    cta = null;
    const actions: HTMLElement[] = [];
    if (!locked || r.status === "sending") {
      if (r.kind === "form") {
        const url = typeof r.frame.url === "string";
        actions.push(
          h("button", { class: "sb-cta", disabled: r.status === "sending", onclick: () => send(r, url ? { action: "accept" } : { action: "accept", content: { ...formVals } }) }, url ? "Перешёл" : "Отправить"),
          h("button", { class: "ask-decline", disabled: r.status === "sending", onclick: () => send(r, { action: "decline" }) }, "Отклонить"),
        );
      } else {
        cta = h("button", { class: "sb-cta", onclick: () => {
          const a = answersOf(r);
          if (a) void send(r, { answers: a }, a);
        } }, r.status === "sending" ? "Отправляю…" : "Ответить") as HTMLButtonElement;
        actions.push(cta);
      }
    }
    const others = r.to.filter((x) => x !== app.name);
    el.append(
      h(
        "div",
        { class: "sb-pad ask" },
        body,
        actions,
        result(r),
        r.to.length ? h("div", { class: "ask-hint" }, `Вопрос видят: вы${others.length ? " и " + others.join(", ") : ""}`) : null,
      ),
    );
    syncCta();
  }

  void list(callsign, true);
  draw();
  return {
    head: () => {
      const r = current();
      const pill =
        !r || r.status === "waiting" || r.status === "sending" || r.status === "error"
          ? { text: "ждёт ответа", tone: "wait" as const }
          : r.status === "ok"
            ? { text: "ответ принят", tone: "ok" as const }
            : { text: r.status === "cancelled" ? "снят" : "уже ответили", tone: "" as const };
      return { title: callsign, mono: true, sub: r ? `вопрос сессии · ${hhmm(r.at)}` : "вопрос сессии", pill: r || loading.has(callsign) ? pill : undefined };
    },
    refresh: () => {
      // поле своего ответа под пальцем сохраняет фокус после перерисовки
      const a = document.activeElement as HTMLElement | null;
      const focused = a && el.contains(a) ? a.dataset.own : undefined;
      draw();
      if (focused !== undefined) {
        const inp = [...el.querySelectorAll<HTMLInputElement>("input[data-own]")].find((x) => x.dataset.own === focused);
        inp?.focus();
      }
    },
  };
}

return {
  frames: { question: onQuestion, answered: onAnswered },
  on: { roster: onRoster, link: onLink },
  screens: { ask: { label: "Вопрос", mount: mountAsk } },
  marks: { asked },
  css: CSS,
  start(a) {
    app = a;
  },
};
}
