// Опыт 17: всё — через контроллер. С процессом claude говорит только SDK контроллера.
// Чат получает события SDK пачками раз в 100 мс и шлёт команды: say, do, answer, history. Телефон отвечает на вопрос позже — отказ.
import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1) + 'с';
const log = (...a) => console.log(at(), ...a);
const CALL = 'site@ноут';

// ---- контроллер
const queue = []; let wake = null;
const push = (m) => { queue.push(m); if (wake) { wake(); wake = null; } };
async function* input() { for (;;) { while (queue.length) yield queue.shift(); await new Promise(r => wake = r); } }
const asks = new Map(); let reqN = 0, sid = null;
const clients = new Map();                 // имя → функция приёма кадров
const watchers = new Set();
let buf = [], flushT = null, evCount = 0, frames = 0, maxBatch = 0;
const toClients = (f) => { for (const fn of clients.values()) fn(f); };
function emit(e) {
  if (!watchers.size) return;
  evCount++; buf.push(e);
  if (!flushT) flushT = setTimeout(() => {
    const f = { t: 'ev', call: CALL, list: buf }; maxBatch = Math.max(maxBatch, buf.length);
    buf = []; flushT = null; frames++;
    for (const w of watchers) clients.get(w)(f);
  }, 100);
}
const q = query({ prompt: input(), options: {
  model: 'claude-haiku-5-5', cwd: process.cwd(),
  permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, includePartialMessages: true,
  canUseTool: (name, inp) => {
    if (name !== 'AskUserQuestion') return Promise.resolve({ behavior: 'allow', updatedInput: inp });
    const req = 'q-' + (++reqN);
    log('КОНТРОЛЛЕР: вопрос наружу', req);
    return new Promise((resolve) => { asks.set(req, { resolve, inp, done: false }); toClients({ t: 'ask', req, call: CALL, questions: inp.questions }); });
  },
} });
const OPS = ['getContextUsage', 'supportedCommands', 'supportedModels', 'mcpServerStatus', 'interrupt', 'setModel', 'applyFlagSettings', 'rewindFiles', 'stopTask'];
async function api(from, f) {
  switch (f.t) {
    case 'watch': watchers.add(from); return { ok: true };
    case 'unwatch': watchers.delete(from); return { ok: true };
    case 'say': push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: f.text } }); return { ok: true };
    case 'answer': {
      const a = asks.get(f.req);
      if (!a || a.done) return { ok: false, why: 'уже ответили' };
      a.done = true;
      a.resolve({ behavior: 'allow', updatedInput: { questions: a.inp.questions, answers: f.answers } });
      toClients({ t: 'asked', req: f.req, by: from });
      return { ok: true };
    }
    case 'do':
      if (!OPS.includes(f.op)) return { ok: false, why: 'нет такой операции' };
      return { ok: true, result: await q[f.op](...(f.args || [])) };
    case 'history': return { ok: true, result: await getSessionMessages(sid, { dir: process.cwd() }) };
  }
}
let results = 0;
(async () => {
  for await (const e of q) {
    emit(e);
    if (e.type === 'system' && e.subtype === 'init') sid = e.session_id;
    if (e.type === 'result') { results++; log('КОНТРОЛЛЕР: конец хода', results); if (results === 2) finish(); }
  }
})();

// ---- клиенты: чат claude-fleet и телефон
let textSeen = '', partial = 0;
clients.set('чат', (f) => {
  if (f.t === 'ev') for (const e of f.list) {
    if (e.type === 'stream_event') partial++;
    if (e.type === 'assistant') for (const b of e.message.content) if (b.type === 'text') textSeen = b.text;
  }
  if (f.t === 'ask') {
    log('ЧАТ: видит вопрос', f.req, '—', f.questions[0].question);
    setTimeout(async () => { const qq = f.questions[0], pick = qq.options[qq.options.length - 1].label;
      log('ЧАТ: отвечает «' + pick + '» →', JSON.stringify(await api('чат', { t: 'answer', req: f.req, answers: { [qq.question]: pick } }))); }, 1500);
  }
  if (f.t === 'asked') log('ЧАТ: вопрос', f.req, 'снят, ответил', f.by);
});
clients.set('телефон', (f) => {
  if (f.t === 'ask') setTimeout(async () => { const qq = f.questions[0];
    log('ТЕЛЕФОН: отвечает «' + qq.options[0].label + '» →', JSON.stringify(await api('телефон', { t: 'answer', req: f.req, answers: { [qq.question]: qq.options[0].label } }))); }, 3000);
});

(async () => {
  log('ЧАТ: watch →', JSON.stringify(await api('чат', { t: 'watch' })));
  push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'Ответь одним словом: готов' } });
  const cmds = await api('чат', { t: 'do', op: 'supportedCommands' });
  const models = await api('чат', { t: 'do', op: 'supportedModels' });
  const ctx = await api('чат', { t: 'do', op: 'getContextUsage' });
  log('ЧАТ: do supportedCommands —', cmds.result.length, 'команд; supportedModels —', models.result.length, 'моделей; getContextUsage — ключи', Object.keys(ctx.result).slice(0, 6).join(','));
  log('ЧАТ: do close →', JSON.stringify(await api('чат', { t: 'do', op: 'close' })));
  log('ЧАТ: say — вопрос');
  await api('чат', { t: 'say', text: 'Задай мне вопрос инструментом AskUserQuestion: какой цвет выбрать, два варианта — Красный и Синий. Когда отвечу — напиши одним словом, что я выбрал.' });
})();

async function finish() {
  await new Promise(r => setTimeout(r, 200));
  const h = await api('чат', { t: 'history' });
  log('ИТОГ: событий SDK', evCount, '· кадров к чату', frames, '· самая большая пачка', maxBatch, '· частичных событий', partial);
  log('ИТОГ: последний текст в чате:', textSeen.replace(/\n/g, ' ⏎ '));
  log('ИТОГ: history — записей', h.result.length);
  q.close(); setTimeout(() => process.exit(0), 300);
}
setTimeout(() => { log('вышло время'); process.exit(2); }, 120000);
