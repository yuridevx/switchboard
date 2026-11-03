// Выгрузка разговора в .md — из того, что в ленте.
import type { Feed } from "./types.ts";

export function exportMarkdown(feed: Feed, callsign: string): string {
  const lines = [`# ${callsign}`, ""];
  for (const it of feed.items) {
    if (it.kind === "user") lines.push(it.from ? `## ${it.from.name ?? "сессия"} → сессии` : "## Вы", "", it.text, "");
    else if (it.kind === "in") lines.push(`## ${callsign} → вам`, "", it.text, "");
    else if (it.kind === "assistant") {
      for (const p of it.parts) {
        if (p.kind === "text") lines.push("## Claude", "", p.text, "");
        if (p.kind === "tool") {
          const t = feed.tools[p.id];
          if (t) lines.push(`- \`${t.name}\` ${JSON.stringify(t.input)}`, "");
        }
      }
    }
  }
  return lines.join("\n");
}
