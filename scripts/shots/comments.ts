// Комментарии на дев-стенде: C (c или с, в любой раскладке) → навести и нажать на элемент, либо выделить текст и нажать C → написать.
// Хранит сервер стенда, событие comments — файл изменился. Наложение живёт в своём shadow DOM вне #app: страница о нём не знает.
import { selectorOf } from "./selector.ts";

export type Comment = { id: string; at: string; text: string; app: string; kind: string; hash: string; screen: string | null; module: string | null; selector: string; element: string; quote?: string };
type Mode = "idle" | "pick" | "write";

const KEYS = new Set(["c", "C", "с", "С"]);
const EDITABLE = "input:not([type=range]):not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable]:not([contenteditable=false])";
const API = "/api/comments";
const POINTER_EVENTS = ["pointerdown", "mousedown", "pointerup", "mouseup", "touchstart", "touchend"];
/** Экраны меняются сами (кадры, переходы): метки догоняют свои элементы. */
const FOLLOW_MS = 250;
/** Экран рисуется после смены адреса. */
const SCREEN_MS = 250;

const STYLE = `
*{box-sizing:border-box;font:13px/1.4 system-ui,sans-serif}
[hidden]{display:none!important}
.box{position:fixed;border:2px solid #e8590c;background:#e8590c22;border-radius:3px;pointer-events:none}
.pin{position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50% 50% 50% 2px;border:0;background:#e8590c;color:#fff;font-weight:700;font-size:11px;box-shadow:0 2px 6px #0005;cursor:pointer;pointer-events:auto;padding:0}
.chip{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);background:#1c1c1e;color:#fff;border-radius:999px;padding:6px 14px;white-space:nowrap;pointer-events:none}
.card{position:fixed;width:min(320px,calc(100vw - 16px));background:#fff;color:#1c1c1e;border-radius:10px;box-shadow:0 10px 32px #0006;padding:10px;pointer-events:auto;display:flex;flex-direction:column;gap:8px}
.card textarea{width:100%;min-height:64px;resize:vertical;border:1px solid #ccc;border-radius:6px;padding:6px 8px;color:inherit;background:#fff;outline-color:#e8590c}
.card p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.quote{border-left:3px solid #e8590c;padding-left:8px;color:#555;max-height:60px;overflow:hidden}
.row{display:flex;justify-content:flex-end;align-items:center;gap:8px}
.row time,.err{margin-right:auto;color:#666;font-size:12px}
.err{color:#c00}
button.act{border:1px solid #ccc;background:#fff;color:inherit;border-radius:6px;padding:3px 10px;cursor:pointer}
button.act.pri{background:#e8590c;border-color:#e8590c;color:#fff}
.list{position:fixed;right:12px;bottom:12px;width:min(280px,calc(100vw - 24px));max-height:40vh;overflow:auto;background:#fff;color:#1c1c1e;border-radius:10px;box-shadow:0 10px 32px #0006;pointer-events:auto;padding:4px}
.it{display:flex;gap:8px;align-items:baseline;width:100%;border:0;background:none;color:inherit;text-align:left;padding:6px 8px;border-radius:6px;cursor:pointer}
.it:hover{background:#0000000f}
.it b{color:#e8590c}
.it span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;

const textOf = (el: Element) => (((el as HTMLElement).innerText ?? el.textContent) || "").trim().replace(/\s+/g, " ").slice(0, 80);
const timeOf = (at: string) => new Date(at).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));

/** Отправить новый комментарий: null — сохранён, иначе слово отказа. */
function saveComment(draft: Omit<Comment, "id" | "at">): Promise<string | null> {
  return fetch(API, { method: "POST", body: JSON.stringify(draft) }).then(
    async (r) => (r.ok ? null : ((await r.json()) as { error: string }).error),
    (e: Error) => e.message,
  );
}

export function startComments({ app, kind, events }: { app: string; kind: string; events: EventSource }) {
  const host = document.createElement("div");
  host.id = "stand-comments";
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const root = host.attachShadow({ mode: "open" });

  const add = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: Node = root) => {
    const node = document.createElement(tag);
    node.className = cls;
    parent.appendChild(node);
    return node;
  };
  const addButton = (cls: string, parent: Node, text: string, onclick: () => void) => {
    const button = add("button", cls, parent);
    button.textContent = text;
    button.onclick = onclick;
    return button;
  };

  add("style", "").textContent = STYLE;
  const box = add("div", "box");
  const pins = add("div", "pins");
  const chip = add("div", "chip");
  chip.textContent = "Наведите на элемент и нажмите · Esc — выйти";
  const list = add("div", "list");
  const card = add("div", "card");
  box.hidden = chip.hidden = list.hidden = card.hidden = true;
  document.body.appendChild(host);

  let mode: Mode = "idle";
  let framed: Element | null = null;
  let comments: Comment[] = [];
  /** id комментария, открытого в карточке */
  let openId: string | null = null;

  const ofThisApp = () => comments.filter((c) => c.app === app);
  const fromOverlay = (e: Event) => e.composedPath().includes(host);
  /** Элемент под точкой; внутри svg — сам значок; наложение не выбирается. */
  const elementAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y);
    return el && el !== host ? (el.closest("svg") ?? el) : null;
  };

  function frame(el: Element | null) {
    framed = el;
    box.hidden = !el;
    if (!el) return;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
  }

  /** Карточка рядом с элементом: снизу, не влезла — сверху; в пределах окна. */
  function showCardAt(el: Element) {
    card.hidden = false;
    const r = el.getBoundingClientRect();
    const fitsBelow = r.bottom + 8 + card.offsetHeight <= innerHeight;
    card.style.left = `${Math.max(8, Math.min(innerWidth - card.offsetWidth - 8, r.left))}px`;
    card.style.top = `${fitsBelow ? r.bottom + 8 : Math.max(8, r.top - card.offsetHeight - 8)}px`;
  }

  function closeCard() {
    card.hidden = true;
    card.replaceChildren();
    openId = null;
  }

  function setMode(next: Mode) {
    mode = next;
    chip.hidden = next !== "pick";
    list.hidden = next !== "pick" || !ofThisApp().length;
    document.documentElement.style.cursor = next === "pick" ? "crosshair" : "";
    if (next !== "write") closeCard();
    if (next === "idle") frame(null);
  }

  /** Карточка нового комментария у элемента. */
  function startWriting(el: Element, quote?: string) {
    setMode("write");
    frame(el);
    card.replaceChildren();
    if (quote) add("div", "quote", card).textContent = quote;
    const area = add("textarea", "", card);
    area.setAttribute("aria-label", "Комментарий");
    const row = add("div", "row", card);
    const error = add("span", "err", row);
    addButton("act", row, "Отмена", () => setMode("idle"));
    const submit = async () => {
      const text = area.value.trim();
      if (!text) return;
      send.disabled = true;
      const word = await saveComment({
        text,
        app,
        kind,
        hash: location.hash,
        screen: el.closest("[data-screen]")?.getAttribute("data-screen") ?? null,
        module: el.closest("[data-module]")?.getAttribute("data-module") ?? null,
        selector: selectorOf(el),
        element: textOf(el),
        ...(quote ? { quote } : {}),
      });
      send.disabled = false;
      if (word) error.textContent = `Не сохранилось: ${word}`;
      else setMode("idle");
    };
    const send = addButton("act pri", row, "Сохранить", () => void submit());
    area.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") setMode("idle");
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void submit();
      }
    });
    showCardAt(el);
    area.focus();
  }

  /** Комментарий в карточке у своего элемента. */
  function showComment(c: Comment, el: Element) {
    openId = c.id;
    card.replaceChildren();
    if (c.quote) add("div", "quote", card).textContent = c.quote;
    add("p", "", card).textContent = c.text;
    const row = add("div", "row", card);
    add("time", "", row).textContent = timeOf(c.at);
    addButton("act", row, "Удалить", () => {
      closeCard();
      void fetch(`${API}/${c.id}`, { method: "DELETE" });
    });
    showCardAt(el);
  }

  /** Метка стоит у своего элемента, пока он на экране и его ничего не закрывает. */
  function followPins() {
    for (const pin of pins.children as HTMLCollectionOf<HTMLButtonElement>) {
      const c = comments.find((x) => x.id === pin.dataset.id);
      const el = c && document.querySelector(c.selector);
      const r = el?.getBoundingClientRect();
      if (!el || !r || !r.width || !r.height || r.bottom < 0 || r.top > innerHeight) {
        pin.hidden = true;
        continue;
      }
      const onTop = document.elementFromPoint(Math.min(r.left + r.width / 2, innerWidth - 1), clamp(r.top + r.height / 2, 0, innerHeight - 1));
      pin.hidden = !onTop || (onTop !== host && !el.contains(onTop) && !onTop.contains(el));
      pin.style.left = `${clamp(r.right, 12, innerWidth - 12)}px`;
      pin.style.top = `${clamp(r.top, 12, innerHeight - 12)}px`;
    }
    if (mode === "write" && framed) frame(framed);
  }

  /** Метка и строка списка одного комментария. */
  function addCommentRow(c: Comment, number: string) {
    const pin = addButton("pin", pins, number, () => {
      const el = document.querySelector(c.selector);
      if (openId === c.id) closeCard();
      else if (el) showComment(c, el);
    });
    pin.dataset.id = c.id;
    pin.setAttribute("aria-label", `Комментарий ${number}: ${c.text}`);
    pin.hidden = true;
    const item = addButton("it", list, "", () => {
      setMode("idle");
      location.hash = c.hash;
      setTimeout(() => {
        const el = document.querySelector(c.selector);
        if (!el) return;
        el.scrollIntoView({ block: "center" });
        showComment(c, el);
      }, SCREEN_MS);
    });
    add("b", "", item).textContent = number;
    add("span", "", item).textContent = c.text;
    item.title = c.element;
  }

  function drawComments() {
    pins.replaceChildren();
    list.replaceChildren();
    ofThisApp().forEach((c, i) => addCommentRow(c, String(i + 1)));
    list.hidden = mode !== "pick" || !ofThisApp().length;
    if (openId && !comments.some((c) => c.id === openId)) closeCard();
    followPins();
  }

  async function loadComments() {
    const r = await fetch(API);
    // файл пишут прямо сейчас: следующее событие comments перечитает
    if (!r.ok) return;
    comments = ((await r.json()) as { comments: Comment[] }).comments;
    drawComments();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && (mode !== "idle" || openId)) {
      e.preventDefault();
      e.stopPropagation();
      return setMode("idle");
    }
    if (mode === "write" || fromOverlay(e)) return;
    if (!(KEYS.has(e.key) || e.code === "KeyC") || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if ((e.target as Element | null)?.matches?.(EDITABLE)) return;
    e.preventDefault();
    e.stopPropagation();
    if (mode === "pick") return setMode("idle");
    const selection = document.getSelection();
    const quote = selection && !selection.isCollapsed ? selection.toString().trim().slice(0, 500) : "";
    if (!quote) return setMode("pick");
    const node = selection!.getRangeAt(0).commonAncestorContainer;
    startWriting(node instanceof Element ? node : node.parentElement!, quote);
  }

  /** В режиме выбора страница нажатий не получает: кнопка не срабатывает, перетаскивание не начинается. */
  function holdPointer(e: Event) {
    if (mode !== "pick" || fromOverlay(e)) return;
    // касание не отменяем: из него браузер делает click, им и выбирается элемент
    if (e.type === "mousedown") e.preventDefault();
    e.stopPropagation();
  }

  function onClick(e: MouseEvent) {
    if (fromOverlay(e)) return;
    if (mode === "pick") {
      e.preventDefault();
      e.stopPropagation();
      const el = elementAt(e.clientX, e.clientY);
      if (el) startWriting(el);
    } else if (openId) closeCard();
  }

  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointermove", (e) => mode === "pick" && frame(elementAt(e.clientX, e.clientY)), true);
  for (const type of POINTER_EVENTS) document.addEventListener(type, holdPointer, true);
  document.addEventListener("click", onClick, true);
  addEventListener("scroll", followPins, { capture: true, passive: true });
  addEventListener("resize", followPins);
  setInterval(followPins, FOLLOW_MS);
  events.addEventListener("comments", () => void loadComments());
  void loadComments();
}
