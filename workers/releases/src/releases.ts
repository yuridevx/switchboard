// Выпуски флота: кадр с to ".releases" → ответ тому, кто спросил. Каталог — архивы в R2 и версии Worker'ов, строка флота — база D1, машины — пропуска у gate.
// План машины уходит её keeper ответом на releases.plan и кадром relay.deliver при перемене.
import { accepts, fail, kindOf, machineOf, ok, type Frame } from "@switchboard/protocol";
import { isBuild, isVersion, shaKey, tgzKey } from "@switchboard/release";
import { CONTRACT, type Fetched, type Upload } from "../contract.ts";
import { Catalog, NAME } from "./catalog.ts";
import { CfFailed } from "./cloudflare.ts";
import { deploy } from "./deploy.ts";
import type { Env } from "./env.ts";
import { readFleet } from "./fleet.ts";
import { list } from "./list.ts";
import { deliver, planOf } from "./plans.ts";
import { log, Refusal } from "./refusal.ts";
import { set } from "./set.ts";

/** Ссылка на чтение архива версии каталога на час; без version — новейшая готовая. Сборки — не каталог. */
async function fetchLink(cat: Catalog, f: Frame): Promise<Fetched> {
  const { part, version } = f;
  if (typeof part !== "string" || !NAME.test(part)) throw new Refusal("bad_frame", "part — имя модуля");
  if (version !== undefined && (typeof version !== "string" || !isVersion(version) || isBuild(version))) throw new Refusal("bad_version", "версия каталога — три числа, без «+»");
  const found = (version as string | undefined) ?? (await cat.all()).get(part)?.versions.at(-1);
  if (!found || !(await cat.sha(part, found))) throw new Refusal("no_release", `у ${part} нет версии ${found ?? "в каталоге"}`);
  return { version: found, url: await cat.link("GET", tgzKey(part, found)) };
}

/**
 * Ссылки на запись версии. Занята, когда лежит её .sha256: с тем же хэшем — same, загружать нечего; с другим — version_exists.
 * Архив без хэша — загрузка оборвалась: ссылки даются снова.
 */
async function uploadLinks(cat: Catalog, f: Frame): Promise<Upload> {
  const { part, version, sha256 } = f;
  if (typeof part !== "string" || !NAME.test(part)) throw new Refusal("bad_frame", "part — имя части");
  if (typeof version !== "string" || !isVersion(version)) throw new Refusal("bad_version", "версия — три числа");
  if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256))) throw new Refusal("bad_frame", "sha256 — хэш архива, 64 знака hex");
  const had = await cat.sha(part, version);
  if (had && had === sha256) return { same: true };
  if (had) throw new Refusal("version_exists", `${part} ${version} уже загружена с другим хэшем — подними номер`);
  return { tgz: await cat.link("PUT", tgzKey(part, version)), sha256: await cat.link("PUT", shaKey(part, version)) };
}

/** Ответ запроса; перемены плана уходят keeper'ам до ответа. */
async function serve(env: Env, f: Frame, from: string): Promise<unknown> {
  const cat = new Catalog(env);
  switch (f.type) {
    case "releases.plan":
      // keeper спрашивает план POST пропуском своей машины
      if (kindOf(from) !== "machine") throw new Refusal("bad_frame", "план спрашивает только машина пропуском машины");
      return planOf(cat, await readFleet(env), machineOf(from)!);
    case "releases.list":
      return list(env, cat, typeof f.part === "string" ? f.part : undefined);
    case "releases.fetch":
      return fetchLink(cat, f);
    case "releases.upload":
      return uploadLinks(cat, f);
    default: {
      const { result, plans } = f.type === "releases.deploy" ? await deploy(env, cat, f, from) : await set(env, cat, f);
      await deliver(env, plans);
      return result;
    }
  }
}

export async function frame(env: Env, f: Frame): Promise<Frame[]> {
  const from = f.from ?? "";
  const refuse = ({ word, why }: { word: string; why: string }): Frame[] => {
    log({ kind: "refuse", ev: f.type, word, why, from });
    return f.id ? [{ ...fail(f.id, word), why, to: from }] : [];
  };
  if (f.type === "reply") {
    log({ kind: "note", ev: "reply", from, why: "releases ответов не ждёт" });
    return [];
  }
  const bad = accepts(f, CONTRACT);
  if (bad) return refuse(bad);
  if (!f.id) return refuse({ word: "bad_frame", why: `${f.type} без id — ответить некому` });
  try {
    return [{ ...ok(f.id, await serve(env, f, from)), to: from }];
  } catch (e) {
    if (e instanceof Refusal) return refuse(e);
    if (e instanceof CfFailed) {
      log({ kind: "refuse", ev: f.type, word: "cf_failed", why: e.message, from, status: e.status, text: e.text });
      return [{ ...fail(f.id, "cf_failed"), why: e.message, to: from }];
    }
    throw e;
  }
}
