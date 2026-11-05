// Цикл настроек над службой prefs — один на страницы и Host: правка применяется поверх свежих значений и пишет только свои ключи.
// Копии на диске нет. Запрос к службе передаёт тот, кто зовёт: чтение и запись идут двумя входами, у них разный предел.
type AskResult<T = unknown> = { ok: true; result: T } | { ok: false; error: string; why?: string };
type Ask = <T = unknown>(name: string, body: Record<string, unknown>) => Promise<AskResult<T>>;

export type Settings = {
  /** первый ответ службы получен; отказ — тоже ответ */
  ready(): boolean;
  /** значение раздела сейчас */
  get<T>(section: string): T | undefined;
  /** правка раздела: значение меняется сразу, служба — циклом; промис — null или слово отказа */
  edit<T>(section: string, fn: (old: T | undefined) => T): Promise<string | null>;
  /** прочитать свои ключи области; null или слово отказа */
  read(): Promise<string | null>;
  /** дождаться цикла записи: остановка */
  settled(): Promise<void>;
};

type Values = Record<string, unknown>;
type Edit = { name: string; apply(old: unknown): unknown; done(word: string | null): void };

export function settings(o: { read: Ask; ask: Ask; prefix: string; scope?: string; changed?: () => void }): Settings {
  const area = o.scope ? { scope: o.scope } : {};
  const fetchValues = () => o.read<{ values: Values }>("prefs.get", { prefix: `${o.prefix}.`, ...area });
  let values: Values = {};
  let answered = false;
  let waiting: Edit[] = [];
  let writing: Promise<void> | null = null;

  /** Пачка правок: поверх свежего чтения, по одной записи на раздел; правки, пришедшие за это время, остаются поверх. */
  async function write(batch: Edit[]): Promise<void> {
    const fresh = await fetchValues();
    if (!fresh.ok) {
      for (const e of batch) e.done(fresh.error);
      return;
    }
    const next = { ...fresh.result.values };
    for (const e of batch) next[e.name] = e.apply(next[e.name]);
    const refused = new Map<string, string>();
    for (const name of new Set(batch.map((e) => e.name))) {
      const r = await o.ask("prefs.set", { name, value: next[name], ...area });
      if (!r.ok) refused.set(name, r.error);
    }
    for (const e of batch) e.done(refused.get(e.name) ?? null);
    for (const e of waiting) next[e.name] = e.apply(next[e.name]);
    values = next;
    o.changed?.();
  }

  async function drain(): Promise<void> {
    // правки подряд в одном такте — одна пачка
    await Promise.resolve();
    while (waiting.length) {
      const batch = waiting;
      waiting = [];
      await write(batch);
    }
  }

  return {
    ready: () => answered,
    get: <T>(section: string) => values[`${o.prefix}.${section}`] as T | undefined,
    edit: <T>(section: string, fn: (old: T | undefined) => T) =>
      new Promise<string | null>((done) => {
        const name = `${o.prefix}.${section}`;
        const apply = fn as (old: unknown) => unknown;
        values = { ...values, [name]: apply(values[name]) };
        waiting.push({ name, apply, done });
        writing ??= drain().finally(() => (writing = null));
        o.changed?.();
      }),
    async read() {
      const r = await fetchValues();
      if (r.ok) values = r.result.values;
      // связи нет — ответит следующее открытие
      if (r.ok || r.error !== "disconnected") answered = true;
      o.changed?.();
      return r.ok ? null : r.error;
    },
    async settled() {
      while (writing) await writing;
    },
  };
}
