// Фокус: у каждого хода видно сообщение, сводка шагов и итоговый ответ; шаги — по нажатию. На виду остаётся то, без чего нельзя:
// вопрос и план, итог хода, ошибки, прерывание, сжатие, смена модели, команды. Чистая функция над строками свёртки.
import type { Part, Row, View } from "./fold.ts";

export type Steps = { id: string; rows: Row[]; tools: Record<string, number>; thought: boolean };
export type FocusItem = { id: string; row: Row } | { id: string; steps: Steps };

/** Инструменты-вопросы: их карточка и есть вопрос к человеку. */
const ASKS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** Строка хода на виду; итог хода стоит отдельно, последним. */
const onShow = (r: Row) => r.k === "sum" || r.k === "cmd" || r.k === "refusal" || (r.k === "sys" && !r.retry) || (r.k === "ban" && !r.quiet);

export function focusRows(view: View): FocusItem[] {
  const out: FocusItem[] = [];
  let turn: Row[] = [];
  const flush = () => {
    if (turn.length) out.push(...turnRows(turn, view));
    turn = [];
  };
  for (const r of view.rows) {
    if (r.k === "me" || r.k === "in") {
      flush();
      out.push({ id: r.id, row: r });
    } else turn.push(r);
  }
  flush();
  return out;
}

/** Последний ответ хода, если он кончается текстом: иначе итога ещё нет. */
function finalReply(turn: Row[]): Row | undefined {
  const last = turn.findLast((r) => r.k === "reply");
  return last?.k === "reply" && last.parts.at(-1)?.k === "text" ? last : undefined;
}

function turnRows(turn: Row[], view: View): FocusItem[] {
  const asks = (p: Part) => p.k === "tool" && ASKS.has(view.tools[p.tool]?.name ?? "");
  const finalAt = finalReply(turn);
  const hidden: Row[] = [];
  const shown: FocusItem[] = [];
  const results: FocusItem[] = [];
  let final: FocusItem | null = null;
  for (const r of turn) {
    if (r.k === "res" || r.k === "end") results.push({ id: r.id, row: r });
    else if (r.k !== "reply") (onShow(r) ? shown.push({ id: r.id, row: r }) : hidden.push(r));
    else {
      const parts = [...r.parts];
      if (r === finalAt) final = { id: `${r.id}:final`, row: { ...r, parts: [parts.pop()!] } };
      const keep = parts.filter(asks);
      const rest = parts.filter((p) => !asks(p));
      if (rest.length) hidden.push({ ...r, parts: rest });
      if (keep.length) shown.push({ id: `${r.id}:ask`, row: { ...r, parts: keep } });
    }
  }
  const steps = summarize(hidden, view);
  return [...(steps ? [{ id: `steps:${turn[0].id}`, steps }] : []), ...shown, ...(final ? [final] : []), ...results];
}

function summarize(hidden: Row[], view: View): Steps | null {
  if (!hidden.length) return null;
  const tools: Record<string, number> = {};
  let thought = false;
  for (const r of hidden) {
    if (r.k !== "reply") continue;
    for (const p of r.parts) {
      if (p.k === "think") thought = true;
      if (p.k !== "tool") continue;
      const name = view.tools[p.tool]?.name;
      if (name) tools[name] = (tools[name] ?? 0) + 1;
    }
  }
  return { id: hidden[0].id, rows: hidden, tools, thought };
}
