// Модуль parts: сервер MCP parts в каждой сессии — выпуски флота из разговора. Шесть инструментов на все части. Хранить нечего.
// list отвечает частично: у каталога и каждой машины свой предел чтения, опоздавший не держит остальных.
// Ответы не ждут выхода процессов: итог видно в list и журнале флота.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Host, Module, Result } from "@switchboard/host";
import { download, entries, packModule, upload } from "@switchboard/release";
import type { FetchReply, PackedModule, UploadReply } from "@switchboard/release";

type Listed = { parts: Record<string, unknown>; machines: Array<{ machine: string; plan: Record<string, { pin?: string }> }> };
type KeeperState = { keeper: string; rev: number; os: string; parts: Array<{ part: string; [k: string]: unknown }> };
type Failed = Result & { ok: false; why?: string };

const say = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
const show = (x: unknown) => say(JSON.stringify(x, null, 2));
const refusal = (what: string, r: Failed) => say(`${what}: ${r.error}${r.why ? ` — ${r.why}` : ""}`, true);
/** Ответ запроса как есть; отказ — словом и причиной. */
const answer = (what: string, r: Result) => (r.ok ? show(r.result) : refusal(what, r as Failed));

export function make() {
  let host: Host;

  /** Каталог и машины разом: кто не ответил, тот назван; остальные верны. */
  async function list(part?: string) {
    const who = await host.read("keys.list", { role: "host" });
    if (!who.ok) return say(`список машин неизвестен: keys.list — ${who.error}`, true);
    const names = (who.result as { passes: Array<{ name: string }> }).passes.map((p) => p.name);
    const [listed, ...states] = await Promise.all([host.read("releases.list", part ? { part } : {}), ...names.map((machine) => host.read("keeper.state", { to: `.keeper@${machine}` }))]);
    const catalog = listed.ok ? (listed.result as Listed) : null;
    const machines = names.map((machine, i) => {
      const s = states[i];
      if (!s.ok) return { machine, error: s.error };
      const { keeper, rev, os, parts } = s.result as KeeperState;
      const plan = catalog?.machines.find((m) => m.machine === machine)?.plan ?? {};
      return { machine, keeper, rev, os, parts: parts.filter((p) => !part || p.part === part).map((p) => (plan[p.part]?.pin ? { ...p, pin: plan[p.part].pin } : p)) };
    });
    if (catalog) return show({ parts: catalog.parts, machines });
    const { error } = listed as Failed;
    return show({ error: error === "timeout" ? "каталог не ответил за 10 с: edge, stable и закрепления неизвестны" : `каталог отказал (${error}): edge, stable и закрепления неизвестны`, machines });
  }

  async function uploadFolder(folder: string) {
    let packed: PackedModule;
    try {
      packed = packModule(folder);
    } catch (e) {
      return say((e as Error).message, true);
    }
    const { name: part, version, tgz } = packed;
    try {
      const r = await upload(version, tgz, {
        ask: async (sha256) => (await host.request("releases.upload", { part, version, sha256 })) as UploadReply,
        look: async () => (await host.read("releases.fetch", { part, version })) as FetchReply,
      });
      return show({ part, version, bytes: tgz.length, sha256: r.sha256, ...(r.done === "same" ? { same: true } : {}) });
    } catch (e) {
      return say((e as Error).message, true);
    }
  }

  /** Архив версии — в <root>/vendor/<part>/: прежнее содержимое заменяется, только когда архив скачан. */
  async function vendor(part: string, version: string | undefined, root: string, signal?: AbortSignal) {
    const r = await host.read("releases.fetch", { part, ...(version ? { version } : {}) });
    if (!r.ok) return refusal("releases.fetch", r as Failed);
    const { version: got, url } = r.result as { version: string; url: string };
    let tgz: Buffer;
    try {
      tgz = await download(url, { where: `${part} ${got}`, signal });
    } catch (e) {
      return say((e as Error).message, true);
    }
    const files = entries(tgz).filter((e) => e.data);
    const target = join(root, "vendor", part);
    rmSync(target, { recursive: true, force: true });
    for (const { path, data } of files) {
      const at = join(target, ...path.split("/"));
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, data!);
    }
    return show({ part, version: got, dir: target, files: files.map((e) => e.path) });
  }

  /** Инструменты сервера MCP одной сессии: папки — от её рабочей папки. */
  function tools(cwd: string): SdkMcpToolDefinition<any>[] {
    return [
      tool(
        "list",
        "Части флота и машины одним ответом: у частей — edge (новейшая версия) и stable (выложенная), где живут (machine или cloud); у машин — что реально стоит и работает по ответу их keeper, даже когда Host мёртв. error: timeout у машины значит: она не ответила, остальные верны, повтори вызов. Каталог не ответил — вместо parts стоит error, машины показаны без закреплений. part — только эта часть.",
        { part: z.string().optional().describe("имя части: host, keeper, relay, приложение") },
        ({ part }) => list(part),
      ),
      tool(
        "upload",
        "Загрузить модуль из папки в каталог «выпусков»: упаковать по его module.json — имя и номер оттуда (модуль Host и библиотека — файлы пакета; модуль страницы — его module.js и файлы пакета; Worker — имена по флотам из wrangler.jsonc; приложение ОС — dist/ с app.json или папка с app.json), положить архив и хэш по двум ссылкам «выпусков». stable не трогает: модуль выкладывает deploy. Версия загружается один раз: тот же архив второй раз — same, другой — version_exists.",
        { dir: z.string().describe("папка модуля с module.json; относительная — от рабочей папки сессии") },
        ({ dir }) => uploadFolder(resolve(cwd, dir)),
      ),
      tool(
        "fetch",
        "Взять модуль из каталога «выпусков» в папку репо: архив версии (без version — новейшей) распаковывается в <dir>/vendor/<part>/ — у модуля Host, библиотеки и Worker'а папка пакета с module.json, контрактом и стендом для тестов; у модуля страницы ещё module.js — он сам одним файлом. Прежнее содержимое vendor/<part> заменяется.",
        {
          part: z.string().describe("имя модуля в каталоге, например web-card или host"),
          version: z.string().optional().describe("версия каталога; без неё — новейшая"),
          dir: z.string().describe("корень репо; относительный — от рабочей папки сессии"),
        },
        ({ part, version, dir }, extra) => vendor(part, version, resolve(cwd, dir), (extra as { signal?: AbortSignal } | undefined)?.signal),
      ),
      tool(
        "deploy",
        "Выложить версию части: stable показывает на неё. Части машины — «выпуски» шлют новый план keeper'ам машин, у которых он поменялся; машина не на связи возьмёт его при подключении. Worker и веб — выкладка в Cloudflare. Без version — edge. part «*» — вся сборка (приложения не входят). Откат — тот же вызов со старой версией.",
        { part: z.string().describe("имя части или *"), version: z.string().optional().describe("версия; без неё — edge") },
        async ({ part, version }) => answer("releases.deploy", await host.request("releases.deploy", { part, ...(version ? { version } : {}) })),
      ),
      tool(
        "set",
        "Единственная правка плана машины. pin — закрепить версию или снять (null). on — включить или выключить часть: выключенную keeper не поднимает и после перезагрузки; чистый перезапуск — on: false, затем on: true. force с on: false — убить дерево процесса, не дожидаясь выхода. env — окружение части. remove — убрать часть из плана (data/ остаётся). Новая часть — первый set с ней. У keeper — только pin. Уже так — ok.",
        {
          machine: z.string().describe("имя машины"),
          part: z.string().describe("имя части машины"),
          pin: z.string().nullable().optional().describe("версия или null — снять закрепление"),
          on: z.boolean().optional(),
          force: z.boolean().optional(),
          env: z.record(z.string(), z.string()).optional(),
          remove: z.boolean().optional(),
        },
        async (a) => answer("releases.set", await host.request("releases.set", Object.fromEntries(Object.entries(a).filter(([, x]) => x !== undefined)))),
      ),
      tool(
        "log",
        "Строки журнала машины по части: у host — строки Host, у keeper — строки keeper, у приложения — старты, выходы, вывод и ошибки процесса. Host машины мёртв — причину даёт list (keeper.state).",
        {
          machine: z.string().describe("имя машины"),
          part: z.string().describe("имя части"),
          since: z.string().optional().describe("время ISO; без него — последний час"),
          limit: z.number().int().positive().optional().describe("сколько строк, по умолчанию 50"),
        },
        async ({ machine, part, since, limit }) => answer("machine.journal", await host.read("machine.journal", { machine, part, since: since ?? new Date(Date.now() - 3600_000).toISOString(), limit: limit ?? 50 })),
      ),
    ];
  }

  const module: Module = {
    session: (s) => ({ mcpServers: { parts: createSdkMcpServer({ name: "parts", version: "1.0.0", tools: tools(s.info.cwd) }) } }),
    start(h) {
      host = h;
    },
    stop() {},
  };
  return { module, tools };
}
