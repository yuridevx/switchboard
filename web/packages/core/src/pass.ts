// Пропуск устройства и приглашение: формат и приём у gate.
import { withLimit } from "@switchboard/protocol";
import type { StartOptions } from "./types.ts";

/** Приглашение: <номер>.<секрет>; в адресе страницы — #invite=…; его же принимает поле ввода. */
export const INVITE = /^[a-z0-9]{4}\.[A-Za-z0-9_-]{43}$/;
const REDEEM_MS = 30_000;

/** Номер пропуска для экрана: client.phone.k2a9.<секрет> → client.phone.k2a9. */
export const keyId = (key: string) => key.split(".").slice(0, 3).join(".");
/** Имя клиента во флоте: client.phone.k2a9.<секрет> → phone; пропуска нет — пусто. */
export const clientName = (key: string) => key.split(".")[1] ?? "";
/** Номер приглашения: виден на экранах, секрет — нет. */
export const inviteNumber = (invite: string) => invite.split(".")[0];
/** Пропуск выпущен из этого приглашения: номер у них один. */
export const passFrom = (key: string, invite: string) => key.split(".")[2] === inviteNumber(invite);
/** Как получить пропуск: приглашение выдаёт агент инструментом keys.invite. */
export const inviteCommand = (name: string) => `keys.invite client ${name} <почта>`;

/** POST gate.redeem: пропуск или слово отказа; секрет пропуска рождается у gate и приходит один раз. */
export async function redeem(o: Pick<StartOptions, "fetch" | "workers">, invite: string): Promise<{ key: string } | { error: string }> {
  const ask = async () => {
    const res = await (o.fetch ?? fetch)(o.workers.gate ?? "", { method: "POST", body: JSON.stringify({ type: "gate.redeem", id: "redeem", v: 1, invite }) });
    return (await res.json()) as { ok: boolean; result?: { key: string }; error?: string };
  };
  try {
    const r = await withLimit(ask(), REDEEM_MS, () => ({ ok: false, error: "gate_unavailable" }));
    return r.ok && r.result ? { key: r.result.key } : { error: r.error ?? "bad_invite" };
  } catch {
    return { error: "gate_unavailable" };
  }
}
