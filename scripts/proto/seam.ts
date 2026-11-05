// Шов прототипа для StartOptions.seam ядра. Прод — только чтение:
//   запросы договора дизайна (owns) и кадры к службам-заглушкам (workers) — только мок; молчание мока — ошибка прототипа: тост и консоль;
//   чтения и безвредные записи — в прод; остальные записи — отказ и тост.
// Состояние мока и настройки страницы (prefs.set) живут в памяти страницы.
import type { Frame, Reply } from "@switchboard/protocol";
import type { Roster } from "@switchboard/relay";
import type { Answer, MockCtx, ProtoMock } from "./api.ts";

const reply = (f: Frame, a: Answer): Reply => ({ type: "reply", id: f.id, ...a }) as unknown as Reply;

export type SeamOptions<S> = { mock: ProtoMock<S>; state: S; notice(text: string): void; data: MockCtx["data"] };

export function protoSeam<S>(o: SeamOptions<S>) {
  const harmless = new Set(o.mock.harmless ?? []);
  const owns = new Set(o.mock.owns ?? []);
  const services = new Set(Object.keys(o.mock.workers ?? {}).map((n) => `.${n}`));
  const prefs = new Map<string, unknown>();
  const slot = (f: Frame) => `${String(f.scope ?? "")}|`;
  return {
    async request(f: Frame, read: boolean, real: (f: Frame) => Promise<Reply>): Promise<Reply> {
      const t = String(f.type);
      const a = await o.mock.answer?.(f, { state: o.state, real, data: o.data, notice: o.notice });
      if (a) return reply(f, a);
      if (owns.has(t) || services.has(String(f.to ?? ""))) {
        const why = `мок молчит на ${t}: запрос договора дизайна — ответ должен дать mock.ts`;
        console.error(`прототип: ${why}`, f);
        o.notice(`ошибка прототипа · ${why}`);
        return reply(f, { ok: false, error: "no_mock", why });
      }
      if (t === "prefs.set") {
        prefs.set(`${slot(f)}${String(f.name)}`, f.value);
        return reply(f, { ok: true });
      }
      if (t === "prefs.get") {
        const r = (await real(f)) as unknown as { ok: boolean; result?: { values: Record<string, unknown> } };
        if (!r.ok) return r as unknown as Reply;
        const values = { ...r.result!.values };
        for (const [k, v] of prefs) if (k.startsWith(slot(f))) values[k.slice(slot(f).length)] = v;
        return reply(f, { ok: true, result: { values } });
      }
      if (read || harmless.has(t)) return real(f);
      const { id: _i, v: _v, type: _t, ...rest } = f as Record<string, unknown>;
      o.notice(`прототип: не отправлено · ${t} ${JSON.stringify(rest).slice(0, 220)}`);
      return reply(f, { ok: false, error: "prototype", why: "прототип: запись в прод не отправлена" });
    },
    roster: (r: Roster): Roster => (o.mock.roster ? o.mock.roster(r, o.state) : r),
  };
}
