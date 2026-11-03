// Разговор сессии целиком. getSessionMessages SDK идёт по parentUuid, а compact_boundary записан с parentUuid null:
// без этой склейки история кончалась бы на последнем сжатии (опыт на SDK 0.3.311: в файле 39 сообщений, вернулось 9).
// Здесь граница получает родителя — последнее сообщение до неё; остальное делает сам SDK, опцией sessionStore.
// Обход — по PR #1430 claude-agent-acp; когда SDK научится сам, этот файл удаляется.

type Entry = { type?: string; subtype?: string; uuid?: string; isSidechain?: boolean; logicalParentUuid?: unknown; compactMetadata?: unknown };
type Functions = Record<string, (...a: any[]) => Promise<unknown>>;

/**
 * Граница сжатия со ссылкой на сообщение до неё; ссылка в никуда (бывает: запись не попала в файл) — предыдущее по порядку файла.
 * Сведения о сохранённых сжатием сообщениях снимаются: с ними SDK переносит их за сводку и цепочка зацикливается —
 * без них они стоят там, где были сказаны.
 */
export function linkBoundaries(entries: Entry[]): Entry[] {
  const uuids = new Set(entries.map((e) => e.uuid));
  let last: string | undefined;
  return entries.map((e) => {
    if ((e.type === "user" || e.type === "assistant") && !e.isSidechain) last = e.uuid;
    if (e.type !== "system" || e.subtype !== "compact_boundary") return e;
    const { preservedSegment: _s, preservedMessages: _m, ...compactMetadata } = (e.compactMetadata ?? {}) as Record<string, unknown>;
    const parentUuid = typeof e.logicalParentUuid === "string" && uuids.has(e.logicalParentUuid) ? e.logicalParentUuid : last;
    return { ...e, parentUuid: parentUuid ?? null, compactMetadata };
  });
}

/** getSessionMessages по всему разговору: те же опции, тот же вид сообщений. Файла ещё нет — пустой разговор, как у SDK. */
export async function wholeConversation(sdk: Functions, sid: string, options: { dir?: string } & Record<string, unknown>): Promise<unknown> {
  if (!(await sdk.getSessionInfo(sid, { dir: options.dir }))) return [];
  const entries: Entry[] = [];
  const reader = { append: async (_k: unknown, batch: Entry[]) => void entries.push(...batch), load: async () => null };
  await sdk.importSessionToStore(sid, reader, { dir: options.dir, includeSubagents: false });
  const linked = linkBoundaries(entries);
  return sdk.getSessionMessages(sid, { ...options, sessionStore: { append: async () => {}, load: async () => linked } });
}
