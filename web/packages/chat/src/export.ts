// Выгрузка переписки в .md: то, что видно в ленте, текстом. Чистая функция.
import type { Row, Tool, View } from "./fold.ts";

function replyText(r: Extract<Row, { k: "reply" }>, tools: Record<string, Tool>) {
  const out: string[] = [];
  for (const p of r.parts) {
    if (p.t === "text") out.push(p.text);
    if (p.t === "tool") out.push(`- \`${tools[p.id]?.name}\` ${JSON.stringify(tools[p.id]?.input ?? {})}`);
  }
  return out.join("\n\n");
}

export function exportMd(callsign: string, view: View): string {
  const out = [`# ${callsign}\n`];
  for (const r of view.rows) {
    if (r.k === "me") out.push(`## Вы\n\n${r.text}\n`);
    else if (r.k === "in") out.push(r.via === "owner" ? `## ${r.from} → вам\n\n${r.text}\n` : `## ${r.from || (r.via === "agent" ? "субагент" : "сессия")} → сессии\n\n${r.text}\n`);
    else if (r.k === "reply") {
      const text = replyText(r, view.tools);
      if (text) out.push(`## Claude\n\n${text}\n`);
    }
  }
  return out.join("\n");
}
