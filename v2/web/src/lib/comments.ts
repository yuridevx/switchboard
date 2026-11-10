// Комментарии к элементам страницы на тестовой выкладке (сборка с VITE_COMMENTS=1).
// Ctrl+C в любой раскладке без выделенного текста — режим; клик по элементу — поле; черновики лежат в браузере.
// «Передать Claude» шлёт всю пачку одним событием журнала флота (what: comments) — её читает сторож tools/fleet/comments.ts.
import { ledgerAdd } from "@sb/protocol";

export type Where = { hash: string; selector: string; element: string; w: number; h: number; theme: string; agent: string };
export type Note = { id: string; at: number; text: string; where: Where };

const KEY = "sb2.comments";
const STYLE = `.pc-bar{position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9999;display:flex;gap:6px;font:600 12.5px system-ui,sans-serif}
.pc-bar button{border:1px solid #17201B;background:#FBFCFA;color:#17201B;border-radius:999px;padding:6px 12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.15)}
.pc-bar button[aria-pressed="true"],.pc-bar button.pri{background:#A85A05;border-color:#A85A05;color:#fff}
.pc-hl{position:fixed;z-index:9996;pointer-events:none;border:2px solid #A85A05;border-radius:6px;background:rgba(168,90,5,.08);display:none}
body.pc-on .pc-hl{display:block}
body.pc-on, body.pc-on *{cursor:crosshair!important}
.pc-pin{position:absolute;z-index:9995;min-width:20px;height:20px;border-radius:10px;background:#A85A05;color:#fff;font:700 11px/20px system-ui,sans-serif;text-align:center;padding:0 5px;box-shadow:0 1px 4px rgba(0,0,0,.3);cursor:pointer}
.pc-pop,.pc-list{position:fixed;z-index:10000;background:#FBFCFA;color:#17201B;border:1px solid #D3D9D2;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.25);padding:10px;display:flex;flex-direction:column;gap:8px;font:13px/1.4 system-ui,sans-serif}
.pc-pop{width:min(360px,calc(100vw - 24px))}
.pc-pop code{font:11px ui-monospace,monospace;color:#56625B;overflow-wrap:anywhere}
.pc-pop textarea{font:14px/1.4 system-ui,sans-serif;border:1px solid #D3D9D2;border-radius:8px;padding:7px;min-height:84px;resize:vertical;color:#17201B;background:#fff}
.pc-pop .row{display:flex;gap:6px;justify-content:flex-end}
.pc-pop button{border:1px solid #D3D9D2;background:#fff;color:#17201B;border-radius:8px;padding:5px 11px;cursor:pointer;font:600 12.5px system-ui,sans-serif}
.pc-pop button.pri{background:#17201B;color:#fff;border-color:#17201B}
.pc-list{left:12px;bottom:calc(56px + env(safe-area-inset-bottom,0px));width:min(420px,calc(100vw - 24px));max-height:60vh;overflow:auto}
.pc-list .it{border-bottom:1px solid #E2E6E0;padding-bottom:6px}
.pc-list .it b{font:600 11px ui-monospace,monospace;color:#A85A05}
.pc-list .it p{margin:2px 0;white-space:pre-wrap}
.pc-list .it small{color:#56625B;font-size:11.5px}
.pc-list .it button{float:right;border:0;background:transparent;color:#B3302A;cursor:pointer}`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Ctrl+C физической клавишей C (любая раскладка) и без выделенного текста: с выделением это обычное копирование. */
export function isHotkey(e: { code: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }, selected: boolean): boolean {
  return e.code === "KeyC" && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !selected;
}

/** Выделен ли текст — на странице или в поле ввода. */
function hasSelection(): boolean {
  if ((getSelection()?.toString() ?? "") !== "") return true;
  const a = document.activeElement as HTMLInputElement | null;
  try { return !!a && typeof a.selectionStart === "number" && a.selectionStart !== a.selectionEnd; } catch { return false; }
}

/** Селектор, который найдёт элемент снова: id, data-атрибуты, иначе класс и номер среди соседей; до 6 уровней. */
export function selectorOf(el: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el, n = 0; e && e !== document.body && n < 6; e = e.parentElement, n++) {
    if (e.id && !/^(mantine-|_r_|:)/.test(e.id)) { parts.unshift(`#${CSS.escape(e.id)}`); break; }
    const data = [...e.attributes].find((a) => a.name.startsWith("data-") && a.value && a.value.length < 60 && !a.name.startsWith("data-mantine") && a.name !== "data-discover");
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

/** Что это за элемент словами: его текст; у значка без текста — подпись или адрес ближайшего предка. */
export function nameOf(el: Element): string {
  const text = ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 200);
  const named = el.closest("[aria-label],[title],a[href]");
  return (named?.getAttribute("aria-label") ?? named?.getAttribute("title") ?? named?.getAttribute("href") ?? "").slice(0, 200);
}

export const drafts = {
  read: (): Note[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? "[]") as Note[]; } catch { return []; } },
  write: (notes: Note[]) => { try { localStorage.setItem(KEY, JSON.stringify(notes)); } catch { /* без хранилища черновики живут до перезагрузки */ } },
};

type Send = (def: typeof ledgerAdd, input: { what: string; text: string; data: unknown }) => Promise<unknown>;

export function startComments(send: Send): void {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);
  const hl = document.createElement("div");
  hl.className = "pc-hl";
  const bar = document.createElement("div");
  bar.className = "pc-bar";
  const pins = document.createElement("div");
  document.body.append(hl, bar, pins);
  let on = false;
  let notes = drafts.read();
  let pop: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  let sending = false;
  let failed = "";
  const own = (t: EventTarget | null) => t instanceof Element && !!t.closest(".pc-bar,.pc-pop,.pc-list,.pc-pin");
  const theme = () => document.documentElement.getAttribute("data-mantine-color-scheme") ?? "";
  const keep = (next: Note[]) => { notes = next; drafts.write(notes); draw(); };

  function draw() {
    // панель видна, пока идёт режим или есть неотправленные комментарии
    bar.hidden = !on && !notes.length;
    bar.innerHTML = `<button type="button" data-pc="mode" aria-pressed="${on}">Комментировать</button>` +
      (notes.length ? `<button type="button" data-pc="list">Комментарии ${notes.length}</button><button type="button" class="pri" data-pc="send"${sending ? " disabled" : ""}>Передать Claude</button>` : "");
    pins.innerHTML = "";
    notes.forEach((n, i) => {
      if (n.where.hash !== location.hash) return;
      let el: Element | null = null;
      try { el = document.querySelector(n.where.selector); } catch { el = null; }
      const r = el?.getBoundingClientRect();
      if (!r || (!r.width && !r.height)) return;
      const pin = document.createElement("div");
      pin.className = "pc-pin";
      pin.textContent = String(i + 1);
      pin.title = n.text;
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
    if (!on) hl.style.display = "";
    draw();
  }
  function hideList() {
    list?.remove();
    list = null;
  }
  function showList(focus?: string) {
    list?.remove();
    list = document.createElement("div");
    list.className = "pc-list";
    list.innerHTML = (failed ? `<small style="color:#B3302A">${esc(failed)}</small>` : "") + notes.map((n, i) => `<div class="it"${n.id === focus ? ' style="outline:2px solid #A85A05"' : ""}><button type="button" data-del="${n.id}" aria-label="удалить">✕</button><b>${i + 1} · ${esc(n.where.hash || "#")}</b><p>${esc(n.text)}</p><small>${esc(n.where.element.slice(0, 90))}</small></div>`).join("");
    list.addEventListener("click", (e) => {
      const d = (e.target as Element).closest("[data-del]");
      if (!d) return;
      keep(notes.filter((n) => n.id !== d.getAttribute("data-del")));
      if (!notes.length) hideList();
    });
    document.body.appendChild(list);
  }
  function ask(el: Element, x: number, y: number) {
    pop?.remove();
    const selector = selectorOf(el);
    const element = nameOf(el);
    const box = document.createElement("div");
    pop = box;
    box.className = "pc-pop";
    box.innerHTML = `<b>Комментарий · ${esc(location.hash || "#")}</b><code>${esc(element.slice(0, 120) || selector)}</code><textarea aria-label="Комментарий"></textarea><div class="row"><button type="button" data-a="no">Отмена</button><button type="button" class="pri" data-a="ok">Сохранить</button></div>`;
    box.style.left = `${Math.max(12, Math.min(x, innerWidth - 372))}px`;
    box.style.top = `${Math.max(12, Math.min(y + 8, innerHeight - 240))}px`;
    document.body.appendChild(box);
    const ta = box.querySelector("textarea")!;
    ta.focus();
    const close = () => { box.remove(); if (pop === box) pop = null; };
    const ok = () => {
      const text = ta.value.trim();
      if (!text) return;
      close();
      on = false;
      document.body.classList.remove("pc-on");
      keep([...notes, { id: Math.random().toString(36).slice(2, 10), at: Date.now(), text, where: { hash: location.hash, selector, element, w: innerWidth, h: innerHeight, theme: theme(), agent: navigator.userAgent.replace("Mozilla/5.0 ", "").slice(0, 110) } }]);
    };
    box.addEventListener("click", (e) => {
      const a = (e.target as Element).closest("[data-a]")?.getAttribute("data-a");
      if (a === "no") close();
      if (a === "ok") ok();
    });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ok(); });
  }
  async function sendAll() {
    if (sending || !notes.length) return;
    sending = true;
    failed = "";
    draw();
    const batch = notes;
    try {
      await send(ledgerAdd, { what: "comments", text: `Комментарии к странице: ${batch.length}`, data: { comments: batch } });
      // пока пачка шла, могли добавить новые: уходят только отправленные
      keep(notes.filter((n) => !batch.includes(n)));
      hideList();
    } catch (e) {
      failed = `Не отправлено: ${(e as Error).message}`;
      showList();
    } finally {
      sending = false;
      draw();
    }
  }
  bar.addEventListener("click", (e) => {
    const b = (e.target as Element).closest("[data-pc]")?.getAttribute("data-pc");
    if (b === "mode") mode(!on);
    if (b === "list") { if (list) hideList(); else showList(); }
    if (b === "send") void sendAll();
  });
  document.addEventListener("keydown", (e) => {
    if (isHotkey(e, hasSelection())) { e.preventDefault(); mode(!on); }
    if (e.key === "Escape" && (on || pop)) { mode(false); pop?.remove(); pop = null; }
  }, true);
  document.addEventListener("pointermove", (e) => {
    if (!on || own(e.target)) return;
    const r = (e.target as Element).getBoundingClientRect();
    Object.assign(hl.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  });
  // в режиме комментирования клик не доходит до страницы: ни нажатие, ни фокус, ни сам клик
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"] as const) {
    document.addEventListener(type, (e) => {
      if (!on || own(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (type === "click") ask(e.target as Element, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
    }, true);
  }
  addEventListener("hashchange", () => setTimeout(draw, 300));
  addEventListener("resize", draw);
  setInterval(() => { if (notes.length) draw(); }, 2000);
  draw();
}
