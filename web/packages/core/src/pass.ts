// Пропуск устройства и приглашение: формат и приём у gate.
import { withLimit } from "@switchboard/protocol";
import type { StartOptions } from "./types.ts";

/** Приглашение в адресе страницы: #invite=<номер>.<секрет>; его же принимает поле ввода. */
export const INVITE_RE = /^[a-z0-9]{4}\.[A-Za-z0-9_-]{43}$/;
/** Предел приёма приглашения у gate. */
const REDEEM_MS = 30_000;

/** Номер пропуска для экрана: client.phone.k2a9.<секрет> → client.phone.k2a9. */
export const keyId = (key: string) => key.split(".").slice(0, 3).join(".");
/** Имя клиента во флоте: client.phone.k2a9.<секрет> → phone; пропуска нет — пусто. */
export const clientName = (key: string) => key.split(".")[1] ?? "";
/** Как получить пропуск: приглашение выдаёт агент инструментом keys.invite. */
export const inviteCommand = (name: string) => `keys.invite client ${name} <почта>`;

/** Приём приглашения: POST gate.redeem → пропуск или слово отказа. */
export async function redeem(o: Pick<StartOptions, "fetch" | "workers">, invite: string): Promise<{ key: string } | { error: string }> {
  try {
    const ask = async () => {
      const res = await (o.fetch ?? fetch)(o.workers.gate ?? "", { method: "POST", body: JSON.stringify({ type: "gate.redeem", id: "redeem", v: 1, invite }) });
      return (await res.json()) as { ok: boolean; result?: { key: string }; error?: string };
    };
    const r = await withLimit(ask(), REDEEM_MS, () => ({ ok: false, error: "gate_unavailable" }));
    return r.ok && r.result ? { key: r.result.key } : { error: r.error ?? "bad_invite" };
  } catch {
    return { error: "gate_unavailable" };
  }
}
