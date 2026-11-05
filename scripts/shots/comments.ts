// Наложение комментариев стенда: C — выбор элемента, текст — запись в файл флота на сервере, метки над элементами, список записей.
// О странице не знает: живёт в своём Shadow DOM, читает только разметку и адрес. Записи — только с сервера: любая правка файла приходит событием comments.
type Comment = { id: string; text: string; selector: string; app: string; screen: string | null; hash: string; quote?: string };
export type CommentsOptions = { app: string; kind: string; events: EventSource };

const LAYOUT_MS = 100;
const TEXT_LIMIT = 200;
const QUOTE_LIMIT = 500;
const EDITABLE = "input:not([type=range]):not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable]:not([contenteditable=false])";
const STYLE = `
* { box-sizing: border-box; font: 13px/1.4 system-ui, sans-serif; color: #111; }
[hidden] { display: none !important; }
.layer { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
.box { position: fixed; border: 2px solid #e8590c; background: #e8590c22; }
.chip, .card, .pin { position: fixed; pointer-events: auto; background: #fff; border: 1px solid #e8590c; border-radius: 8px; }
.chip { top: 8px; right: 8px; max-width: 320px; max-height: 60vh; overflow: auto; padding: 6px 10px; }
.it { display: block; width: 100%; padding: 4px 0; border: 0; background: none; text-align: left; cursor: pointer; }
.pin { width: 20px; height: 20px; padding: 0; border-radius: 50%; background: #e8590c; color: #fff; cursor: pointer; }
.card { width: min(320px, calc(100vw - 16px)); padding: 8px; }
textarea { display: block; width: 100%; min-height: 64px; resize: vertical; }
.acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.act { border: 1px solid #999; border-radius: 6px; background: #eee; padding: 2px 10px; cursor: pointer; }
.quote { border-left: 3px solid #e8590c; padding-left: 8px; margin-bottom: 6px; max-height: 60px; overflow: hidden; }
.err { color: #c00; }
`;

/** Кратчайший однозначный путь до элемента: предки добавляются, пока селектор не найдёт только его. */
function selectorOf(el: Element): string {
  const step = (e: Element) => {
    const classes = [...e.classList].map((c) => `.${CSS.escape(c)}`).join("");
    const callsign = e.getAttribute("data-callsign");
    return `${e.tagName.toLowerCase()}${classes}${callsign ? `[data-callsign=${JSON.stringify(callsign)}]` : ""}:nth-child(${[...(e.parentElement?.children ?? [e])].indexOf(e) + 1})`;
  };
  let path = step(el);
  for (let e = el.parentElement; e && document.querySelectorAll(path).length > 1; e = e.parentElement) path = `${step(e)} > ${path}`;
  return path;
}

const attrOf = (el: Element, name: string) => el.closest(`[${name}]`)?.getAttribute(name) ?? null;
const textOf = (el: Element) => (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, TEXT_LIMIT);
/** Клавиша C в любой раскладке: своя буква или физическая клавиша. */
const isC = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey && (e.code === "KeyC" || "cс".includes(e.key.toLowerCase()));
const button = (className: string, text: string, run: () => void) => {
  const b = document.createElement("button");
  b.className = className;
  b.textContent = text;
  b.onclick = run;
  return b;
};

export function startComments({ app, kind, events }: CommentsOptions): void {
  const host = document.createElement("div");
  host.id = "stand-comments";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${STYLE}</style><div class="layer"><div class="box" hidden></div><div class="pins"></div><div class="chip" hidden></div><div class="card" hidden></div></div>`;
  document.body.append(host);
  const [box, pins, chip, card] = [".box", ".pins", ".chip", ".card"].map((s) => shadow.querySelector<HTMLElement>(s)!);

  let comments: Comment[] = [];
  let picking = false;
  /** какая запись открыта в карточке: снятую агентом карточка не показывает */
  let open: string | null = null;

  const closeCard = () => {
    card.hidden = true;
    open = null;
  };
  const setPicking = (on: boolean) => {
    picking = on;
    box.hidden = true;
    chip.hidden = !on;
    if (on) closeCard();
  };
  const showCard = (near: Element | null, ...content: HTMLElement[]) => {
    setPicking(false);
    const r = near?.getBoundingClientRect();
    card.style.left = `${Math.max(8, Math.min(r?.left ?? 8, innerWidth - 328))}px`;
    card.style.top = `${Math.max(8, Math.min(r?.bottom ?? 8, innerHeight - 160))}px`;
    card.replaceChildren(...content);
    card.hidden = false;
  };
  const acts = (...list: HTMLElement[]) => {
    const row = document.createElement("div");
    row.className = "acts";
    row.append(...list);
    return row;
  };

  /** Запрос к серверу стенда: отказ — словом в карточке, карточка остаётся. */
  const save = (path: string, init: RequestInit) =>
    fetch(path, init)
      .then(async (r) => (r.ok ? closeCard() : Promise.reject(new Error(((await r.json()) as { error: string }).error))))
      .catch((e: Error) => {
        const word = document.createElement("div");
        word.className = "err";
        word.textContent = `Не сохранилось: ${e.message}`;
        card.append(word);
      });

  const quoteBlock = (quote?: string) => {
    if (!quote) return [];
    const q = document.createElement("div");
    q.className = "quote";
    q.textContent = quote;
    return [q];
  };

  function newComment(el: Element, quote?: string) {
    const input = document.createElement("textarea");
    const send = () => void save("/api/comments", { method: "POST", body: JSON.stringify({ text: input.value, selector: selectorOf(el), element: textOf(el), app, kind, screen: attrOf(el, "data-screen"), module: attrOf(el, "data-module"), hash: location.hash, ...(quote ? { quote } : {}) }) });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      e.preventDefault();
      send();
    });
    showCard(el, ...quoteBlock(quote), input, acts(button("act", "Отмена", closeCard), button("act", "Сохранить", send)));
    input.focus();
  }
  function showComment(c: Comment) {
    const text = document.createElement("div");
    text.textContent = c.text;
    showCard(document.querySelector(c.selector), ...quoteBlock(c.quote), text, acts(button("act", "Закрыть", closeCard), button("act", "Удалить", () => void save(`/api/comments/${c.id}`, { method: "DELETE" }))));
    open = c.id;
  }

  /** Записи с сервера. Файл прочли посреди записи — отказ, следующее событие перечитает. */
  async function load() {
    const r = await fetch("/api/comments");
    if (!r.ok) return;
    comments = ((await r.json()) as { comments: Comment[] }).comments.filter((c) => c.app === app);
    if (open && !comments.some((c) => c.id === open)) closeCard();
    chip.replaceChildren(
      "Выбор элемента · Esc",
      ...comments.map((c) =>
        button("it", c.text, () => {
          location.hash = c.hash;
          showComment(c);
        }),
      ),
    );
    pins.replaceChildren(...comments.map((c, i) => button("pin", String(i + 1), () => showComment(c))));
    layout();
  }

  /** Метка видна, когда её элемент на её экране есть на странице. */
  function layout() {
    comments.forEach((c, i) => {
      const pin = pins.children[i] as HTMLElement;
      const el = document.querySelector(c.selector);
      const r = el?.getBoundingClientRect();
      pin.hidden = !el || !r?.width || attrOf(el, "data-screen") !== c.screen;
      if (!r || pin.hidden) return;
      pin.style.left = `${r.right - 22}px`;
      pin.style.top = `${r.top + 2}px`;
    });
  }

  const picked = (e: Event) => picking && !e.composedPath().includes(host);
  // выбор перехватывает всё до страницы: нажатие выбирает элемент и больше ничего не делает
  for (const type of ["pointerdown", "mousedown", "touchstart", "pointerup", "mouseup", "touchend"]) {
    addEventListener(type, (e) => void (picked(e) && e.stopPropagation()), true);
  }
  addEventListener(
    "click",
    (e) => {
      if (!picked(e)) return;
      e.preventDefault();
      e.stopPropagation();
      newComment(e.target as Element);
    },
    true,
  );
  addEventListener(
    "mousemove",
    (e) => {
      if (!picked(e)) return;
      const r = (e.target as Element).getBoundingClientRect();
      box.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
      box.hidden = false;
    },
    true,
  );
  addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && (picking || !card.hidden)) {
        e.stopPropagation();
        setPicking(false);
        closeCard();
      } else if (isC(e) && !(e.composedPath()[0] as Element).matches?.(EDITABLE)) {
        e.preventDefault();
        e.stopPropagation();
        const selection = document.getSelection();
        const quote = selection?.toString().trim().slice(0, QUOTE_LIMIT);
        if (picking || !quote) return setPicking(!picking);
        const node = selection!.getRangeAt(0).commonAncestorContainer;
        newComment(node instanceof Element ? node : node.parentElement!, quote);
      }
    },
    true,
  );

  setInterval(layout, LAYOUT_MS);
  events.addEventListener("comments", () => void load());
  void load();
}
