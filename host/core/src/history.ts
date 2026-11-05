// Весь разговор после сжатий: SDK идёт от конца по parentUuid и у границы сжатия останавливается (parentUuid: null).
// Записи файла идут через хранилище в памяти, граница получает родителя — история не обрывается. Файл на диске не меняется.
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

type Entry = SessionStoreEntry & { uuid?: string; isSidechain?: boolean; subtype?: string; parentUuid?: string | null; logicalParentUuid?: string; compactMetadata?: Record<string, unknown> };
type Functions = Record<string, (...args: any[]) => Promise<unknown>>;

/** Граница ссылается на последнее сообщение до сжатия; ссылка в никуда — на предыдущее сообщение файла. Сведения о сохранённых зациклили бы цепочку. */
function relink(entries: Entry[]): void {
  const known = new Set(entries.map((e) => e.uuid));
  let previous: string | undefined;
  for (const e of entries) {
    if (e.type === "system" && e.subtype === "compact_boundary") {
      e.parentUuid = e.logicalParentUuid && known.has(e.logicalParentUuid) ? e.logicalParentUuid : (previous ?? null);
      if (e.compactMetadata) {
        delete e.compactMetadata.preservedSegment;
        delete e.compactMetadata.preservedMessages;
      }
    }
    if (e.uuid && !e.isSidechain) previous = e.uuid;
  }
}

export async function wholeConversation(sdk: Functions, sessionId: string, options: { dir: string; [k: string]: unknown }): Promise<unknown> {
  if (!(await sdk.getSessionInfo(sessionId, { dir: options.dir }))) return [];
  const entries: Entry[] = [];
  const sessionStore = {
    append: async (key: { subpath?: string }, batch: Entry[]) => void (key.subpath ? 0 : entries.push(...batch)),
    load: async (key?: { subpath?: string }) => (key?.subpath ? null : entries),
  };
  await sdk.importSessionToStore(sessionId, sessionStore, { dir: options.dir });
  relink(entries);
  return sdk.getSessionMessages(sessionId, { ...options, sessionStore });
}
