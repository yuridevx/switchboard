// Помощники проверок в браузере: что смотрит сценарий на странице стенда.

export function checker() {
  let failed = 0;
  return {
    check(name, ok, detail) {
      if (!ok) failed++;
      console.log(`${ok ? "✓" : "✗"} ${name}${detail === undefined || detail === "" ? "" : ` · ${detail}`}`);
    },
    bad: () => failed,
  };
}

/** Ошибки страницы; с console — и консоль, кроме шума. Список живой: растёт, пока страница работает. */
export function errorsOf(page, console = false, noise = null) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (console) page.on("console", (m) => { if (m.type() === "error" && !noise?.test(m.text())) errors.push(m.text()); });
  return errors;
}

export function appContext(browser, app, viewport, colorScheme) {
  const phone = app === "phone";
  return browser.newContext({ viewport, colorScheme, deviceScaleFactor: phone ? 2 : 1, hasTouch: phone, isMobile: phone });
}

/** Вылет документа вправо и элементы за правым краем вне разрешённых мест. */
export const overflow = (page, selector, allowed) =>
  page.evaluate(([sel, ok]) => {
    const width = document.documentElement.clientWidth;
    const out = [...document.querySelectorAll(sel)].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.right > width + 1 && !e.closest(ok);
    });
    return { x: document.documentElement.scrollWidth - width, bad: out.map((e) => e.getAttribute("class") ?? e.tagName) };
  }, [selector, allowed]);

/** Дерево DOM приложения строками: разметка, размеры и адрес — вход dom-diff. */
export const treeOf = (page) =>
  page.evaluate(() => {
    const lines = [];
    const walk = (node, depth) => {
      const pad = " ".repeat(depth);
      if (node.nodeType === Node.TEXT_NODE) return void lines.push(`${pad}"${node.data}"`);
      if (node.nodeType !== Node.ELEMENT_NODE || node.matches("script, style")) return;
      const attrs = [...node.attributes].map((a) => ` ${a.name}="${a.value}"`).sort().join("");
      const r = node.getBoundingClientRect();
      const box = r.width || r.height ? `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}` : "нет";
      lines.push(`${pad}<${node.tagName.toLowerCase()}${attrs}> [${box}]`);
      if (node.matches("input, textarea")) lines.push(`${pad} value="${node.value}"`);
      for (const child of node.childNodes) walk(child, depth + 1);
    };
    walk(document.getElementById("app"), 0);
    return `${lines.join("\n")}\nадрес: ${location.hash}`;
  });
