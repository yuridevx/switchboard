// Опыт 14: переживает ли сессия перезапуск контроллера.
// «a» — первый контроллер: секрет, затем долгая команда, на которой его убивают. «b <session_id>» — второй контроллер с resume.
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';

const [mode, sid] = process.argv.slice(2);
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1) + 'с';
const queue = []; let wake = null;
const push = (text) => { queue.push({ type: 'user', parent_tool_use_id: null, origin: { kind: 'human' }, message: { role: 'user', content: text } }); if (wake) { wake(); wake = null; } };
async function* input() { for (;;) { while (queue.length) yield queue.shift(); await new Promise(r => wake = r); } }

const q = query({ prompt: input(), options: {
  model: 'claude-haiku-5-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
  ...(mode === 'b' ? { resume: sid } : {}),
} });
let turns = 0;
(async () => { for await (const e of q) {
  if (e.type === 'system' && e.subtype === 'init') { console.log(at(), `[${mode}] сессия ${e.session_id}`); fs.writeFileSync('sid.txt', e.session_id); }
  if (e.type === 'assistant') for (const b of e.message.content) {
    if (b.type === 'text') console.log(at(), `[${mode}] ТЕКСТ:`, b.text.replace(/\n/g, ' ⏎ ').slice(0, 220));
    if (b.type === 'tool_use') console.log(at(), `[${mode}] ШАГ:`, b.name, (b.input.command || '').slice(0, 50)); }
  if (e.type === 'result') { console.log(at(), `[${mode}] КОНЕЦ ХОДА`); turns++;
    if (mode === 'a' && turns === 1) push('Теперь выполни в Bash: node long.mjs — и скажи, что вывело.');
    if (mode === 'b') { q.close(); process.exit(0); } }
} })();

if (mode === 'a') push('Запомни секретное слово: КАШТАН. Ответь одним словом «запомнил».');
else push('Какое секретное слово я просил запомнить? И чем кончилась команда node long.mjs — ты видел её вывод? Ответь одной строкой.');
