// Разница правки по строкам: общие куски сворачиваются, вокруг изменений остаётся несколько строк.

export type DiffLine = { k: "same" | "old" | "new"; text: string } | { k: "fold"; n: number };

const CELLS = 400_000;

/** Строки «было» и «стало» одной лентой. Слишком большая правка — без сравнения: всё старое, затем всё новое. */
export function diffLines(before: string, after: string, ctx = 2): DiffLine[] {
  const a = before.split("\n"), b = after.split("\n");
  let raw: Array<{ k: "same" | "old" | "new"; text: string }>;
  if (a.length * b.length > CELLS) raw = [...a.map((text) => ({ k: "old" as const, text })), ...b.map((text) => ({ k: "new" as const, text }))];
  else {
    // длина общей подпоследовательности от хвоста: lcs[i][j] — для a[i..] и b[j..]
    const w = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    raw = [];
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) (raw.push({ k: "same", text: a[i]! }), i++, j++);
      else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) raw.push({ k: "old", text: a[i++]! });
      else raw.push({ k: "new", text: b[j++]! });
    }
    while (i < a.length) raw.push({ k: "old", text: a[i++]! });
    while (j < b.length) raw.push({ k: "new", text: b[j++]! });
  }
  // общий кусок длиннее двух полей — свёрнут до числа строк
  const out: DiffLine[] = [];
  for (let i = 0; i < raw.length; ) {
    if (raw[i]!.k !== "same") {
      out.push(raw[i++]!);
      continue;
    }
    let end = i;
    while (end < raw.length && raw[end]!.k === "same") end++;
    const run = raw.slice(i, end);
    const head = i === 0 ? 0 : ctx, tail = end === raw.length ? 0 : ctx;
    if (run.length > head + tail + 1) out.push(...run.slice(0, head), { k: "fold", n: run.length - head - tail }, ...run.slice(run.length - tail));
    else out.push(...run);
    i = end;
  }
  return out;
}
