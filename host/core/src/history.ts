// Весь разговор сессии. SDK идёт по цепочке родителей и на границе сжатия обрывается: родитель границы — null. Здесь граница подшита к сообщению до неё
// в копии разговора в памяти; файл claude не меняется.
import type { SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

type Fn = (...a: any[]) => Promise<unknown>;
type Entry = SessionStoreEntry & { parentUuid?: string | null; logicalParentUuid?: string; isSidechain?: boolean; subtype?: string; compactMetadata?: Record<string, unknown> };

/** Границе — родитель: сообщение, которое она называет, иначе предыдущее в главной цепочке. Сведения о сохранённых зацикливают цепочку — их нет. */
function relink(entries: Entry[]): Entry[] {
  const known = new Set(entries.map((e) => e.uuid));
  let last: string | undefined;
  return entries.map((e) => {
    if ((e.type === "user" || e.type === "assistant") && !e.isSidechain) last = e.uuid;
    if (e.subtype !== "compact_boundary") return e;
    const { preservedSegment: _s, preservedMessages: _m, ...compactMetadata } = e.compactMetadata ?? {};
    return { ...e, compactMetadata, parentUuid: known.has(e.logicalParentUuid) ? e.logicalParentUuid : last };
  });
}

/** getSessionMessages по всему разговору. Файла ещё нет — пустой разговор. */
export async function wholeConversation(fn: Record<string, Fn>, id: string, options: Record<string, unknown>): Promise<unknown> {
  const { dir } = options;
  if (!(await fn.getSessionInfo(id, { dir }))) return [];
  const entries: Entry[] = [];
  const copy: SessionStore = {
    append: async (_key, batch) => void entries.push(...batch),
    load: async () => relink(entries),
  };
  await fn.importSessionToStore(id, copy, { dir, includeSubagents: false });
  return fn.getSessionMessages(id, { ...options, sessionStore: copy });
}
