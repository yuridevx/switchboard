// Опыт 16: сколько памяти стоит контроллер — общий на N сессий или свой у каждой
import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawn, execSync } from 'node:child_process';

const N = Number(process.argv[2] || 1);
const mb = (b) => Math.round(b / 1048576);
const rss0 = process.memoryUsage().rss;
const pids = [];
const viaSpawn = (o) => { const c = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); pids.push(c.pid); return c; };

let done = 0; const qs = [];
for (let i = 0; i < N; i++) {
  const msg = { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'Ответь одним словом: да' } };
  let wake; const hold = new Promise(r => wake = r);
  async function* input() { yield msg; await hold; }
  const q = query({ prompt: input(), options: { model: 'claude-haiku-5-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, spawnClaudeCodeProcess: viaSpawn } });
  qs.push(q);
  (async () => { for await (const e of q) if (e.type === 'result') { if (++done === N) report(); } })();
}
function report() {
  global.gc?.();
  const rss = process.memoryUsage().rss;
  const ws = execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pids.join(',')} | Measure-Object WorkingSet64 -Sum).Sum"`).toString().trim();
  console.log(JSON.stringify({ N, node_до_сессий_МБ: mb(rss0), node_после_МБ: mb(rss), claude_всего_МБ: mb(Number(ws)), claude_на_сессию_МБ: mb(Number(ws) / N) }));
  for (const q of qs) q.close(); setTimeout(() => process.exit(0), 500);
}
setTimeout(() => { console.log('вышло время'); process.exit(2); }, 90000);
