// Селектор элемента для комментария: короткий путь от элемента вверх, пока он однозначен.

/** Шаг селектора: data-атрибуты важнее классов, положение — только среди одинаковых. */
function stepOf(el: Element): string {
  const data = [...el.attributes].filter((a) => a.name.startsWith("data-") && a.value && a.value.length <= 60).slice(0, 2);
  const classes = [...el.classList].slice(0, 3).map((c) => `.${CSS.escape(c)}`);
  const step = CSS.escape(el.localName) + (data.length ? data.map((a) => `[${a.name}="${a.value.replace(/["\\]/g, "\\$&")}"]`).join("") : classes.join(""));
  const siblings = el.parentElement ? [...el.parentElement.children] : [];
  if (siblings.filter((x) => x.matches(step)).length <= 1) return step;
  return `${step}:nth-of-type(${siblings.filter((x) => x.localName === el.localName).indexOf(el) + 1})`;
}

/** Селектор, ведущий ровно к этому элементу. */
export function selectorOf(el: Element): string {
  const steps: string[] = [];
  for (let e: Element | null = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    steps.unshift(stepOf(e));
    const found = document.querySelectorAll(steps.join(" > "));
    if (found.length === 1 && found[0] === el) break;
  }
  return steps.join(" > ");
}
