// Модуль fleet, выпуск 2: SDK — своя копия пакета в папке выпуска 2
import { createSdkMcpServer, tool } from './node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
export default (log) => ({
  version: 2,
  session: () => ({
    mcpServers: { fleet: createSdkMcpServer({ name: 'fleet', version: '2', tools: [
      tool('ping', 'Проверка связи флота', {}, async () => { log('fleet v2: ping'); return { content: [{ type: 'text', text: 'ПОНГ-2' }] }; }),
      tool('version', 'Версия модуля fleet', {}, async () => { log('fleet v2: version'); return { content: [{ type: 'text', text: 'fleet 2' }] }; }) ] }) },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [async (inp) => { log('fleet v2: PreToolUse', inp.tool_input?.command); return {}; }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [async () => { log('fleet v2: PostToolUse — НОВОЕ событие вызвано'); return {}; }] }],
    },
  }),
});
