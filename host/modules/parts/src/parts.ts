// Модуль parts: выпуски флота из разговора. Инструменты сессии ходят к «Выпускам», gate и keeper'ам; хранить нечего.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Host, Module, Result } from "@switchboard/host";
import { download, entries, packModule, upload, type Answer, type Net } from "@switchboard/release";

const HOUR_MS = 3_600_000;
const LOG_LINES = 50;
/** Ответ на чтение: предел host.read. */
const READ_S = 10;

const say = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });
const asJson = (x: unknown) => say(JSON.stringify(x, null, 2));
const refusedText = (type: string, r: Result & { ok: false }) => `${type}: ${r.error}${r.why ? ` — ${String(r.why)}` : ""}`;

const realNet: Net = (url, init) => fetch(url, init as RequestInit);
const inFolder = (cwd: string, dir: string) => (isAbsolute(dir) ? dir : resolve(cwd, dir));

type Keeper = { keeper: string; rev: number; os: string; parts: Array<{ part: string; version: string; state: string; pid?: number }> };
type Catalog = { parts: Record<string, unknown>; machines: Array<{ machine: string; plan: Record<string, { pin?: string }> }> };

export function make() {
  let host!: Host;

  /** Состояние машины от её keeper: закрепления из плана, part — только эта часть. Не ответил — только эта машина с ошибкой. */
  async function machineState(machine: string, plan: Record<string, { pin?: string }>, part?: string) {
    const r = await host.read("keeper.state", { to: `.keeper@${machine}` });
    if (!r.ok) return { machine, error: r.error };
    const state = r.result as Keeper;
    const parts = state.parts.filter((p) => !part || p.part === part).map((p) => (plan[p.part]?.pin ? { ...p, pin: plan[p.part].pin } : p));
    return { machine, ...state, parts };
  }

  async function listAll(part?: string) {
    const passes = await host.read("keys.list", { role: "host" });
    if (!passes.ok) return say(`список машин неизвестен: keys.list — ${passes.error}`, true);
    const names = (passes.result as { passes: Array<{ name: string }> }).passes.map((p) => p.name);
    const catalog = host.read("releases.list", part ? { part } : {});
    const read = await catalog;
    const plans = read.ok ? (read.result as Catalog).machines : [];
    const machines = await Promise.all(names.map((m) => machineState(m, plans.find((x) => x.machine === m)?.plan ?? {}, part)));
    if (read.ok) return asJson({ parts: (read.result as Catalog).parts, machines });
    const error = read.error === "timeout" ? `каталог не ответил за ${READ_S} с` : `каталог отказал (${read.error})`;
    return asJson({ error: `${error}: edge, stable и закрепления неизвестны`, machines });
  }

  const ask = <T>(type: string, body: Record<string, unknown>) => host.request(type, { to: ".releases", ...body }) as Promise<Answer<T>>;

  async function uploadFrom(dir: string) {
    const m = packModule(dir);
    const { same } = await upload(ask, realNet, m);
    return asJson({ part: m.name, version: m.version, ...(same ? { same: true } : { bytes: m.tgz.length, sha256: m.sha }) });
  }

  async function fetchTo(part: string, version: string | undefined, dir: string, stop?: AbortSignal) {
    const got = await download(ask, realNet, part, version, null, stop);
    const target = join(dir, "vendor", part);
    const files = entries(got.tgz).filter((e) => e.data);
    rmSync(target, { recursive: true, force: true });
    for (const f of files) {
      mkdirSync(dirname(join(target, f.path)), { recursive: true });
      writeFileSync(join(target, f.path), f.data!);
    }
    return asJson({ part, version: got.version, dir: target, files: files.map((f) => f.path) });
  }

  /** Отказ упаковки и передачи — словом для модели. */
  const worded = async (work: () => Promise<ReturnType<typeof say>>) => {
    try {
      return await work();
    } catch (e) {
      return say((e as Error).message, true);
    }
  };

  async function forward(type: string, args: Record<string, unknown>) {
    const r = await host.request(type, args);
    return r.ok ? asJson(r.result) : say(refusedText(type, r), true);
  }

  async function journal(machine: string, part: string | undefined, since: string | undefined, limit: number | undefined) {
    const r = await host.read("machine.journal", { machine, ...(part ? { part } : {}), since: since ?? new Date(Date.now() - HOUR_MS).toISOString(), limit: limit ?? LOG_LINES });
    return r.ok ? asJson(r.result) : say(refusedText("machine.journal", r), true);
  }

  const tools = (cwd: string) => [
    tool(
      "list",
      "Части флота и машины одним ответом: у частей — edge (новейшая версия) и stable (выложенная), где живут (machine или cloud); у машин — что реально стоит и работает по ответу их keeper, даже когда Host мёртв. error: timeout у машины значит: она не ответила, остальные верны, повтори вызов. Каталог не ответил — вместо parts стоит error, машины показаны без закреплений. part — только эта часть.",
      { part: z.string().optional().describe("имя части: host, keeper, relay, приложение") },
      ({ part }) => listAll(part),
    ),
    tool(
      "upload",
      "Загрузить модуль из папки в каталог «выпусков»: упаковать по его module.json — имя и номер оттуда (модуль Host и библиотека — файлы пакета; модуль страницы — его module.js и файлы пакета; Worker — имена по флотам из wrangler.jsonc; приложение ОС — dist/ с app.json или папка с app.json), положить архив и хэш по двум ссылкам «выпусков». stable не трогает: модуль выкладывает deploy. Версия загружается один раз: тот же архив второй раз — same, другой — version_exists.",
      { dir: z.string().describe("папка модуля с module.json; относительная — от рабочей папки сессии") },
      ({ dir }) => worded(() => uploadFrom(inFolder(cwd, dir))),
    ),
    tool(
      "fetch",
      "Взять модуль из каталога «выпусков» в папку репо: архив версии (без version — новейшей) распаковывается в <dir>/vendor/<part>/ — у модуля Host, библиотеки и Worker'а папка пакета с module.json, контрактом и стендом для тестов; у модуля страницы ещё module.js — он сам одним файлом. Прежнее содержимое vendor/<part> заменяется.",
      { part: z.string().describe("имя модуля в каталоге, например web-card или host"), version: z.string().optional().describe("версия каталога; без неё — новейшая"), dir: z.string().describe("корень репо; относительный — от рабочей папки сессии") },
      ({ part, version, dir }, extra) => worded(() => fetchTo(part, version, inFolder(cwd, dir), (extra as { signal?: AbortSignal }).signal)),
    ),
    tool(
      "deploy",
      "Выложить версию части: stable показывает на неё. Части машины — «выпуски» шлют новый план keeper'ам машин, у которых он поменялся; машина не на связи возьмёт его при подключении. Worker и веб — выкладка в Cloudflare. Без version — edge. part «*» — вся сборка (приложения не входят). Откат — тот же вызов со старой версией.",
      { part: z.string().describe("имя части или *"), version: z.string().nullable().optional().describe("версия; без неё — edge"), latest: z.literal(true).optional(), without: z.array(z.string()).optional(), check_with: z.array(z.string()).optional() },
      (args) => forward("releases.deploy", { to: ".releases", ...args }),
    ),
    tool(
      "set",
      "Единственная правка плана машины. pin — закрепить версию или снять (null). on — включить или выключить часть: выключенную keeper не поднимает и после перезагрузки; чистый перезапуск — on: false, затем on: true. force с on: false — убить дерево процесса, не дожидаясь выхода. env — окружение части. remove — убрать часть из плана (data/ остаётся). Новая часть — первый set с ней. У keeper — только pin. Уже так — ok.",
      { machine: z.string().describe("имя машины"), part: z.string().describe("имя части машины"), pin: z.string().nullable().optional().describe("версия или null — снять закрепление"), on: z.boolean().optional(), force: z.boolean().optional(), env: z.record(z.string(), z.string()).optional(), remove: z.boolean().optional() },
      (args) => forward("releases.set", { to: ".releases", ...args }),
    ),
    tool(
      "log",
      "Строки журнала машины по части: у host — строки Host, у keeper — строки keeper, у приложения — старты, выходы, вывод и ошибки процесса. Host машины мёртв — причину даёт list (keeper.state).",
      { machine: z.string().describe("имя машины"), part: z.string().optional().describe("имя части"), since: z.string().optional().describe("время ISO; без него — последний час"), limit: z.number().optional().describe("сколько строк, по умолчанию 50") },
      ({ machine, part, since, limit }) => journal(machine, part, since, limit),
    ),
  ];

  const module: Module = {
    start(h) {
      host = h;
    },
    session: (s) => ({ mcpServers: { parts: createSdkMcpServer({ name: "parts", version: "1.0.0", tools: tools(s.info.cwd ?? process.cwd()) }) } }),
  };
  return { module, tools };
}
