// Фокус и выгрузка: та же свёртка в другом виде. Фокус — по ходу: реплики, шаги свёрнуто, плашки, итоговый ответ, итог хода, служебное свёрнуто.
import type { Part, Row, View } from "./fold.ts";
import { shapeOf, steps } from "./words.ts";

export type Item = { k: "row"; row: Row; only?: Part[] } | { k: "steps"; key: string; head: string; items: Item[] } | { k: "service"; key: string; rows: Row[] };
const SHOWN_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

function turn(rows: Row[], v: View, n: number): Item[] {
  const replies = rows.filter((r): r is Extract<Row, { k: "reply" }> => r.k === "reply");
  const lastReply = replies.at(-1);
  const toolAt = lastReply ? lastReply.parts.map((p) => p.k === "tool" || p.k === "think").lastIndexOf(true) : -1;
  const final = lastReply?.parts.slice(toolAt + 1).filter((p) => p.k === "text" || p.k === "doc") ?? [];
  const stepItems: Item[] = [];
  const shown: Item[] = [];
  const service: Row[] = [];
  let res: Item | null = null;
  const tools: string[] = [];
  let thought = false;
  for (const r of rows) {
    if (r.k === "reply") {
      const parts = r === lastReply ? r.parts.slice(0, toolAt + 1) : r.parts;
      const step: Part[] = [];
      for (const p of parts) {
        if (p.k === "tool" && SHOWN_TOOLS.has(v.tools[p.id]?.name)) shown.push({ k: "row", row: r, only: [p] });
        else {
          if (p.k === "tool") tools.push(shapeOf(v.tools[p.id]?.name ?? "", v.tools[p.id]?.input).word);
          if (p.k === "think") thought = true;
          step.push(p);
        }
      }
      if (step.length) stepItems.push({ k: "row", row: r, only: step });
    } else if (r.k === "ban" || (r.k === "sys" && r.icon === "square")) shown.push({ k: "row", row: r });
    else if (r.k === "res") res = { k: "row", row: r };
    else service.push(r);
  }
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1);
  const words = [...counts].sort((a, b) => b[1] - a[1]).map(([w, c]) => (c > 1 ? `${w} ×${c}` : w));
  const out: Item[] = [];
  stepItems.push(...(stepItems.length ? service.map((row): Item => ({ k: "row", row })) : []));
  if (stepItems.length) out.push({ k: "steps", key: `s${n}`, head: [steps(tools.length), ...words, ...(thought ? ["размышлял"] : [])].join(" · "), items: stepItems });
  out.push(...shown);
  if (final.length && lastReply) out.push({ k: "row", row: lastReply, only: final });
  if (res) out.push(res);
  if (service.length && !stepItems.length) out.push({ k: "service", key: `v${n}`, rows: service });
  return out;
}

export function focusItems(v: View): Item[] {
  const out: Item[] = [];
  let cur: Row[] = [];
  let n = 0;
  const flush = () => {
    out.push(...turn(cur, v, n++));
    cur = [];
  };
  for (const r of v.rows) {
    if (r.k === "me" || r.k === "in") {
      flush();
      out.push({ k: "row", row: r });
    } else cur.push(r);
  }
  flush();
  return out;
}

/** Переписка в markdown: кто → кому, текст; инструменты строкой. */
export function exportMd(cs: string, v: View): string {
  const out = [`# ${cs}\n`];
  for (const r of v.rows) {
    if (r.k === "me") out.push(`## Вы\n\n${r.text}`);
    else if (r.k === "in") out.push(r.from === "owner" ? `## ${cs} → вам\n\n${r.text}` : `## ${r.name || "сессия"} → сессии\n\n${r.text}`);
    else if (r.k === "reply") {
      const body = r.parts.flatMap((p) => (p.k === "text" || p.k === "doc" ? [p.text] : p.k === "tool" && v.tools[p.id] ? [`- \`${v.tools[p.id].name}\` ${JSON.stringify(v.tools[p.id].input)}`] : []));
      if (body.length) out.push(`## Claude\n\n${body.join("\n\n")}`);
    }
  }
  return out.join("\n\n");
}
