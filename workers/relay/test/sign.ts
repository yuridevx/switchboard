// Старый ключ подписью для тестов — без workerd: его зовут и тесты в узле.
/** Старый ключ подписью, как его выдавал прежний invite.ts: gate проверяет такие до снятия подписи (вторая половина шага 5). */
export async function sign(secret: string, role: "host" | "client", name: string, kid: string): Promise<string> {
  const id = `${role}.${name}.${kid}`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(id)));
  return `${id}.${btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}
