// Вид «фокус» и выгрузка: та же свёртка в другом виде. Ход сжат до сообщения, сводки шагов, того, что требует внимания, итогового текста и строки итога.
import { plural } from "@switchboard/web-ui";
import type { Part, Row, Tool, View } from "./fold.ts";
import { toolLook } from "./tools.ts";

export type Steps = { k: "steps"; key: string; title: string; rows: Row[] };
export type Item = Row | Steps;
/** Эти инструменты на виду и в фокусе: ждут человека. */
const IN_THE_OPEN = new Set(["AskUserQuestion", "ExitPlanMode"]);

function title(hidden: Row[], tools: Record<string, Tool>) {
  const counts = new Map<string, number>();
  let thought = false;
  for (const r of hidden) {
    if (r.k !== "reply") continue;
    for (const p of r.parts) {
      if (p.k === "think") thought = true;
      if (p.k !== "tool") continue;
      const { word } = toolLook(tools[p.id]);
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const names = [...counts].sort((a, b) => b[1] - a[1]).map(([w, n]) => (n > 1 ? `${w} ×${n}` : w));
  return [total ? `${total} ${plural(total, "шаг", "шага", "шагов")}` : "", ...names, thought ? "размышлял" : ""].filter(Boolean).join(" · ") || "служебные строки";
}

function foldTurn(turn: Row[], tools: Record<string, Tool>, out: Item[]) {
  const hidden: Row[] = [];
  const shown: Row[] = [];
  const ends: Row[] = [];
  let final: Row | null = null;
  const lastReply = turn.findLastIndex((r) => r.k === "reply");
  turn.forEach((r, i) => {
    if (r.k === "ban" || r.k === "sum" || r.k === "task" || (r.k === "sys" && r.tone === "wait")) return void shown.push(r);
    if (r.k === "res" || r.k === "end") return void ends.push(r);
    if (r.k !== "reply") return void hidden.push(r);
    let parts: Part[] = r.parts;
    const tail = parts.at(-1);
    if (i === lastReply && tail?.k === "text") {
      final = { k: "reply", key: `${r.key}-final`, parts: [tail] };
      parts = parts.slice(0, -1);
    }
    const open = parts.filter((p) => p.k === "tool" && IN_THE_OPEN.has(String(tools[p.id]?.name)));
    if (open.length) shown.push({ k: "reply", key: `${r.key}-open`, parts: open });
    const rest = parts.filter((p) => !open.includes(p));
    if (rest.length) hidden.push({ ...r, parts: rest });
  });
  if (hidden.length) out.push({ k: "steps", key: `steps-${hidden[0].key}`, title: title(hidden, tools), rows: hidden });
  out.push(...shown, ...(final ? [final] : []), ...ends);
}

export function focused(v: View): Item[] {
  const out: Item[] = [];
  let turn: Row[] = [];
  for (const r of v.rows) {
    if (r.k !== "me" && r.k !== "in") {
      turn.push(r);
      continue;
    }
    foldTurn(turn, v.tools, out);
    turn = [];
    out.push(r);
  }
  foldTurn(turn, v.tools, out);
  return out;
}

/** Переписка в markdown: то, что видно в ленте, текстом. */
export function exportMd(cs: string, v: View): string {
  const out = [`# ${cs}\n`];
  for (const r of v.rows) {
    if (r.k === "me") out.push(`## Вы\n\n${r.text}\n`);
    else if (r.k === "in") out.push(r.via === "owner" ? `## ${r.from} → вам\n\n${r.text}\n` : `## ${r.from || (r.via === "agent" ? "субагент" : "сессия")} → сессии\n\n${r.text}\n`);
    else if (r.k === "reply") {
      const text = r.parts.flatMap((p) => (p.k === "text" ? [p.text] : p.k === "tool" ? [`- \`${v.tools[p.id]?.name}\` ${JSON.stringify(v.tools[p.id]?.input ?? {})}`] : [])).join("\n\n");
      if (text) out.push(`## Claude\n\n${text}\n`);
    }
  }
  return out.join("\n");
}
