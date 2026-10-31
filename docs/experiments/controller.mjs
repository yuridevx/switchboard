// Опыт 12: инстанс-контроллер на Agent SDK. Сессия — query() с потоковым вводом;
// сообщения флота — origin peer + priority next; инструменты — в процессе; разрешения — canUseTool
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';

const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1) + 'с';
const CALL = 'exp@ноут';

// очередь ввода: контроллер кладёт сюда и человеческие, и флотские сообщения
const queue = []; let wake = null;
function push(m) { queue.push(m); if (wake) { wake(); wake = null; } }
async function* input() {
  for (;;) { while (queue.length) yield queue.shift(); await new Promise(r => wake = r); }
}
const human = (text) => push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, origin: { kind: 'human' } });
const fleet = (from, text) => push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null,
  priority: 'next', origin: { kind: 'peer', from, name: from } });

const sent = [];
const svyaz = createSdkMcpServer({ name: 'svyaz', version: '0.0.1', tools: [
  tool('fleet_send', 'Отправить сообщение во флот по позывному', { to: z.string(), text: z.string() },
    async ({ to, text }) => { sent.push({ from: CALL, to, text }); console.log(at(), 'ИНСТРУМЕНТ fleet_send:', JSON.stringify({ from: CALL, to, text })); return { content: [{ type: 'text', text: 'доставлено' }] }; }),
] });

const q = query({ prompt: input(), options: {
  model: 'claude-haiku-5-5',
  cwd: process.cwd(),
  mcpServers: { svyaz },
  allowedTools: ['mcp__svyaz__fleet_send', 'Bash(node step.mjs:*)'],
  canUseTool: async (name, input) => {
    console.log(at(), 'ЗАПРОС РАЗРЕШЕНИЯ:', name, JSON.stringify(input).slice(0, 80), '→ телефон думает 3 с');
    await new Promise(r => setTimeout(r, 3000));
    console.log(at(), '«Да» с телефона');
    return { behavior: 'allow', updatedInput: input };
  },
} });

(async () => {
  for await (const e of q) {
    if (e.type === 'assistant') for (const b of e.message.content) {
      if (b.type === 'text') console.log(at(), 'ТЕКСТ:', b.text.replace(/\n/g, ' ⏎ ').slice(0, 200));
      if (b.type === 'tool_use') console.log(at(), 'ШАГ: вызов', b.name, (b.input.command || '').slice(0, 40));
    }
    if (e.type === 'user' && e.origin?.kind === 'peer') console.log(at(), 'ВХОД peer:', JSON.stringify(e.origin).slice(0, 160));
    if (e.type === 'result') console.log(at(), 'КОНЕЦ ХОДА', e.origin ? 'origin=' + JSON.stringify(e.origin).slice(0, 80) : '');
  }
})();

human('Выполни по очереди три команды Bash, каждую отдельным вызовом: node step.mjs 1, затем node step.mjs 2, затем node step.mjs 3. ' +
  'Если по ходу придёт сообщение от другого агента — до следующей команды ответь ему инструментом fleet_send одной фразой и продолжай. ' +
  'В конце выполни ещё: node drop.mjs');
setTimeout(() => { console.log(at(), '>>> флот: сообщение посреди работы'); fleet('телефон', 'Как дела со сборкой?'); }, 6000);
setTimeout(() => { console.log(at(), '>>> флот: сообщение в простаивающую сессию'); fleet('poe-bot@пк', 'Эталоны пройдены. Подтверди одной фразой через fleet_send.'); }, 50000);
setTimeout(() => { q.close(); fs.writeFileSync('sent.json', JSON.stringify(sent, null, 1)); process.exit(0); }, 75000);
