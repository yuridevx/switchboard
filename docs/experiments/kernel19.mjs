// Опыт 19: ядро Host ничего не знает о функциях — всё вклады модулей.
// Проверяем: слияние вкладов в query(), один владелец на запрос/поле/сервер, изоляцию ошибки модуля,
// цепочку решений по вопросам, SDK-хук модуля в режиме «разрешено всё».
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1) + 'с';
const log = (...a) => console.log(at(), ...a);

// ---------- ядро ----------
function createHost(modules) {
  const owners = new Map();
  const own = (kind, key, mod) => {
    const k = kind + ' ' + key;
    if (owners.has(k)) throw new Error(`${k}: два владельца — ${owners.get(k)} и ${mod}`);
    owners.set(k, mod);
  };
  for (const m of modules) {
    for (const t of Object.keys(m.api || {})) own('запрос', t, m.name);
    for (const f of m.fields || []) own('поле roster', f, m.name);
  }
  const clients = [];                                   // вместо Relay: кадры клиентам
  const emit = (ev) => clients.forEach(c => c(ev));
  const sessions = new Map();
  const safe = (m, what, fn) => { try { return fn(); } catch (e) { log(`ЯДРО: модуль ${m.name} упал в ${what}: ${e.message} — остальные работают`); } };

  function openSession(callsign) {
    const s = { callsign, queue: [], wake: null, data: {} };
    s.push = (text) => { s.queue.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: text } }); if (s.wake) { s.wake(); s.wake = null; } };
    async function* input() { for (;;) { while (s.queue.length) yield s.queue.shift(); await new Promise(r => s.wake = r); } }
    // слияние вкладов модулей в параметры query()
    const opt = { mcpServers: {}, append: [], hooks: {} };
    for (const m of modules) {
      const o = m.options ? safe(m, 'options', () => m.options(s)) : null;
      if (!o) continue;
      for (const [name, srv] of Object.entries(o.mcpServers || {})) { own('MCP-сервер', name + ' ' + callsign, m.name); opt.mcpServers[name] = srv; }
      if (o.append) opt.append.push(o.append);
      for (const [ev, list] of Object.entries(o.hooks || {}))
        (opt.hooks[ev] ||= []).push(...list.map(x => ({ ...x, hooks: x.hooks.map(h => async (...a) => { try { return await h(...a); } catch (e) { log(`ЯДРО: хук модуля ${m.name} упал: ${e.message}`); return {}; } }) })));
    }
    s.q = query({ prompt: input(), options: {
      model: 'claude-haiku-5-5', cwd: process.cwd(),
      permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
      mcpServers: opt.mcpServers, hooks: opt.hooks,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: opt.append.join('\n') },
      // вопросы человеку: первый модуль, вернувший решение, решает
      canUseTool: async (name, inp, o) => {
        for (const m of modules) if (m.decide) {
          try { const d = await m.decide(s, name, inp, o); if (d) return d; }
          catch (e) { log(`ЯДРО: модуль ${m.name} упал в decide: ${e.message} — отказ`); return { behavior: 'deny', message: 'module_error: ' + m.name }; }
        }
        return { behavior: 'allow', updatedInput: inp };
      },
    } });
    sessions.set(callsign, s);
    (async () => {
      for await (const e of s.q) for (const m of modules) if (m.onEvent) safe(m, 'onEvent', () => m.onEvent(s, e));
    })();
    return s;
  }
  const host = {
    emit, sessions, openSession,
    onClient: (fn) => clients.push(fn),
    request: async (req) => {                           // запрос клиента → модуль-владелец
      const m = modules.find(m => m.api && m.api[req.type]);
      if (!m) return { ok: false, error: 'unknown_request' };
      try { return { ok: true, result: await m.api[req.type](host, req) }; } catch (e) { return { ok: false, error: 'module_error: ' + m.name }; }
    },
    roster: () => [...sessions.values()].map(s => Object.assign({ callsign: s.callsign },
      ...modules.flatMap(m => (m.fields || []).map(f => ({ [f]: safe(m, 'field', () => m.field(s, f)) }))))),
  };
  for (const m of modules) if (m.start) m.start(host);
  return host;
}

// ---------- модули ----------
const fleetLite = { name: 'fleet',
  options: (s) => ({ append: `Твой callsign — ${s.callsign}.`,
    mcpServers: { fleet: createSdkMcpServer({ name: 'fleet', version: '0', tools: [
      tool('ping', 'Проверка связи флота', {}, async () => { log('fleet: инструмент ping вызван'); return { content: [{ type: 'text', text: 'ПОНГ-19' }] }; }) ] }) } }) };

const guard = { name: 'guard',
  options: () => ({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [async (inp) => {
    if (!/\brm\b/.test(inp.tool_input?.command || '')) return {};
    log('guard: запрещаю', inp.tool_input.command);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'guard: rm запрещён на этой машине' } };
  }] }] } }) };

const costs = new Map();
const cost = { name: 'cost', fields: ['cost'],
  onEvent: (s, e) => { if (e.type !== 'result') return; const c = costs.get(s.callsign) || { usd: 0, turns: 0 }; c.usd += e.total_cost_usd || 0; c.turns++; costs.set(s.callsign, c); },
  field: (s) => costs.get(s.callsign) || { usd: 0, turns: 0 },
  api: { 'session.cost': (host, req) => costs.get(req.callsign) } };

const pending = new Map(); let qn = 0;
const questions = { name: 'questions',
  decide: (s, name, inp) => {
    if (name !== 'AskUserQuestion') return null;
    const id = 'q-' + (++qn);
    return new Promise((resolve) => { pending.set(id, { resolve, inp }); hostRef.emit({ type: 'question', id, callsign: s.callsign, questions: inp.questions }); });
  },
  api: { answer: (host, req) => { const p = pending.get(req.question); if (!p) throw new Error('already_answered'); pending.delete(req.question);
    p.resolve({ behavior: 'allow', updatedInput: { questions: p.inp.questions, answers: req.answers } }); return 'ok'; } } };

const buggy = { name: 'buggy', onEvent: (s, e) => { if (e.type === 'assistant') throw new Error('ошибка в модуле'); } };
const printer = { name: 'printer', onEvent: (s, e) => { if (e.type === 'assistant') for (const b of e.message.content) if (b.type === 'text') log('printer: ТЕКСТ —', b.text.replace(/\n/g, ' ').slice(0, 200)); } };
const dup = { name: 'dup', api: { 'session.cost': () => 0 } };

// ---------- прогон ----------
try { createHost([cost, dup]); } catch (e) { log('СТАРТ с двумя владельцами:', e.message); }

const hostRef = createHost([fleetLite, guard, cost, questions, buggy, printer]);
hostRef.onClient(async (ev) => {
  if (ev.type !== 'question') return;
  log('клиент: вопрос', ev.id, '—', ev.questions[0].question);
  setTimeout(async () => { const q = ev.questions[0];
    log('клиент: answer «' + q.options[0].label + '» →', JSON.stringify(await hostRef.request({ type: 'answer', question: ev.id, answers: { [q.question]: q.options[0].label } }))); }, 1000);
});
const s = hostRef.openSession('lab@laptop');
s.push('Сделай по порядку: 1) вызови инструмент ping из сервера fleet; 2) выполни в Bash: rm -rf ./nothing-here-19; 3) задай мне вопрос инструментом AskUserQuestion с вариантами Да и Нет. Затем одной строкой: что вернул ping, что случилось с командой rm и что я выбрал.');
const tick = setInterval(async () => {
  const r = hostRef.roster()[0];
  if (r.cost.turns >= 1) {
    clearInterval(tick);
    log('roster:', JSON.stringify(r));
    log('session.cost →', JSON.stringify(await hostRef.request({ type: 'session.cost', callsign: 'lab@laptop' })));
    log('session.nope →', JSON.stringify(await hostRef.request({ type: 'session.nope' })));
    s.q.close(); setTimeout(() => process.exit(0), 300);
  }
}, 500);
setTimeout(() => { log('вышло время'); process.exit(2); }, 150000);
