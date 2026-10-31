// Опыт 15: держатель — держит процессы claude и их ввод-вывод, не разбирая протокол.
// Первая строка соединения: { op: "spawn", id, command, args, cwd, env } или { op: "attach", id }; дальше — сырые байты.
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const t0 = Date.now();
const log = (s) => fs.appendFileSync('holder.log', ((Date.now() - t0) / 1000).toFixed(1) + 'с ' + s + '\n');
const sessions = new Map();   // id → { child, buf: [], client }

net.createServer((sock) => {
  let head = Buffer.alloc(0), s = null;
  sock.on('data', (d) => {
    if (s) { s.child.stdin.write(d); return; }
    head = Buffer.concat([head, d]);
    const i = head.indexOf(10);
    if (i < 0) return;
    const req = JSON.parse(head.subarray(0, i).toString());
    const rest = head.subarray(i + 1);
    if (req.op === 'spawn') {
      const child = spawn(req.command, req.args, { cwd: req.cwd, env: req.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      s = { child, buf: [], client: null };
      sessions.set(req.id, s);
      child.stdout.on('data', (b) => { if (s.client) s.client.write(b); else { s.buf.push(b); } });
      child.on('exit', (code) => { log(`claude ${req.id} вышел, код ${code}`); if (s.client) s.client.end(); });
      log(`spawn ${req.id}: pid ${child.pid}`);
    } else {
      s = sessions.get(req.id);
      const n = s.buf.reduce((a, b) => a + b.length, 0);
      log(`attach ${req.id}: отдаю накопленное, ${n} Б`);
      for (const b of s.buf.splice(0)) sock.write(b);
    }
    s.client = sock;
    if (rest.length) s.child.stdin.write(rest);
  });
  // полузакрытие или обрыв от контроллера процесс не трогает
  sock.on('close', () => { if (s && s.client === sock) { s.client = null; log('контроллер отключился — процесс жив, вывод копится'); } });
  sock.on('error', () => {});
}).listen(38620, '127.0.0.1', () => log('держатель слушает 38620'));
