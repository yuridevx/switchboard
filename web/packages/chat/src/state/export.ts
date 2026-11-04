// Выгрузка разговора в .md — из того, что в ленте.
import type { View } from "./fold.ts";

export function exportMarkdown(view: View, callsign: string): string {
  const lines = [`# ${callsign}`, ""];
  for (const r of view.rows) {
    if (r.k === "me") lines.push("## Вы", "", r.text, "");
    else if (r.k === "in") lines.push(r.kind === "owner" ? `## ${callsign} → вам` : `## ${r.name ?? "сессия"} → сессии`, "", r.text, "");
    else if (r.k === "reply") {
      for (const p of r.parts) {
        if (p.k === "text") lines.push("## Claude", "", p.text, "");
        if (p.k === "tool") {
          const t = view.tools[p.tool];
          if (t) lines.push(`- \`${t.name}\` ${JSON.stringify(t.input)}`, "");
        }
      }
    }
  }
  return lines.join("\n");
}
