// Вид «фокус»: ход сжат до сообщения, сводки шагов, того, что требует внимания, итогового текста и строки итога. Чистая функция строк.
import { plural } from "@switchboard/web-ui";
import type { Part, Row, Tool } from "./fold.ts";
import { toolLook } from "./tools.ts";

export type Steps = { k: "steps"; id: string; title: string; rows: Row[] };

/** Эти инструменты на виду и в фокусе: ждут человека. */
const OUT_IN_THE_OPEN = new Set(["AskUserQuestion", "ExitPlanMode"]);

function title(hidden: Row[], tools: Record<string, Tool>) {
  const counts = new Map<string, number>();
  let thought = false;
  for (const r of hidden) {
    if (r.k !== "reply") continue;
    for (const p of r.parts) {
      if (p.t === "think") thought = true;
      if (p.t !== "tool") continue;
      const { word } = toolLook(tools[p.id]);
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const names = [...counts].sort((a, b) => b[1] - a[1]).map(([w, n]) => (n > 1 ? `${w} ×${n}` : w));
  const bits = [total ? `${total} ${plural(total, "шаг", "шага", "шагов")}` : "", ...names, thought ? "размышлял" : ""].filter(Boolean);
  return bits.join(" · ") || "служебные строки";
}

function foldTurn(turn: Row[], tools: Record<string, Tool>, out: Array<Row | Steps>) {
  const hidden: Row[] = [];
  const shown: Row[] = [];
  const ends: Row[] = [];
  let final: Row | null = null;
  const lastReply = turn.findLastIndex((r) => r.k === "reply");
  turn.forEach((r, i) => {
    if (r.k === "ban" || r.k === "sum" || r.k === "task" || (r.k === "sys" && r.tone === "wait")) return void shown.push(r);
    if (r.k === "res") return void ends.push(r);
    if (r.k !== "reply") return void hidden.push(r);
    let parts: Part[] = r.parts;
    const tail = parts.at(-1);
    if (i === lastReply && tail?.t === "text") {
      final = { k: "reply", id: `${r.id}-final`, parts: [tail] };
      parts = parts.slice(0, -1);
    }
    const open = parts.filter((p) => p.t === "tool" && OUT_IN_THE_OPEN.has(String(tools[p.id]?.name)));
    if (open.length) shown.push({ k: "reply", id: `${r.id}-open`, parts: open });
    const rest = parts.filter((p) => !open.includes(p));
    if (rest.length) hidden.push({ ...r, parts: rest });
  });
  if (hidden.length) out.push({ k: "steps", id: `steps-${hidden[0].id}`, title: title(hidden, tools), rows: hidden });
  out.push(...shown, ...(final ? [final] : []), ...ends);
}

export function focused(rows: Row[], tools: Record<string, Tool>): Array<Row | Steps> {
  const out: Array<Row | Steps> = [];
  let turn: Row[] = [];
  for (const r of rows) {
    if (r.k !== "me" && r.k !== "in") {
      turn.push(r);
      continue;
    }
    foldTurn(turn, tools, out);
    turn = [];
    out.push(r);
  }
  foldTurn(turn, tools, out);
  return out;
}
