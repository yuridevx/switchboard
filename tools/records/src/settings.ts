// Цикл настроек над Worker'ом prefs — один на страницы и Host: правка читает свежие значения области, применяется поверх них и пишет свои ключи.
// Правки одного цикла идут по одной; копии на диске нет. Запрос к службе передаёт тот, кто зовёт: чтение и запись — двумя входами, у них разный предел.
export type AskResult<T = unknown> = { ok: true; result: T } | { ok: false; error: string; why?: string };
export type Ask = <T = unknown>(name: string, body: Record<string, unknown>) => Promise<AskResult<T>>;

export type Settings = {
  /** первый ответ службы получен; отказ — тоже ответ */
  ready(): boolean;
  /** значение раздела сейчас */
  get<T>(section: string): T | undefined;
  /** правка раздела: сразу в значении, в службе — циклом; промис — null или слово отказа */
  edit<T>(section: string, fn: (old: T | undefined) => T): Promise<string | null>;
  /** прочитать все ключи области; слово отказа или null */
  read(): Promise<string | null>;
  /** дождаться цикла записи: остановка */
  settled(): Promise<void>;
};

type Edit = { name: string; fn: (old: unknown) => unknown; done(word: string | null): void };

export function settings(o: { read: Ask; ask: Ask; prefix: string; scope?: string; changed?: () => void }): Settings {
  const key = (section: string) => `${o.prefix}.${section}`;
  // только свои ключи: чужие разделы области этому циклу не приходят
  const asked = { prefix: `${o.prefix}.`, ...(o.scope ? { scope: o.scope } : {}) };
  const scope = o.scope ? { scope: o.scope } : {};
  const changed = o.changed ?? (() => {});
  let values: Record<string, unknown> = {};
  let answered = false;
  let queue: Edit[] = [];
  let running: Promise<void> | null = null;

  async function read(): Promise<string | null> {
    const r = await o.read<{ values: Record<string, unknown> }>("prefs.get", asked);
    if (r.ok) values = r.result.values;
    // связи нет — ответит следующее открытие; отказ службы — рисуем встроенное
    if (r.ok || r.error !== "disconnected") answered = true;
    changed();
    return r.ok ? null : r.error;
  }

  async function cycle() {
    await Promise.resolve(); // правки подряд — одним циклом
    while (queue.length) {
      const batch = queue;
      queue = [];
      const fresh = await o.read<{ values: Record<string, unknown> }>("prefs.get", asked);
      if (!fresh.ok) {
        for (const e of batch) e.done(fresh.error);
        continue;
      }
      const next = { ...fresh.result.values };
      const names = new Set<string>();
      for (const e of batch) {
        next[e.name] = e.fn(next[e.name]);
        names.add(e.name);
      }
      const words = new Map<string, string>();
      for (const name of names) {
        const w = await o.ask("prefs.set", { name, value: next[name], ...scope });
        if (!w.ok) words.set(name, w.error);
      }
      for (const e of batch) e.done(words.get(e.name) ?? null);
      // правки, пришедшие за время цикла, остаются поверх
      values = next;
      for (const e of queue) values[e.name] = e.fn(values[e.name]);
      changed();
    }
  }

  return {
    ready: () => answered,
    get: <T>(section: string) => values[key(section)] as T | undefined,
    edit: <T>(section: string, fn: (old: T | undefined) => T) =>
      new Promise<string | null>((done) => {
        const name = key(section);
        const f = fn as (old: unknown) => unknown;
        values = { ...values, [name]: f(values[name]) };
        queue.push({ name, fn: f, done });
        running ??= cycle().finally(() => (running = null));
        changed();
      }),
    read,
    settled: async () => {
      while (running) await running;
    },
  };
}
