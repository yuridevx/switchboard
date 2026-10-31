// Модуль fleet, выпуск 1: SDK — из папки опытов (как у ядра)
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
export default (log) => ({
  version: 1,
  session: () => ({
    mcpServers: { fleet: createSdkMcpServer({ name: 'fleet', version: '1', tools: [
      tool('ping', 'Проверка связи флота', {}, async () => { log('fleet v1: ping'); return { content: [{ type: 'text', text: 'ПОНГ-1' }] }; }) ] }) },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [async (inp) => { log('fleet v1: PreToolUse', inp.tool_input?.command); return {}; }] }] },
  }),
});
