// Опыт 20: Host умирает, пока вопрос AskUserQuestion ждёт ответа. Новый Host подключается к тому же процессу:
// придёт ли вопрос в его canUseTool заново, и дойдёт ли ответ до модели.
import { query } from '@anthropic-ai/claude-agent-sdk';
import net from 'node:net';
import { EventEmitter } from 'node:events';

const mode = process.argv[2];
const t0 = Number(process.argv[3]);
const at = () => ((Date.now() - t0) / 1000).toFixed(1) + 'с';
const log = (...a) => console.log(at(), `[${mode}]`, ...a);

function viaKeeper(opts) {
  const sock = net.connect(38620, '127.0.0.1');
  sock.write(JSON.stringify(mode === 'a'
    ? { op: 'spawn', id: 's20', command: opts.command, args: opts.args, cwd: opts.cwd, env: opts.env }
    : { op: 'attach', id: 's20' }) + '\n');
  const p = new EventEmitter();
  p.stdin = sock; p.stdout = sock; p.killed = false; p.exitCode = null;
  p.kill = () => { p.killed = true; sock.destroy(); return true; };
  sock.on('close', () => { p.exitCode = 0; p.emit('exit', 0, null); });
  sock.on('error', (e) => p.emit('error', e));
  return p;
}
const queue = []; let wake = null;
const push = (text) => { queue.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: text } }); if (wake) { wake(); wake = null; } };
async function* input() { for (;;) { while (queue.length) yield queue.shift(); await new Promise(r => wake = r); } }

let asked = 0;
const q = query({ prompt: input(), options: {
  model: 'claude-haiku-5-5', cwd: process.cwd(),
  permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
  spawnClaudeCodeProcess: viaKeeper,
  canUseTool: (name, inp, o) => {
    if (name !== 'AskUserQuestion') return Promise.resolve({ behavior: 'allow', updatedInput: inp });
    asked++;
    log('canUseTool: AskUserQuestion, toolUseID', String(o.toolUseID).slice(-8), '—', inp.questions[0].question);
    if (mode === 'a') { setTimeout(() => { log('Host умирает, вопрос без ответа'); process.exit(9); }, 1000); return new Promise(() => {}); }
    const qq = inp.questions[0];
    return new Promise(r => setTimeout(() => { log('ответ «' + qq.options[qq.options.length - 1].label + '»');
      r({ behavior: 'allow', updatedInput: { questions: inp.questions, answers: { [qq.question]: qq.options[qq.options.length - 1].label } } }); }, 1000));
  },
} });
(async () => {
  try {
    for await (const e of q) {
      if (e.type === 'system' && e.subtype === 'init') log('init, сессия', e.session_id.slice(0, 8));
      if (e.type === 'assistant') for (const b of e.message.content) if (b.type === 'text') log('ТЕКСТ:', b.text.replace(/\n/g, ' ').slice(0, 120));
      if (e.type === 'result') { log('КОНЕЦ ХОДА; вопросов в canUseTool этого Host:', asked); q.close(); setTimeout(() => process.exit(0), 300); }
    }
  } catch (err) { log('ошибка:', err.message.slice(0, 200)); process.exit(1); }
})();
if (mode === 'b') q.initializationResult().then(r => log('initialize: ждущих разрешений', (r.pending_permission_requests || []).length)).catch(e => log('initializationResult:', e.message));
if (mode === 'a') push('Задай мне вопрос инструментом AskUserQuestion: какой цвет выбрать, два варианта — Красный и Синий. Когда отвечу — напиши одним словом, что я выбрал.');
setTimeout(() => { log('вышло время'); process.exit(2); }, 90000);
