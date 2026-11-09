// Построчная разница текста до и после правил — для проверки правила в редакторе.
export type DiffLine = { kind: "same" | "del" | "add"; text: string };

/** Построчная разница: общая часть по наибольшей общей подпоследовательности. Длинный текст сравнивается без середины. */
export function diffLines(a: string, b: string, max = 2500): DiffLine[] {
  const x = a.split(/\r?\n/), y = b.split(/\r?\n/);
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const xa = x.slice(head, x.length - tail), ya = y.slice(head, y.length - tail);
  const mid: DiffLine[] = [];
  if (xa.length * ya.length > max * max) {
    xa.forEach((t) => mid.push({ kind: "del", text: t }));
    ya.forEach((t) => mid.push({ kind: "add", text: t }));
  } else {
    const l = Array.from({ length: xa.length + 1 }, () => new Uint32Array(ya.length + 1));
    for (let i = xa.length - 1; i >= 0; i--) for (let j = ya.length - 1; j >= 0; j--) l[i][j] = xa[i] === ya[j] ? l[i + 1][j + 1] + 1 : Math.max(l[i + 1][j], l[i][j + 1]);
    let i = 0, j = 0;
    while (i < xa.length || j < ya.length) {
      if (i < xa.length && j < ya.length && xa[i] === ya[j]) (mid.push({ kind: "same", text: xa[i] }), i++, j++);
      else if (j < ya.length && (i >= xa.length || l[i][j + 1] >= l[i + 1][j])) mid.push({ kind: "add", text: ya[j++] });
      else mid.push({ kind: "del", text: xa[i++] });
    }
  }
  return [...x.slice(0, head).map((t) => ({ kind: "same" as const, text: t })), ...mid, ...x.slice(x.length - tail).map((t) => ({ kind: "same" as const, text: t }))];
}
