// Комментарии на дев-стенде: C (c или с, в любой раскладке) → навести и нажать на элемент, либо выделить текст и нажать C → написать.
// Хранит сервер стенда, событие comments — файл изменился. Наложение живёт в своём shadow DOM вне #app: страница о нём не знает.
export type Comment = { id: string; at: string; text: string; app: string; kind: string; hash: string; screen: string | null; module: string | null; selector: string; element: string; quote?: string };
type Mode = "idle" | "pick" | "write";

const KEYS = new Set(["c", "C", "с", "С"]);
const EDITABLE = "input:not([type=range]):not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable]:not([contenteditable=false])";
const API = "/api/comments";

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

/** Шаг селектора: data-атрибуты важнее классов, положение — только среди одинаковых. */
function stepOf(e: Element): string {
  const data = [...e.attributes].filter((a) => a.name.startsWith("data-") && a.value && a.value.length <= 60).slice(0, 2);
  let s = CSS.escape(e.localName);
  if (data.length) s += data.map((a) => `[${a.name}="${a.value.replace(/["\\]/g, "\\$&")}"]`).join("");
  else if (e.classList.length) s += [...e.classList].slice(0, 3).map((c) => `.${CSS.escape(c)}`).join("");
  const kids = e.parentElement ? [...e.parentElement.children] : [];
  if (kids.filter((x) => x.matches(s)).length > 1) s += `:nth-of-type(${kids.filter((x) => x.localName === e.localName).indexOf(e) + 1})`;
  return s;
}

/** Селектор, ведущий ровно к этому элементу. */
function selectorOf(el: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    parts.unshift(stepOf(e));
    const found = document.querySelectorAll(parts.join(" > "));
    if (found.length === 1 && found[0] === el) break;
  }
  return parts.join(" > ");
}

const snippet = (el: Element) => (((el as HTMLElement).innerText ?? el.textContent) || "").trim().replace(/\s+/g, " ").slice(0, 80);
const when = (at: string) => new Date(at).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function startComments({ app, kind, events }: { app: string; kind: string; events: EventSource }) {
  const host = document.createElement("div");
  host.id = "stand-comments";
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const root = host.attachShadow({ mode: "open" });
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: Node = root) => {
    const n = document.createElement(tag);
    n.className = cls;
    parent.appendChild(n);
    return n;
  };
  make("style", "").textContent = STYLE;
  const box = make("div", "box");
  const pins = make("div", "pins");
  const chip = make("div", "chip");
  chip.textContent = "Наведите на элемент и нажмите · Esc — выйти";
  const list = make("div", "list");
  const card = make("div", "card");
  box.hidden = chip.hidden = list.hidden = card.hidden = true;
  document.body.appendChild(host);

  let mode: Mode = "idle";
  let target: Element | null = null;
  let comments: Comment[] = [];
  /** id комментария, открытого в карточке */
  let shown: string | null = null;

  const mine = () => comments.filter((c) => c.app === app);
  const inHost = (e: Event) => e.composedPath().includes(host);
  /** Элемент под точкой; внутри svg — сам значок; наложение не выбирается. */
  const under = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y);
    return el && el !== host ? (el.closest("svg") ?? el) : null;
  };

  function frame(el: Element | null) {
    target = el;
    box.hidden = !el;
    if (!el) return;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
  }

  /** Карточка рядом с элементом: снизу, не влезла — сверху; в пределах окна. */
  function placeCard(el: Element) {
    const r = el.getBoundingClientRect();
    const top = r.bottom + 8 + card.offsetHeight <= innerHeight ? r.bottom + 8 : Math.max(8, r.top - card.offsetHeight - 8);
    card.style.left = `${Math.max(8, Math.min(innerWidth - card.offsetWidth - 8, r.left))}px`;
    card.style.top = `${top}px`;
  }

  function closeCard() {
    card.hidden = true;
    card.replaceChildren();
    shown = null;
  }

  function setMode(next: Mode) {
    mode = next;
    chip.hidden = next !== "pick";
    list.hidden = next !== "pick" || !mine().length;
    document.documentElement.style.cursor = next === "pick" ? "crosshair" : "";
    if (next !== "write") closeCard();
    if (next === "idle") frame(null);
  }

  function write(el: Element, quote?: string) {
    setMode("write");
    frame(el);
    card.replaceChildren();
    if (quote) make("div", "quote", card).textContent = quote;
    const area = make("textarea", "", card);
    area.setAttribute("aria-label", "Комментарий");
    const row = make("div", "row", card);
    const err = make("span", "err", row);
    const cancel = make("button", "act", row);
    cancel.textContent = "Отмена";
    cancel.onclick = () => setMode("idle");
    const send = make("button", "act pri", row);
    send.textContent = "Сохранить";
    const submit = async () => {
      const text = area.value.trim();
      if (!text) return;
      const draft = {
        text,
        app,
        kind,
        hash: location.hash,
        screen: el.closest("[data-screen]")?.getAttribute("data-screen") ?? null,
        module: el.closest("[data-module]")?.getAttribute("data-module") ?? null,
        selector: selectorOf(el),
        element: snippet(el),
        ...(quote ? { quote } : {}),
      };
      send.disabled = true;
      const word = await fetch(API, { method: "POST", body: JSON.stringify(draft) }).then(
        async (r) => (r.ok ? null : ((await r.json()) as { error: string }).error),
        (e: Error) => e.message,
      );
      send.disabled = false;
      if (word) err.textContent = `Не сохранилось: ${word}`;
      else setMode("idle");
    };
    send.onclick = () => void submit();
    area.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") setMode("idle");
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void submit();
      }
    });
    card.hidden = false;
    placeCard(el);
    area.focus();
  }

  /** Комментарий в карточке у своего элемента. */
  function show(c: Comment, el: Element) {
    shown = c.id;
    card.replaceChildren();
    if (c.quote) make("div", "quote", card).textContent = c.quote;
    make("p", "", card).textContent = c.text;
    const row = make("div", "row", card);
    make("time", "", row).textContent = when(c.at);
    const del = make("button", "act", row);
    del.textContent = "Удалить";
    del.onclick = () => {
      closeCard();
      void fetch(`${API}/${c.id}`, { method: "DELETE" });
    };
    card.hidden = false;
    placeCard(el);
  }

  /** Метка стоит у своего элемента, пока он на экране и его ничего не закрывает. */
  function place() {
    for (const pin of pins.children as HTMLCollectionOf<HTMLButtonElement>) {
      const c = comments.find((x) => x.id === pin.dataset.id);
      const el = c && document.querySelector(c.selector);
      const r = el?.getBoundingClientRect();
      if (!el || !r || !r.width || !r.height || r.bottom < 0 || r.top > innerHeight) {
        pin.hidden = true;
        continue;
      }
      const top = document.elementFromPoint(Math.min(r.left + r.width / 2, innerWidth - 1), Math.max(0, Math.min(r.top + r.height / 2, innerHeight - 1)));
      pin.hidden = !top || (top !== host && !el.contains(top) && !top.contains(el));
      pin.style.left = `${Math.max(12, Math.min(innerWidth - 12, r.right))}px`;
      pin.style.top = `${Math.max(12, Math.min(innerHeight - 12, r.top))}px`;
    }
    if (mode === "write" && target) frame(target);
  }

  function draw() {
    pins.replaceChildren();
    list.replaceChildren();
    mine().forEach((c, i) => {
      const pin = make("button", "pin", pins);
      pin.textContent = String(i + 1);
      pin.dataset.id = c.id;
      pin.setAttribute("aria-label", `Комментарий ${i + 1}: ${c.text}`);
      pin.hidden = true;
      pin.onclick = () => {
        const el = document.querySelector(c.selector);
        if (shown === c.id) closeCard();
        else if (el) show(c, el);
      };
      const it = make("button", "it", list);
      make("b", "", it).textContent = String(i + 1);
      make("span", "", it).textContent = c.text;
      it.title = c.element;
      it.onclick = () => {
        setMode("idle");
        location.hash = c.hash;
        // экран рисуется после смены адреса
        setTimeout(() => {
          const el = document.querySelector(c.selector);
          if (!el) return;
          el.scrollIntoView({ block: "center" });
          show(c, el);
        }, 250);
      };
    });
    list.hidden = mode !== "pick" || !mine().length;
    if (shown && !comments.some((c) => c.id === shown)) closeCard();
    place();
  }

  async function load() {
    const r = await fetch(API);
    // файл пишут прямо сейчас: следующее событие comments перечитает
    if (!r.ok) return;
    comments = ((await r.json()) as { comments: Comment[] }).comments;
    draw();
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && (mode !== "idle" || shown)) {
        e.preventDefault();
        e.stopPropagation();
        return setMode("idle");
      }
      if (mode === "write" || inHost(e)) return;
      if (!(KEYS.has(e.key) || e.code === "KeyC") || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if ((e.target as Element | null)?.matches?.(EDITABLE)) return;
      e.preventDefault();
      e.stopPropagation();
      if (mode === "pick") return setMode("idle");
      const sel = document.getSelection();
      const quote = sel && !sel.isCollapsed ? sel.toString().trim().slice(0, 500) : "";
      if (!quote) return setMode("pick");
      const node = sel!.getRangeAt(0).commonAncestorContainer;
      write(node instanceof Element ? node : node.parentElement!, quote);
    },
    true,
  );
  document.addEventListener("pointermove", (e) => mode === "pick" && frame(under(e.clientX, e.clientY)), true);
  // в режиме выбора страница нажатий не получает: кнопка не срабатывает, перетаскивание не начинается
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "touchstart", "touchend"]) {
    document.addEventListener(
      type,
      (e) => {
        if (mode !== "pick" || inHost(e)) return;
        // касание не отменяем: из него браузер делает click, им и выбирается элемент
        if (type === "mousedown") e.preventDefault();
        e.stopPropagation();
      },
      true,
    );
  }
  document.addEventListener(
    "click",
    (e) => {
      if (inHost(e)) return;
      if (mode === "pick") {
        e.preventDefault();
        e.stopPropagation();
        const el = under(e.clientX, e.clientY);
        if (el) write(el);
      } else if (shown) closeCard();
    },
    true,
  );
  addEventListener("scroll", place, { capture: true, passive: true });
  addEventListener("resize", place);
  // экраны меняются сами (кадры, переходы): метки догоняют свои элементы
  setInterval(place, 250);
  events.addEventListener("comments", () => void load());
  void load();
}
