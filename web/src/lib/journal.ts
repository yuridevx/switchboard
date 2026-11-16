// Строка журнала машины словами — одна подпись на ленту сессии, вкладку «Журнал» и экраны машины.
import { sayWord } from "./words.ts";

/** У запроса — имя, от кого, время и исход; у остального — событие, сессия и причина. */
export function journalWord(l: { msg: string; [field: string]: unknown }): string {
  const s = (k: string) => (typeof l[k] === "string" || typeof l[k] === "number" ? String(l[k]) : "");
  if (l.msg === "request" && s("type")) {
    const out = l.ok === false ? ` · отказ ${sayWord(s("word"))}${s("why") ? `: ${s("why")}` : ""}` : "";
    return `запрос ${s("type")}${s("from") ? ` от ${s("from")}` : ""}${s("ms") ? ` · ${s("ms")} мс` : ""}${out}`;
  }
  const bits = [s("callsign"), s("type") && l.msg !== "request" ? s("type") : "", s("build") ? `сборка ${s("build")}` : "", s("word"), s("why")].filter(Boolean);
  return bits.length ? `${l.msg} · ${bits.join(" · ")}` : l.msg;
}
