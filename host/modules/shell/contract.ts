// Контракт модуля Host shell: скрипты bash и PowerShell на любой машине флота. Версия 1.
//   shell.run (запрос) { machine, from, run, shell: bash|pwsh|powershell, script, stdin?, timeout?, background } → снимок;
//     background: false — снимок в конце (ждущий), true — сразу после старта, timeout обязателен (иначе bad_frame).
//   shell.wait (запрос) { machine, run, timeout } → снимок: в момент конца — итог, через timeout — running; 0 — сразу.
//   shell.kill (запрос) { machine, run } → ok: убит или уже кончился.
//   shell.info (запрос) { machine } → { shells: { имя: { version, path } } }.
//   Снимок: { state: running|exit|timeout|killed|stopped, code (у exit), ms, stdout, stderr, files (после конца): [{ name, media_type, data }] }.
//   Слова: no_shell — шелла нет; no_run — запуска нет (не было, прошли сутки, Host перезапускался); bad_frame — не по форме.
//   Итог живёт сутки от конца, но не дольше Host. Конец фонового — запрос message модулю fleet владельца (from).
// Модели каждой сессии — инструменты MCP shell: info, run, wait, kill (mcp__shell__*).
import { make } from "./src/shell.ts";

export default make().module;
