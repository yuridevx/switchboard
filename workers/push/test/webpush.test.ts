import { describe, expect, it } from "vitest";
import { b64u, encrypt, fit, PLAIN_MAX, publicKey, unb64u } from "../src/webpush.ts";

// Пример из RFC 8291, приложение A.
const RFC = {
  plain: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function asPair(): Promise<CryptoKeyPair> {
  const pub = unb64u(RFC.asPublic);
  const jwk = { kty: "EC", crv: "P-256", x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33)), d: RFC.asPrivate };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("raw", pub, { name: "ECDH", namedCurve: "P-256" }, true, []);
  return { privateKey, publicKey };
}

describe("webpush", () => {
  it("encrypt даёт тело из примера RFC 8291 байт в байт", async () => {
    // rs в примере — 4096, как у push
    const body = await encrypt(new TextEncoder().encode(RFC.plain), unb64u(RFC.uaPublic), unb64u(RFC.auth), {
      salt: unb64u(RFC.salt),
      as: await asPair(),
    });
    expect(b64u(body)).toBe(RFC.body);
  });

  it("publicKey — 0x04 ‖ x ‖ y", () => {
    const pub = unb64u(RFC.asPublic);
    expect(publicKey({ kty: "EC", crv: "P-256", x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33)), d: RFC.asPrivate })).toBe(RFC.asPublic);
    expect(() => publicKey({ kty: "RSA" })).toThrow(/JWK P-256/);
  });

  it("fit: короткое — как есть; длинное — body укорочен до предела 3 993 Б и кончается «…»", () => {
    const short = fit({ type: "message", from: "site@laptop", notify: { title: "t", body: "привет" } });
    expect(short?.cut).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(short!.bytes)).notify.body).toBe("привет");
    const long = fit({ type: "message", notify: { title: "t", body: 'а"\\'.repeat(2000) } });
    expect(long?.cut).toBe(true);
    expect(long!.bytes.length).toBeLessThanOrEqual(PLAIN_MAX);
    expect(long!.bytes.length).toBeGreaterThan(PLAIN_MAX - 8);
    expect(JSON.parse(new TextDecoder().decode(long!.bytes)).notify.body.endsWith("…")).toBe(true);
    expect(PLAIN_MAX).toBe(3993);
  });

  it("fit: не влезает и без body — null", () => {
    expect(fit({ type: "message", notify: { title: "x".repeat(5000) } })).toBeNull();
  });
});
