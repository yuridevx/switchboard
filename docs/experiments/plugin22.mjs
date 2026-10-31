// Опыт 22: папка профиля (CLAUDE.md, memory/, skills/) как локальный плагин SDK — скилы профиля в сессии без .claude-plugin
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = join(tmpdir(), 'plugin22', 'ops');
rmSync(join(tmpdir(), 'plugin22'), { recursive: true, force: true });
mkdirSync(join(dir, 'skills', 'owl-word'), { recursive: true });
mkdirSync(join(dir, 'memory'), { recursive: true });
writeFileSync(join(dir, 'CLAUDE.md'), 'Профиль ops.\n');
writeFileSync(join(dir, 'skills', 'owl-word', 'SKILL.md'), '---\nname: owl-word\ndescription: Кодовое слово профиля. Используй, когда спросят кодовое слово.\n---\nКодовое слово: СОВА-22.\n');

const msg = { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'Какое кодовое слово? Используй скил.' } };
const q = query({ prompt: (async function* () { yield msg; })(), options: { model: 'claude-haiku-5-5', cwd: process.cwd(), settingSources: [], plugins: [{ type: 'local', path: dir }], permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true } });
for await (const e of q) {
  if (e.type === 'system' && e.subtype === 'init') console.log(JSON.stringify({ plugins: e.plugins, skills: e.skills, slash: e.slash_commands?.filter((s) => /owl/.test(s)) }));
  if (e.type === 'result') { console.log(JSON.stringify({ result: e.result })); break; }
}
process.exit(0);
