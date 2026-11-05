// Пропуск и приглашение: разбор и приём у gate.
import { withLimit } from "@switchboard/protocol";

const REDEEM_MS = 30_000;
const INVITE = /^[\w-]+\.[\w-]+$/;

/** Номер пропуска без секрета: client.phone.k2a9. */
export const keyId = (key: string): string => key.split(".").slice(0, 3).join(".");
/** Имя клиента из пропуска: client.phone.k2a9… → phone. */
export const nameInKey = (key: string): string => key.split(".")[1] ?? "";
/** Пропуск получен этим приглашением: номер у них один. */
export const fromInvite = (key: string, invite: string): boolean => key.split(".")[2] === numberOf(invite);
/** Номер приглашения без секрета. */
export const numberOf = (invite: string): string => invite.split(".")[0];

/** Приглашение в тексте: <номер>.<секрет> или ссылка с #invite=; иначе null. */
export function inviteIn(text: string): string | null {
  const at = text.indexOf("#invite=");
  const raw = at >= 0 ? text.slice(at + "#invite=".length) : text.trim();
  try {
    const invite = decodeURIComponent(raw);
    return INVITE.test(invite) ? invite : null;
  } catch {
    return null;
  }
}

/** Принять приглашение у gate: пропуск или слово отказа. */
export function redeem(fetcher: typeof fetch, gate: string, invite: string): Promise<{ key: string } | { error: string }> {
  const asked = fetcher(gate, { method: "POST", body: JSON.stringify({ type: "gate.redeem", id: "redeem", v: 1, invite }) })
    .then((r) => r.json() as Promise<{ ok: boolean; result?: { key: string }; error?: string }>)
    .then((r) => (r.ok ? { key: r.result!.key } : { error: r.error ?? "gate_unavailable" }))
    .catch(() => ({ error: "gate_unavailable" }));
  return withLimit(asked, REDEEM_MS, () => ({ error: "gate_unavailable" }));
}
