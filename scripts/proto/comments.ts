// Комментарии к элементам прототипа: кнопка или Alt+C — режим; клик по элементу — поле; метки на элементах, общий список.
// Комментарий: адрес экрана, селектор, текст элемента, размер окна; пишет сервер прототипа в JSON-файл.
type Note = { id: string; hash: string; selector: string; element: string; comment: string; viewport: { w: number; h: number }; theme: string; at: string };

const STYLE = `.pc-bar{position:fixed;left:12px;bottom:12px;z-index:9999;display:flex;gap:6px;font:600 12.5px system-ui,sans-serif}
.pc-bar button{border:1px solid #17201B;background:#FBFCFA;color:#17201B;border-radius:999px;padding:6px 12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.15)}
.pc-bar button[aria-pressed="true"]{background:#A85A05;border-color:#A85A05;color:#fff}
.pc-hl{position:fixed;z-index:9996;pointer-events:none;border:2px solid #A85A05;border-radius:6px;background:rgba(168,90,5,.08);display:none}
body.pc-on .pc-hl{display:block}
body.pc-on, body.pc-on *{cursor:crosshair!important}
.pc-pin{position:absolute;z-index:9995;min-width:20px;height:20px;border-radius:10px;background:#A85A05;color:#fff;font:700 11px/20px system-ui,sans-serif;text-align:center;padding:0 5px;box-shadow:0 1px 4px rgba(0,0,0,.3);cursor:pointer}
.pc-pop{position:fixed;z-index:10000;width:min(360px,calc(100vw - 24px));background:#FBFCFA;color:#17201B;border:1px solid #D3D9D2;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.25);padding:10px;display:flex;flex-direction:column;gap:8px;font:13px/1.4 system-ui,sans-serif}
.pc-pop code{font:11px "JetBrains Mono",monospace;color:#56625B;overflow-wrap:anywhere}
.pc-pop textarea{font:14px/1.4 system-ui,sans-serif;border:1px solid #D3D9D2;border-radius:8px;padding:7px;min-height:84px;resize:vertical;color:#17201B;background:#fff}
.pc-pop .row{display:flex;gap:6px;justify-content:flex-end}
.pc-pop button{border:1px solid #D3D9D2;background:#fff;border-radius:8px;padding:5px 11px;cursor:pointer;font:600 12.5px system-ui,sans-serif}
.pc-pop button.pri{background:#17201B;color:#fff;border-color:#17201B}
.pc-list{position:fixed;left:12px;bottom:56px;z-index:9999;width:min(420px,calc(100vw - 24px));max-height:60vh;overflow:auto;background:#FBFCFA;color:#17201B;border:1px solid #D3D9D2;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.25);padding:10px;font:13px/1.4 system-ui,sans-serif;display:flex;flex-direction:column;gap:8px}
.pc-list .it{border-bottom:1px solid #E2E6E0;padding-bottom:6px}
.pc-list .it b{font:600 11px "JetBrains Mono",monospace;color:#A85A05}
.pc-list .it p{margin:2px 0}
.pc-list .it small{color:#56625B;font-size:11.5px}
.pc-list .it button{float:right;border:0;background:transparent;color:#B3302A;cursor:pointer}`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Селектор, который найдёт элемент снова: id, data-атрибуты, иначе класс и номер среди соседей; до 6 уровней. */
function selectorOf(el: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el, n = 0; e && e !== document.body && n < 6; e = e.parentElement, n++) {
    if (e.id) { parts.unshift(`#${CSS.escape(e.id)}`); break; }
    const data = [...e.attributes].find((a) => a.name.startsWith("data-") && a.value && a.value.length < 60);
    let s = e.tagName.toLowerCase();
    if (data) s += `[${data.name}="${CSS.escape(data.value)}"]`;
    else if (e.classList.length) s += `.${[...e.classList].slice(0, 2).map((c) => CSS.escape(c)).join(".")}`;
    const p = e.parentElement;
    if (p && !data) {
      const same = [...p.children].filter((c) => c.tagName === e!.tagName);
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(e) + 1})`;
    }
    parts.unshift(s);
  }
  return parts.join(" > ");
}

export function startComments() {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);
  const hl = document.createElement("div");
  hl.className = "pc-hl";
  const bar = document.createElement("div");
  bar.className = "pc-bar";
  bar.innerHTML = `<button type="button" data-pc="mode" aria-pressed="false" title="Alt+C">Комментировать</button><button type="button" data-pc="list">Комментарии <span>0</span></button>`;
  const pins = document.createElement("div");
  document.body.append(hl, bar, pins);
  let on = false;
  let notes: Note[] = [];
  let pop: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  const own = (t: EventTarget | null) => t instanceof Element && !!t.closest(".pc-bar,.pc-pop,.pc-list,.pc-pin");

  const theme = () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  async function load() {
    notes = await fetch("/api/comments").then((r) => r.json()).catch(() => []);
    draw();
  }
  async function save(n: Omit<Note, "id" | "at">) {
    notes = await fetch("/api/comments", { method: "POST", body: JSON.stringify(n) }).then((r) => r.json());
    draw();
  }
  async function drop(id: string) {
    notes = await fetch("/api/comments", { method: "POST", body: JSON.stringify({ delete: id }) }).then((r) => r.json());
    draw();
  }
  function draw() {
    bar.querySelector("span")!.textContent = String(notes.length);
    pins.innerHTML = "";
    notes.forEach((n, i) => {
      if (n.hash !== location.hash) return;
      let el: Element | null = null;
      try { el = document.querySelector(n.selector); } catch { el = null; }
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      const pin = document.createElement("div");
      pin.className = "pc-pin";
      pin.textContent = String(i + 1);
      pin.title = n.comment;
      pin.style.left = `${r.right + scrollX - 10}px`;
      pin.style.top = `${r.top + scrollY - 10}px`;
      pin.onclick = () => showList(n.id);
      pins.appendChild(pin);
    });
    if (list) showList();
  }
  function mode(v: boolean) {
    on = v;
    document.body.classList.toggle("pc-on", on);
    bar.querySelector('[data-pc="mode"]')!.setAttribute("aria-pressed", String(on));
    if (!on) hl.style.display = "";
  }
  function showList(focus?: string) {
    list?.remove();
    list = document.createElement("div");
    list.className = "pc-list";
    list.innerHTML = notes.length
      ? notes.map((n, i) => `<div class="it"${n.id === focus ? ' style="outline:2px solid #A85A05"' : ""}><button type="button" data-del="${n.id}" aria-label="удалить">✕</button><b>${i + 1} · ${esc(n.hash || "#")}</b><p>${esc(n.comment)}</p><small>${esc(n.element.slice(0, 90))} · ${n.viewport.w}×${n.viewport.h} · ${n.theme}</small></div>`).join("")
      : "<small>Комментариев нет. «Комментировать» или Alt+C, затем клик по элементу.</small>";
    list.addEventListener("click", (e) => { const d = (e.target as Element).closest("[data-del]"); if (d) void drop(d.getAttribute("data-del")!); });
    document.body.appendChild(list);
  }
  function ask(el: Element, x: number, y: number) {
    pop?.remove();
    const selector = selectorOf(el);
    const element = ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    pop = document.createElement("div");
    pop.className = "pc-pop";
    pop.innerHTML = `<b>Комментарий · ${esc(location.hash || "#")}</b><code>${esc(selector)}</code><code>${esc(element.slice(0, 120))}</code><textarea aria-label="Комментарий"></textarea><div class="row"><button type="button" data-a="no">Отмена</button><button type="button" class="pri" data-a="ok">Сохранить</button></div>`;
    pop.style.left = `${Math.min(x, innerWidth - 372)}px`;
    pop.style.top = `${Math.min(y + 8, innerHeight - 240)}px`;
    document.body.appendChild(pop);
    const ta = pop.querySelector("textarea")!;
    ta.focus();
    pop.addEventListener("click", (e) => {
      const a = (e.target as Element).closest("[data-a]")?.getAttribute("data-a");
      if (a === "no") { pop?.remove(); pop = null; }
      if (a === "ok" && ta.value.trim()) {
        void save({ hash: location.hash, selector, element, comment: ta.value.trim(), viewport: { w: innerWidth, h: innerHeight }, theme: theme() });
        pop?.remove();
        pop = null;
        mode(false);
      }
    });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) (pop?.querySelector('[data-a="ok"]') as HTMLElement | null)?.click(); });
  }

  bar.addEventListener("click", (e) => {
    const b = (e.target as Element).closest("[data-pc]")?.getAttribute("data-pc");
    if (b === "mode") mode(!on);
    if (b === "list") { if (list) { list.remove(); list = null; } else showList(); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.altKey && (e.code === "KeyC")) { e.preventDefault(); mode(!on); }
    if (e.key === "Escape") { mode(false); pop?.remove(); pop = null; }
  });
  document.addEventListener("pointermove", (e) => {
    if (!on || own(e.target)) return;
    const r = (e.target as Element).getBoundingClientRect();
    Object.assign(hl.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  });
  document.addEventListener("click", (e) => {
    if (!on || own(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    ask(e.target as Element, e.clientX, e.clientY);
  }, true);
  addEventListener("hashchange", () => setTimeout(draw, 300));
  addEventListener("resize", draw);
  setInterval(draw, 2000);
  void load();
}
