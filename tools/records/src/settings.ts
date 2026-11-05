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
  /** правки, ещё не применённые к свежему чтению */
  const waiting: Edit[] = [];
  // очередь одна: чтение посреди записи вернуло бы старое значение
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <R,>(work: () => Promise<R>): Promise<R> => {
    const result = turn.then(work);
    turn = result;
    return result;
  };

  const fetchValues = () => door<{ values: Values }>("prefs.get", { prefix: `${prefix}.`, ...area });

  async function cycle() {
    if (!waiting.length) return;
    const count = waiting.length;
    const answer = await fetchValues();
    const mine = waiting.splice(0, count);
    if (!answer.ok) {
      mine.forEach((e) => e.done(answer.error));
      changed();
      return;
    }
    const next = applied(answer.result.values, mine);
    shown = applied(next, waiting);
    await Promise.all(
      [...new Set(mine.map((e) => e.key))].map(async (key) => {
        const written = await ask("prefs.set", { name: key, value: next[key], ...area });
        for (const e of mine) if (e.key === key) e.done(written.ok ? null : written.error);
      }),
    );
    changed();
  }

  return {
    ready: () => answered,
    get: <T,>(section: string) => shown[keyOf(section)] as T | undefined,
    read: () =>
      inTurn(async () => {
        const answer = await fetchValues();
        if (answer.ok) shown = applied(answer.result.values, waiting);
        answered ||= answer.ok || answer.error !== "disconnected";
        changed();
        return answer.ok ? null : answer.error;
      }),
    edit: <T,>(section: string, fn: (old: T | undefined) => T) =>
      new Promise<string | null>((done) => {
        const edit: Edit = { key: keyOf(section), fn: fn as Edit["fn"], done };
        waiting.push(edit);
        shown = applied(shown, [edit]);
        changed();
        void inTurn(cycle);
      }),
    settled: () => turn.then(() => {}),
  };
}
