// Фокус: у каждого хода видно сообщение, сводка шагов и итоговый ответ; шаги — по нажатию. Чистая функция над записями ленты.
// На виду остаётся то, без чего нельзя: вопрос и план, итог хода, ошибки, прерывание, сжатие, смена модели, команды.
import type { AsstItem, Item, Part, Sys, Tool } from "./types.ts";

export type Steps = { id: string; items: Item[]; tools: Record<string, number>; thought: boolean };
export type Row = { id: string; item: Item } | { id: string; steps: Steps };

const SHOWN: Array<Sys["type"]> = ["result", "interrupted", "error", "limits", "refusal", "compact", "reset", "model", "command", "swap", "fallback"];
/** Инструменты-вопросы: их карточка и есть вопрос к человеку. */
const ASKS = ["AskUserQuestion", "ExitPlanMode"];

export function focusRows(items: Item[], tools: Record<string, Tool>): Row[] {
  const rows: Row[] = [];
  let turn: Item[] = [];
  const flush = () => {
    if (turn.length) rows.push(...turnRows(turn, tools));
    turn = [];
  };
  for (const it of items) {
    if (it.kind === "user" || it.kind === "in") {
      flush();
      rows.push({ id: it.id, item: it });
    } else turn.push(it);
  }
  flush();
  return rows;
}

/** Номер записи с последней частью-текстом хода, если текст — последняя часть (иначе итога ещё нет). */
function finalIndex(turn: Item[]): number {
  for (let i = turn.length - 1; i >= 0; i--) {
    const it = turn[i];
    if (it.kind !== "assistant") continue;
    return it.parts.at(-1)?.kind === "text" ? i : -1;
  }
  return -1;
}

function turnRows(turn: Item[], tools: Record<string, Tool>): Row[] {
  const asks = (p: Part) => p.kind === "tool" && ASKS.includes(tools[p.id]?.name ?? "");
  const finalAt = finalIndex(turn);
  const hidden: Item[] = [];
  const shown: Row[] = [];
  const results: Row[] = [];
  let final: Row | null = null;
  turn.forEach((it, i) => {
    if (it.kind === "sys") {
      if (it.sys.type === "result") results.push({ id: it.id, item: it });
      else if (SHOWN.includes(it.sys.type)) shown.push({ id: it.id, item: it });
      else hidden.push(it);
      return;
    }
    if (it.kind !== "assistant") return;
    const parts = [...it.parts];
    if (i === finalAt) final = { id: `${it.id}:final`, item: { ...it, parts: [parts.pop()!] } };
    const keep = parts.filter(asks);
    const rest = parts.filter((p) => !asks(p));
    if (rest.length) hidden.push({ ...it, parts: rest });
    if (keep.length) shown.push({ id: `${it.id}:ask`, item: { ...it, parts: keep } });
  });
  const steps = summarize(hidden, tools);
  return [...(steps ? [{ id: `steps:${turn[0].id}`, steps }] : []), ...shown, ...(final ? [final] : []), ...results];
}

function summarize(hidden: Item[], tools: Record<string, Tool>): Steps | null {
  if (!hidden.length) return null;
  const counts: Record<string, number> = {};
  let thought = false;
  for (const it of hidden) {
    for (const p of (it as AsstItem).parts ?? []) {
      if (p.kind === "think") thought = true;
      if (p.kind !== "tool") continue;
      const name = tools[p.id]?.name;
      if (name) counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return { id: hidden[0].id, items: hidden, tools: counts, thought };
}
