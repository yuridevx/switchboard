// Общее у браузерных проверок: строка проверки, окно приложения, ошибки страницы, выход за край.
export const pause = (p, ms = 200) => p.waitForTimeout(ms);

/** Счётчик проверок: строка ✓ или ✗ на каждую; bad() — сколько не прошло. */
export function checker() {
  let bad = 0;
  const check = (name, ok, extra = "") => {
    console.log(`${ok ? "✓" : "✗"} ${name}${extra !== "" ? " · " + extra : ""}`);
    if (!ok) bad++;
  };
  return { check, bad: () => bad };
}

/** Дерево DOM приложения в строках: разметка, размеры, значения полей, фокус и адрес. Для tools/demolish dom-diff. */
export const treeOf = (p) =>
  p.evaluate(() => {
    const lines = [];
    const walk = (el, depth) => {
      if (el.tagName === "STYLE" || el.tagName === "SCRIPT") return;
      const attrs = [...el.attributes].map((a) => `${a.name}="${a.value}"`).sort().join(" ");
      const r = el.getBoundingClientRect();
      const size = r.width || r.height ? ` [${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}]` : " [нет]";
      lines.push(`${" ".repeat(depth)}<${el.tagName.toLowerCase()}${attrs ? " " + attrs : ""}>${size}`);
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") lines.push(`${" ".repeat(depth + 1)}value=${JSON.stringify(el.value)}`);
      for (const c of el.childNodes) {
        if (c.nodeType === 3 && c.textContent) lines.push(`${" ".repeat(depth + 1)}"${c.textContent}"`);
        else if (c.nodeType === 1) walk(c, depth + 1);
      }
    };
    walk(document.getElementById("app"), 0);
    lines.push(`адрес: ${location.hash}`);
    return lines.join("\n");
  });

/** Окно приложения: телефон — двойная плотность и касания. */
export const appContext = (b, app, viewport, colorScheme) => b.newContext({ viewport, colorScheme, deviceScaleFactor: app === "phone" ? 2 : 1, hasTouch: app === "phone", isMobile: app === "phone" });

/** Что страница пишет об ошибках: исключения; console — если нужен и он (ignore — что в нём не считается). */
export function errorsOf(p, console_ = false, ignore = null) {
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  if (console_) p.on("console", (m) => m.type() === "error" && !ignore?.test(m.text()) && errs.push(m.text()));
  return errs;
}

/** Выход за правый край: прокрутка страницы и первые элементы внутри scope, кроме тех, кому это можно. */
export const overflow = (p, scope, except, skipFixed) =>
  p.evaluate(
    ([scope, except, skipFixed]) => {
      const de = document.documentElement;
      const bad = [...document.querySelectorAll(scope)]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.right > innerWidth + 1 && !(skipFixed && getComputedStyle(e).position === "fixed") && !e.closest(except);
        })
        .slice(0, 4)
        .map((e) => e.className || e.tagName);
      return { x: de.scrollWidth - de.clientWidth, bad };
    },
    [scope, except, skipFixed],
  );
