// Цикл настроек над службой prefs: значения области по ключам «префикс.раздел». Правка видна сразу и пишется поверх свежего чтения:
// устройств много, служба хранит ключ целиком, поэтому копия здесь для записи не годится. Предел ждут двери read и ask того, кто зовёт.
type Answer<T> = { ok: true; result: T } | { ok: false; error: string };
type Door = <T>(name: string, body: Record<string, unknown>) => Promise<Answer<T>>;
type Values = Record<string, unknown>;
type Edit = { key: string; fn: (old: never) => unknown; done(word: string | null): void };

export type SettingsOptions = {
  /** чтение значений: у него короткий предел */
  read: Door;
  /** запись */
  ask: Door;
  prefix: string;
  /** нет — область человека */
  scope?: string;
  changed?: () => void;
};

export type Settings = {
  /** служба ответила на чтение; отказ — тоже ответ, обрыв связи — нет */
  ready(): boolean;
  get<T>(section: string): T | undefined;
  /** прочитать заново; отказ — словом */
  read(): Promise<string | null>;
  /** правка раздела; отказ чтения или записи — словом */
  edit<T>(section: string, fn: (old: T | undefined) => T): Promise<string | null>;
  /** всё начатое дошло до службы */
  settled(): Promise<void>;
};

const applied = (values: Values, edits: Edit[]) => edits.reduce<Values>((v, e) => ({ ...v, [e.key]: e.fn(v[e.key] as never) }), values);

export function settings({ read: door, ask, prefix, scope, changed = () => {} }: SettingsOptions): Settings {
  const area = scope ? { scope } : {};
  const keyOf = (section: string) => `${prefix}.${section}`;
  let shown: Values = {};
  let answered = false;
  /** правки, ждущие своего цикла */
  const waiting: Edit[] = [];
  // циклы идут по очереди; чтение в очередь не встаёт: зависший ответ не должен держать новое чтение после обрыва связи
  let turn = Promise.resolve();

  const fetchValues = () => door<{ values: Values }>("prefs.get", { prefix: `${prefix}.`, ...area });

  async function cycle() {
    if (!waiting.length) return;
    const batch = waiting.splice(0);
    const answer = await fetchValues();
    if (!answer.ok) {
      batch.forEach((e) => e.done(answer.error));
    } else {
      const next = applied(answer.result.values, batch);
      for (const key of new Set(batch.map((e) => e.key))) {
        const written = await ask("prefs.set", { name: key, value: next[key], ...area });
        for (const e of batch) if (e.key === key) e.done(written.ok ? null : written.error);
      }
      shown = applied(next, waiting);
    }
    changed();
  }

  return {
    ready: () => answered,
    get: <T,>(section: string) => shown[keyOf(section)] as T | undefined,
    async read() {
      const answer = await fetchValues();
      if (answer.ok) shown = answer.result.values;
      answered ||= answer.ok || answer.error !== "disconnected";
      changed();
      return answer.ok ? null : answer.error;
    },
    edit: <T,>(section: string, fn: (old: T | undefined) => T) =>
      new Promise<string | null>((done) => {
        const edit: Edit = { key: keyOf(section), fn: fn as Edit["fn"], done };
        waiting.push(edit);
        shown = applied(shown, [edit]);
        changed();
        turn = turn.then(cycle);
      }),
    settled: () => turn,
  };
}
