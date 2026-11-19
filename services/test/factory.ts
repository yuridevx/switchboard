// Стенд «Фабрики»: флот с проектом «site», приложением GitHub и репозиторием ролей team/roles — определение проекта читается из него.
import { expect } from "vitest";
import { ok } from "@sb/protocol";
import type { Env } from "../src/env.ts";
import { type Stand, stand } from "./stand.ts";

/** Ключ приложения GitHub в PEM. */
async function pem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
}

/** Секрет подписи событий приложения GitHub флота: его называет GitHub при создании приложения. */
export const WEBHOOK_SECRET = "whsec_test_secret";

/** Что сейчас лежит в factory.json репозитория ролей и на каком коммите: тест меняет поля — следующее применение читает новое. */
export type DefFile = { text: string; sha: string };

/** Флот с проектом «site» (участники — Юра и Аня), приложением GitHub и репозиторием ролей team/roles. */
export async function factoryFleet(file: DefFile, env?: Partial<Env>): Promise<Stand> {
  const s = stand(undefined, env ? { env } : {});
  s.state.fleetAnswer = (f) =>
    f.type === "people.list" ? ok(f.id!, { people: [], projects: [{ id: "site", name: "Сайт", members: ["~yuri@example.com", "~anya@example.com"] }] }) : ok(f.id!, { called: f.type });
  const key = await pem();
  s.state.net = (url) => {
    const path = new URL(url).pathname;
    if (path === "/app-manifests/code123/conversions") return Response.json({ id: 42, slug: "switchboard-test", owner: { login: "team" }, pem: key, webhook_secret: WEBHOOK_SECRET });
    if (path === "/repos/team/roles/installation") return Response.json({ id: 5 });
    if (path === "/app/installations/5/access_tokens") return Response.json({ token: "ghs_token", expires_at: "2027-01-01T00:00:00Z" });
    if (path === "/repos/team/roles/commits/HEAD") return Response.json({ sha: file.sha });
    if (path === "/repos/team/roles/contents/factory.json") return file.text ? Response.json({ content: Buffer.from(file.text).toString("base64"), encoding: "base64" }) : new Response("{}", { status: 404 });
    return new Response(null, { status: 201 });
  };
  expect((await s.ask("github.setup", { code: "code123" })).ok).toBe(true);
  await s.ask("prefs.set", { scope: "fleet", name: "profiles.repos", value: ["team/roles"] });
  return s;
}

/** Флот, у проекта «site» которого применено определение def. */
export async function appliedFleet(def: unknown, env?: Partial<Env>) {
  const file: DefFile = { text: JSON.stringify(def), sha: "c1" };
  const s = await factoryFleet(file, env);
  const r = await s.ask("factory.apply", { project: "site", repo: "team/roles" });
  expect(r).toMatchObject({ ok: true });
  return { s, file, result: r.result as { commit: string; posts: number; lines: number; rules: number; opened: string[]; failed: unknown[] } };
}
