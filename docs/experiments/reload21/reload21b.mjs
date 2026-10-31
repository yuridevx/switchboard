// Опыт 21: перезагрузка модуля в живом query() — без перезапуска процесса claude.
// Ядро кладёт в query() свои обёртки хуков; сервер MCP меняет setMcpServers. Новая версия модуля — из другой папки со своей копией SDK.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const t0 = Date.now(); let slowStarted = false;
const log = (...a) => { if (String(a[0]).includes('slow начат')) slowStarted = true; console.log(((Date.now() - t0) / 1000).toFixed(1) + 'с', ...a); };

let mod = (await import(pathToFileURL(here + '/rel1/fleet-slow.mjs').href)).default(log);
let part = mod.session();
// обёртки ядра: SDK знает только их; тело — хук нынешней версии модуля
const started = {};
const hooks = {};
for (const [ev, list] of Object.entries(part.hooks)) {
  started[ev] = true;
  hooks[ev] = list.map((m, i) => ({ matcher: m.matcher, hooks: m.hooks.map((_, j) => async (...a) => {
    const h = part.hooks[ev]?.[i]?.hooks[j]; return h ? h(...a) : {};
  }) }));
}
const queue = []; let wake = null;
const say = (text) => { queue.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: text } }); if (wake) { wake(); wake = null; } };
async function* input() { for (;;) { while (queue.length) yield queue.shift(); await new Promise(r => wake = r); } }
const q = query({ prompt: input(), options: {
  model: 'claude-haiku-5-5', cwd: here,
  permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
  mcpServers: part.mcpServers, hooks,
} });
let pid = null;
const turns = [];
const done = () => new Promise(r => turns.push(r));
(async () => {
  for await (const e of q) {
    if (e.type === 'system' && e.subtype === 'init') log('init: session', e.session_id.slice(0, 8), 'инструменты fleet:', e.tools.filter(t => t.includes('fleet')).join(', '));
    if (e.type === 'user' && Array.isArray(e.message.content)) for (const b of e.message.content) if (b.type === 'tool_result') log('tool_result:', JSON.stringify(b.content).slice(0, 200), b.is_error ? 'is_error' : '');
    if (e.type === 'assistant') for (const b of e.message.content) if (b.type === 'text') log('модель:', b.text.replace(/\n/g, ' ').slice(0, 160));
    if (e.type === 'result') { log('result', e.subtype, 'ходов', e.num_turns); turns.shift()?.(); }
  }
})();
const init = await q.initializationResult();
log('initialize: ok');

say('Вызови инструмент slow из сервера fleet и одной строкой скажи, что он вернул или какая была ошибка.');
await new Promise(r => setTimeout(r, 0)); while (!slowStarted) await new Promise(r => setTimeout(r, 100));

// ---- перезагрузка модуля: новая версия из другой папки, процесс claude тот же ----
const tr = Date.now();
mod = (await import(pathToFileURL(here + '/rel2/fleet.mjs').href)).default(log);
const next = mod.session();
const off = await q.setMcpServers({});
  log('setMcpServers({}) →', JSON.stringify(off));
  const res = await q.setMcpServers(next.mcpServers);
part = next;
log('перезагрузка за', Date.now() - tr, 'мс; setMcpServers →', JSON.stringify(res));
for (const ev of Object.keys(next.hooks)) if (!started[ev]) log('хук', ev, '— события нет в initialize этого query(): со следующего старта');
const st = await q.mcpServerStatus();
log('mcpServerStatus fleet:', JSON.stringify(st.filter(s => s.name === 'fleet').map(s => ({ name: s.name, status: s.status, tools: s.tools?.map(t => t.name) }))));

await done();
  for (const e of []) {}
q.close();
setTimeout(() => process.exit(0), 500);
setTimeout(() => { log('вышло время'); process.exit(2); }, 240000).unref();
