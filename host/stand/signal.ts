// Сигнал стенда: стенд видит всё, что проходит через границу ядра, — кадр в соединение, сообщение SDK, взятое ядром, запись процессу,
// запуск и «убей» держателя, вызов служб и функций SDK. На каждое такое событие ожидания теста перепроверяют свои условия.
// Своего предела у ожидания нет: предел один — предел теста; не дождался — после теста ошибка называет, чего ждали.

type Wait = { what: string; check: () => boolean };
const waits = new Set<Wait>();
let due = false;

/** Событие на границе ядра: условия ожиданий проверяются, когда ядро доделает начатое синхронно и в микрозадачах. */
export function signal(): void {
  if (due) return;
  due = true;
  setImmediate(() => {
    due = false;
    for (const w of [...waits]) if (w.check()) waits.delete(w);
  });
}

/** Дождаться, пока условие станет истинным: проверка — сразу и на каждый сигнал стенда. */
export function until<T>(cond: () => T | undefined | null | false, what = "условие"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const check = (): boolean => {
      try {
        const v = cond();
        if (v) resolve(v);
        return !!v;
      } catch (e) {
        reject(e);
        return true;
      }
    };
    if (!check()) waits.add({ what, check });
  });
}

/** Метки барьера, дошедшие до конца своего пути. */
export const marks = new Set<string>();

/** Конец теста: ожидания, которые не дождались, — сняты; ответ — чего они ждали. */
export function unmet(): string[] {
  const what = [...waits].map((w) => w.what);
  waits.clear();
  return what;
}
