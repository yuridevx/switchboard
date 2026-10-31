// Опыт 15: контроллер подключается к процессу claude через держателя. «a» — первый (будет убит), «b» — новый, подключается к живому
import { query } from '@anthropic-ai/claude-agent-sdk';
import net from 'node:net';
import { EventEmitter } from 'node:events';

const mode = process.argv[2];
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1) + 'с';

function viaHolder(opts) {
  const sock = net.connect(38620, '127.0.0.1');
  const req = mode === 'a'
    ? { op: 'spawn', id: 's1', command: opts.command, args: opts.args, cwd: opts.cwd, env: opts.env }
    : { op: 'attach', id: 's1' };
  sock.write(JSON.stringify(req) + '\n');
  const p = new EventEmitter();
  p.stdin = sock; p.stdout = sock; p.killed = false; p.exitCode = null;
  p.kill = () => { p.killed = true; sock.destroy(); return true; };
  sock.on('close', () => { p.exitCode = 0; p.emit('exit', 0, null); });
  sock.on('error', (e) => p.emit('error', e));
  return p;
}

const queue = []; let wake = null;
const push = (text) => { queue.push({ type: 'user', parent_tool_use_id: null, origin: { kind: 'human' }, message: { role: 'user', content: text } }); if (wake) { wake(); wake = null; } };
async function* input() { for (;;) { while (queue.length) yield queue.shift(); await new Promise(r => wake = r); } }

const q = query({ prompt: input(), options: {
  model: 'claude-haiku-5-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
  spawnClaudeCodeProcess: viaHolder,
} });
let results = 0;
(async () => {
  try {
    for await (const e of q) {
      if (e.type === 'system' && e.subtype === 'init') console.log(at(), `[${mode}] init, сессия ${e.session_id.slice(0, 8)}`);
      if (e.type === 'assistant') for (const b of e.message.content) {
        if (b.type === 'text') console.log(at(), `[${mode}] ТЕКСТ:`, b.text.replace(/\n/g, ' ⏎ ').slice(0, 200));
        if (b.type === 'tool_use') { console.log(at(), `[${mode}] ШАГ:`, b.name, (b.input.command || '').slice(0, 40));
          if (mode === 'a') setTimeout(() => { console.log(at(), '[a] контроллер умирает посреди команды'); process.exit(9); }, 6000); }
      }
      if (e.type === 'user' && Array.isArray(e.message?.content)) for (const b of e.message.content)
        if (b.type === 'tool_result') console.log(at(), `[${mode}] РЕЗУЛЬТАТ:`, JSON.stringify(b.content).slice(0, 80));
      if (e.type === 'result') { results++; console.log(at(), `[${mode}] КОНЕЦ ХОДА`);
        if (mode === 'a' && results === 1) push('Выполни в Bash: node long.mjs — и скажи, что вывело.');
        if (mode === 'b' && results === 1) push('Какое секретное слово я просил запомнить? И что вывела node long.mjs? Одной строкой.');
        if (mode === 'b' && results === 2) { q.close(); process.exit(0); } }
    }
  } catch (err) { console.log(at(), `[${mode}] ошибка:`, err.message.slice(0, 200)); process.exit(1); }
})();
if (mode === 'a') push('Запомни секретное слово: ЯСЕНЬ. Ответь одним словом «запомнил».');
setTimeout(() => { console.log(at(), `[${mode}] вышло время`); process.exit(2); }, 90000);
