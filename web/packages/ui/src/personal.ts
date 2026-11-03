// Настройки пользователя в модуле страницы: цикл над Worker'ом prefs. Ключи — «префикс.раздел»; значения — в памяти до следующего чтения,
// копии на диске устройства нет. Правка — функция над свежим значением: изменение читает prefs.get, применяет все накопленные правки
// и пишет свои ключи prefs.set. Цикл один на модуль; остановка модуля ждёт его. Модуль объявляет prefs.get и prefs.set в uses.

/** Что цикл настроек берёт у app модуля. */
type AppLike = {
  request<T = unknown>(name: string, body?: Record<string, unknown>): Promise<{ ok: true; result: T } | { ok: false; error: string }>;
  toast(text: string, tone?: "ok" | "bad"): void;
};

type Edit = [string, (old: unknown) => unknown];

export type Personal = {
  /** первый ответ prefs получен: первый рисунок ждёт его; отказ — тоже ответ */
  ready(): boolean;
  /** значение раздела сейчас */
  get<T>(section: string): T | undefined;
  /** правка раздела: на экране сразу, в prefs — циклом; отказ — словом, значения перечитываются */
  edit<T>(section: string, fn: (old: T | undefined) => T): void;
  /** прочитать все ключи: связь открылась */
  read(): Promise<void>;
  /** дождаться цикла записи: остановка модуля */
  settled(): Promise<void>;
};

export function personal(app: AppLike, prefix: string, changed: () => void): Personal {
  const key = (section: string) => `${prefix}.${section}`;
  let values: Record<string, unknown> = {};
  let answered = false;
  let queue: Edit[] = [];
  let running: Promise<void> | null = null;

  async function read() {
    const r = await app.request<{ values: Record<string, unknown> }>("prefs.get", {});
    if (r.ok) values = r.result.values;
    // связи нет — ответит следующее открытие; отказ prefs — рисуем встроенное
    if (r.ok || r.error !== "disconnected") answered = true;
    changed();
  }

  async function cycle() {
    await Promise.resolve(); // правки подряд — одним циклом
    while (queue.length) {
      const batch = queue;
      queue = [];
      const fresh = await app.request<{ values: Record<string, unknown> }>("prefs.get", {});
      if (!fresh.ok) {
        app.toast(`Настройка не сохранилась: ${fresh.error}`, "bad");
        continue;
      }
      const next = { ...fresh.result.values };
      const names = new Set<string>();
      for (const [name, fn] of batch) {
        next[name] = fn(next[name]);
        names.add(name);
      }
      for (const name of names) {
        const w = await app.request("prefs.set", { name, value: next[name] });
        if (!w.ok) app.toast(`Настройка не сохранилась: ${w.error}`, "bad");
      }
      // правки, пришедшие за время цикла, остаются поверх
      values = next;
      for (const [name, fn] of queue) values[name] = fn(values[name]);
      changed();
    }
  }

  return {
    ready: () => answered,
    get: <T>(section: string) => values[key(section)] as T | undefined,
    edit: <T>(section: string, fn: (old: T | undefined) => T) => {
      const name = key(section);
      const f = fn as (old: unknown) => unknown;
      values = { ...values, [name]: f(values[name]) };
      queue.push([name, f]);
      running ??= cycle().finally(() => (running = null));
      changed();
    },
    read,
    settled: async () => {
      while (running) await running;
    },
  };
}
