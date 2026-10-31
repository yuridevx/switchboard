// Опыт 20: прообраз Keeper (holder.mjs) + Host a (умирает с вопросом) + Host b (подключается к тому же процессу)
import { spawn } from 'node:child_process';
const t0 = Date.now();
const keeper = spawn(process.execPath, ['holder.mjs'], { stdio: 'ignore' });
const run = (mode) => new Promise((res) => {
  const c = spawn(process.execPath, ['ctl20.mjs', mode, String(t0)], { stdio: ['ignore', 'inherit', 'inherit'] });
  c.on('exit', (code) => { console.log(`Host ${mode} вышел, код ${code}`); res(); });
});
setTimeout(async () => {
  await run('a');
  await new Promise(r => setTimeout(r, 3000));
  await run('b');
  keeper.kill();
  process.exit(0);
}, 500);
