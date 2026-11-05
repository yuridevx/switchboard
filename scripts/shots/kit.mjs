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
