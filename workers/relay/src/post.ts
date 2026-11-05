// POST кадра к Worker'у с пропуском; ответ — reply. Не бросает: отказ — словом, причина — в why.
import { READ_MS, fail, type Frame, type Reply } from "@switchboard/protocol";

export type Poster = {
  post(url: string, f: Frame, read?: boolean): Promise<Reply>;
  /** Штатная остановка: ждущие — disconnected, новые — disconnected без POST. */
  stop(): void;
};

const refused = (id: string, error: string, why: string): Reply => Object.assign(fail(id, error), { why });

export function poster(key: string, doFetch: typeof fetch, requestMs: number): Poster {
  const inFlight = new Set<AbortController>();
  let stopped = false;

  /** Ответ не JSON — страница ошибки Cloudflare: статус и начало тела. Кадр без id ответа не ждёт: 204. */
  async function replyOf(res: Response, id: string): Promise<Reply> {
    if (res.status === 204) return { type: "reply", id, ok: true };
    const text = await res.text();
    try {
      return JSON.parse(text) as Reply;
    } catch {
      return refused(id, "offline", `${res.status}: ${text.slice(0, 160)}`);
    }
  }

  return {
    async post(url, f, read = false) {
      const id = f.id ?? "";
      if (stopped) return fail(id, "disconnected");
      const abort = new AbortController();
      inFlight.add(abort);
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        abort.abort();
      }, read ? Math.min(READ_MS, requestMs) : requestMs);
      try {
        return await replyOf(await doFetch(url, { method: "POST", body: JSON.stringify({ ...f, key }), signal: abort.signal }), id);
      } catch (e) {
        return refused(id, late ? "timeout" : abort.signal.aborted ? "disconnected" : "offline", String(e));
      } finally {
        clearTimeout(timer);
        inFlight.delete(abort);
      }
    },
    stop() {
      stopped = true;
      for (const abort of inFlight) abort.abort();
    },
  };
}
