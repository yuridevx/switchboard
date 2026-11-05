// Цикл правки настроек: прочитать свежее, наложить правки, записать тронутые разделы. Запрос к службе передаёт тот, кто зовёт.
type Answer<T> = { ok: true; result: T } | { ok: false; error: string };
type Ask = <T>(name: string, body: Record<string, unknown>) => Promise<Answer<T>>;
type Edit = { name: string; fn: (old: never) => unknown; done(word: string | null): void };

/** read — чтение с пределом метаданных, ask — запись; раздел section лежит в ключе <prefix>.<section>. */
export function settings(o: { read: Ask; ask: Ask; prefix: string; scope?: string; changed?: () => void }) {
  const area = o.scope ? { scope: o.scope } : {};
  const key = (section: string) => `${o.prefix}.${section}`;
  let values: Record<string, unknown> = {};
  let answered = false;
  /** Правки, ещё не наложенные на ответ службы: экран видит их поверх значений. */
  const queue: Edit[] = [];
  let cycle: Promise<void> | undefined;

  const fetch = async () => {
    const r = await o.read<{ values: Record<string, unknown> }>("prefs.get", { prefix: `${o.prefix}.`, ...area });
    // обрыв связи ответом не считается: чтение повторится при возврате связи
    if (r.ok || r.error !== "disconnected") answered = true;
    return r;
  };

  async function run() {
    while (queue.length) {
      const r = await fetch();
      if (r.ok) values = r.result.values;
      const edits = queue.splice(0);
      for (const e of edits) values[e.name] = e.fn(values[e.name] as never);
      if (!r.ok) edits.forEach((e) => e.done(r.error));
      else {
        for (const name of new Set(edits.map((e) => e.name))) {
          const w = await o.ask("prefs.set", { name, value: values[name], ...area });
          for (const e of edits) if (e.name === name) e.done(w.ok ? null : w.error);
        }
      }
      o.changed?.();
    }
  }

  return {
    /** первый ответ службы получен; отказ — тоже ответ */
    ready: () => answered,
    get<T>(section: string): T | undefined {
      const name = key(section);
      return queue.reduce((v, e) => (e.name === name ? e.fn(v as never) : v), values[name]) as T | undefined;
    },
    /** Прочитать свои ключи. Пока идёт цикл, его значения свежее. Ответ — слово отказа или null. */
    async read(): Promise<string | null> {
      const r = await fetch();
      if (r.ok && !cycle) values = r.result.values;
      o.changed?.();
      return r.ok ? null : r.error;
    },
    /** Правка раздела: видна сразу, ответ — слово отказа или null. */
    edit<T>(section: string, fn: (old: T | undefined) => T): Promise<string | null> {
      const answer = new Promise<string | null>((done) => queue.push({ name: key(section), fn: fn as Edit["fn"], done }));
      o.changed?.();
      cycle ??= run().finally(() => (cycle = undefined));
      return answer;
    },
    /** Дождаться цикла записи: остановка не теряет правку. */
    settled: async () => cycle,
  };
}

export type Settings = ReturnType<typeof settings>;
