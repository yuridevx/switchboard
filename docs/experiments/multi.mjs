// Опыт 13: один контроллер — несколько сессий SDK. Режим «разрешено всё».
// У каждой сессии свой ввод и свой fleet_send; доставка — в ввод сессии-адресата (вместо ретранслятора — карта в памяти)
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';

const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1) + 'с';
const sessions = new Map();   // позывной → { push, q }

function startSession(call, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const queue = []; let wake = null;
  const push = (m) => { queue.push(m); if (wake) { wake(); wake = null; } };
  async function* input() { for (;;) { while (queue.length) yield queue.shift(); await new Promise(r => wake = r); } }
  const svyaz = createSdkMcpServer({ name: 'svyaz', version: '0.0.1', tools: [
    tool('fleet_send', 'Отправить сообщение во флот по позывному', { to: z.string(), text: z.string() }, async ({ to, text }) => {
      console.log(at(), `${call} → ${to}:`, text);
      const dst = sessions.get(to);
      if (!dst) return { content: [{ type: 'text', text: `Не доставлено: ${to} нет на связи.` }], isError: true };
      dst.push({ type: 'user', parent_tool_use_id: null, priority: 'next', origin: { kind: 'peer', from: call, name: call },
        message: { role: 'user', content: `<сообщение-флота от="${call}">\n${text}\n</сообщение-флота>` } });
      return { content: [{ type: 'text', text: 'доставлено' }] };
    }),
  ] });
  const q = query({ prompt: input(), options: {
    model: 'claude-haiku-5-5', cwd: dir, mcpServers: { svyaz },
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    systemPrompt: { type: 'preset', preset: 'claude_code',
      append: `Ты на связи во флоте как ${call}. Писать другим — инструментом fleet_send. На связи: ${[...sessions.keys(), call].join(', ')}.` },
  } });
  (async () => { for await (const e of q) {
    if (e.type === 'system' && e.subtype === 'init') console.log(at(), `[${call}] процесс сессии готов, session_id ${e.session_id.slice(0, 8)}`);
    if (e.type === 'assistant') for (const b of e.message.content) if (b.type === 'text') console.log(at(), `[${call}] ТЕКСТ:`, b.text.replace(/\n/g, ' ⏎ ').slice(0, 160));
    if (e.type === 'result') console.log(at(), `[${call}] КОНЕЦ ХОДА`);
  } })();
  sessions.set(call, { push, q });
  return push;
}

const base = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const pushB = startSession('docs@ноут', path.join(base, 'b'));
const pushA = startSession('api@ноут', path.join(base, 'a'));
setTimeout(() => {
  console.log(at(), '>>> человек → api@ноут');
  pushA({ type: 'user', parent_tool_use_id: null, origin: { kind: 'human' }, message: { role: 'user',
    content: 'Спроси docs@ноут через fleet_send, сколько будет 17*3. Когда придёт ответ — напиши его одной строкой.' } });
}, 3000);
setTimeout(() => { for (const s of sessions.values()) s.q.close(); process.exit(0); }, 70000);
