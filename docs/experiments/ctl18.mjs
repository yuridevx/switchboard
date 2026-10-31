// Опыт 18: ввод и вывод процесса claude — именованные каналы (FIFO), держателя нет.
// a — первый контроллер, умирает посреди команды; b — подключается заново, даёт длинную задачу и уходит;
// c — подключается через 30 с: дошёл ли вывод, жив ли процесс.
import fs from 'node:fs';

const mode = process.argv[2];
const t0 = Number(process.argv[3]);
const at = () => ((Date.now() - t0) / 1000).toFixed(1) + 'с';
const log = (...a) => console.log(at(), `[${mode}]`, ...a);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

if (mode === 'b') await wait(5000);
if (mode === 'c') await wait(30000);

const inp = fs.createWriteStream('in.fifo', { flags: 'w' });
const out = fs.createReadStream('out.fifo');
const send = (o) => inp.write(JSON.stringify(o) + '\n');
const tConn = Date.now();
log('подключился к каналам');

let buf = '', bytes = 0, results = 0, firstEvAt = null, textAll = '';
out.on('data', (d) => {
  bytes += d.length; if (firstEvAt === null) firstEvAt = Date.now();
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { log('обрывок строки пропущен,', line.length, 'Б'); continue; }
    onMsg(m);
  }
});

function onMsg(m) {
  if (m.type === 'control_response') log('ответ на', m.response?.request_id, '—', m.response?.subtype);
  if (m.type === 'system' && m.subtype === 'init') log('init, сессия', m.session_id.slice(0, 8));
  if (m.type === 'assistant') for (const b of m.message.content) {
    if (b.type === 'tool_use') { log('ШАГ:', b.name, (b.input.command || '').slice(0, 40));
      if (mode === 'a') setTimeout(() => { log('контроллер умирает посреди команды'); process.exit(9); }, 3000); }
    if (b.type === 'text') { textAll = b.text; log('ТЕКСТ:', b.text.replace(/\n/g, ' ').slice(0, 70), b.text.length > 70 ? `… (${b.text.length} симв.)` : ''); }
  }
  if (m.type === 'user' && Array.isArray(m.message?.content)) for (const b of m.message.content)
    if (b.type === 'tool_result') log('РЕЗУЛЬТАТ команды:', JSON.stringify(b.content).slice(0, 60));
  if (m.type === 'result') {
    results++;
    log('КОНЕЦ ХОДА; получено с подключения', Math.round(bytes / 1024), 'КБ; первый байт через', ((firstEvAt - tConn) / 1000).toFixed(1), 'с после подключения');
    if (mode === 'b' && results === 1) {
      send({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'Какое слово я просил запомнить? Ответь им, а затем выпиши числа от 1 до 3000 через запятую, без пропусков.' } });
      setTimeout(() => { log('контроллер уходит, пока идёт длинный ответ'); process.exit(0); }, 1000);
    }
    if (mode === 'c' && results === 1) {
      log('длинный ответ: начало «' + textAll.slice(0, 30).replace(/\n/g, ' ') + '», конец «' + textAll.slice(-20) + '»');
      send({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'Ответь одним словом: жив' } });
    }
    if (mode === 'c' && results === 2) process.exit(0);
  }
}

send({ type: 'control_request', request_id: 'i-' + mode, request: { subtype: 'initialize' } });
if (mode === 'a') send({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'Запомни слово ДУБ. Затем выполни в Bash: sleep 20; echo готово — и скажи одной строкой, что вывела команда.' } });
setTimeout(() => { log('вышло время'); process.exit(2); }, 120000);
