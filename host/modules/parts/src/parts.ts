// Модуль parts: сервер MCP parts в каждой сессии — выпуски флота из разговора. Шесть инструментов на все части:
// list, upload, fetch, deploy, set, log. Зовёт «выпуски», keeper'ов машин и журнал машины; больше ничего. Хранить нечего.
// Ответы не ждут выхода процессов: итог видно в list и журнале флота.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Host, Module, Result } from "@switchboard/host";
import { entries, packModule, PUT_MS, upload } from "@switchboard/release";
import type { FetchReply, UploadReply } from "@switchboard/release";

type Text = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
type PlanEntry = { pin?: string };
type Listed = { parts: Record<string, unknown>; machines: Array<{ machine: string; plan: Record<string, PlanEntry> }>; rev: number };
type KeeperState = { keeper: string; rev: number; os: string; parts: Array<{ part: string; [k: string]: unknown }> };

const text = (t: string, isError = false): Text => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const json = (x: unknown) => text(JSON.stringify(x, null, 2));
const failed = (what: string, r: Result & { ok: false; why?: string }) => text(`${what}: ${r.error}${r.why ? ` — ${r.why}` : ""}`, true);

export function make() {
  let host: Host;

  const ask = (name: string, payload: Record<string, unknown>) => host.request(name, { ...payload });

  /** Инструменты сервера MCP одной сессии: папка upload — от рабочей папки сессии. */
  function tools(cwd: string): SdkMcpToolDefinition<any>[] {
    return [
      tool(
        "list",
        "Части флота и машины одним ответом: у частей — edge (новейшая версия) и stable (выложенная), где живут (machine или cloud); у машин — что реально стоит и работает по ответу их keeper, даже когда Host мёртв. keeper не ответил — у машины error. part — только эта часть.",
        { part: z.string().optional().describe("имя части: host, keeper, relay, приложение") },
        async ({ part }) => {
          const r = await ask("releases.list", part ? { part } : {});
          if (!r.ok) return failed("releases.list", r);
          const l = r.result as Listed;
          const machines = await Promise.all(
            l.machines.map(async ({ machine, plan }) => {
              const s = await ask("keeper.state", { to: `.keeper@${machine}` });
              if (!s.ok) return { machine, error: s.error };
              const st = s.result as KeeperState;
              const parts = st.parts.filter((p) => !part || p.part === part).map((p) => (plan[p.part]?.pin ? { ...p, pin: plan[p.part].pin } : p));
              return { machine, keeper: st.keeper, rev: st.rev, os: st.os, parts };
            }),
          );
          return json({ parts: l.parts, machines });
        },
      ),
      tool(
        "upload",
        "Загрузить модуль из папки в каталог «выпусков»: упаковать по его module.json — имя и номер оттуда (модуль Host и библиотека — файлы пакета; модуль страницы — его module.js и файлы пакета; Worker — имена по флотам из wrangler.jsonc; приложение ОС — dist/ с app.json или папка с app.json), положить архив и хэш по двум ссылкам «выпусков». stable не трогает: модуль выкладывает deploy. Версия загружается один раз: тот же архив второй раз — same, другой — version_exists.",
        {
          dir: z.string().describe("папка модуля с module.json; относительная — от рабочей папки сессии"),
        },
        async ({ dir }) => {
          let p: ReturnType<typeof packModule>;
          try {
            p = packModule(resolve(cwd, dir));
          } catch (e) {
            return text((e as Error).message, true);
          }
          const { name: part, version, tgz: data } = p;
          try {
            // загрузка по ссылкам «выпусков» — та же функция, что у CI
            const r = await upload(
              async (sha256) => (await ask("releases.upload", { part, version, sha256 })) as UploadReply,
              version,
              data,
              fetch,
              async () => (await ask("releases.fetch", { part, version })) as FetchReply,
            );
            return json({ part, version, bytes: data.length, sha256: r.sha256, ...(r.done === "same" ? { same: true } : {}) });
          } catch (e) {
            return text((e as Error).message, true);
          }
        },
      ),
      tool(
        "fetch",
        "Взять модуль из каталога «выпусков» в папку репо: архив версии (без version — новейшей) распаковывается в <dir>/vendor/<part>/ — у модуля Host, библиотеки и Worker'а папка пакета с module.json, контрактом и стендом для тестов; у модуля страницы ещё module.js — он сам одним файлом. Прежнее содержимое vendor/<part> заменяется.",
        {
          part: z.string().describe("имя модуля в каталоге, например web-card или host"),
          version: z.string().optional().describe("версия каталога; без неё — новейшая"),
          dir: z.string().describe("корень репо; относительный — от рабочей папки сессии"),
        },
        async ({ part, version, dir }, extra) => {
          const r = await ask("releases.fetch", { part, ...(version ? { version } : {}) });
          if (!r.ok) return failed("releases.fetch", r);
          const got = r.result as { version: string; url: string };
          // предел скачивания — как у загрузки; сессия прервала ход — отмена
          const ac = new AbortController();
          let timedOut = false;
          const late = setTimeout(() => ((timedOut = true), ac.abort()), PUT_MS);
          (extra as { signal?: AbortSignal } | undefined)?.signal?.addEventListener("abort", () => ac.abort());
          let tgz: Buffer;
          try {
            const res = await fetch(got.url, { signal: ac.signal });
            if (!res.ok) return text(`fetch_failed: R2 ответил ${res.status} на ${part} ${got.version}`, true);
            tgz = Buffer.from(await res.arrayBuffer());
          } catch (e) {
            return text(`fetch_failed: ${timedOut ? `R2 не ответил за ${PUT_MS / 60_000} мин` : String(e)} на ${part} ${got.version}`, true);
          } finally {
            clearTimeout(late);
          }
          const files = entries(tgz).filter((e) => e.data);
          const target = resolve(cwd, dir, "vendor", part);
          rmSync(target, { recursive: true, force: true });
          for (const e of files) {
            const p = join(target, ...e.path.split("/"));
            mkdirSync(dirname(p), { recursive: true });
            writeFileSync(p, e.data!);
          }
          return json({ part, version: got.version, dir: target, files: files.map((e) => e.path) });
        },
      ),
      tool(
        "deploy",
        "Выложить версию части: stable показывает на неё. Части машины — «выпуски» шлют новый план keeper'ам машин, у которых он поменялся; машина не на связи возьмёт его при подключении. Worker и веб — выкладка в Cloudflare. Без version — edge. part «*» — вся сборка (приложения не входят). Откат — тот же вызов со старой версией.",
        { part: z.string().describe("имя части или *"), version: z.string().optional().describe("версия; без неё — edge") },
        async ({ part, version }) => {
          const r = await ask("releases.deploy", { part, ...(version ? { version } : {}) });
          return r.ok ? json(r.result) : failed("releases.deploy", r);
        },
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
        async (a) => {
          const r = await ask("releases.set", Object.fromEntries(Object.entries(a).filter(([, x]) => x !== undefined)));
          return r.ok ? json(r.result) : failed("releases.set", r);
        },
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
        async ({ machine, part, since, limit }) => {
          const r = await ask("machine.journal", { machine, part, since: since ?? new Date(Date.now() - 3600_000).toISOString(), limit: limit ?? 50 });
          return r.ok ? json(r.result) : failed("machine.journal", r);
        },
      ),
    ];
  }

  const mod: Module = {
    session: (s) => ({ mcpServers: { parts: createSdkMcpServer({ name: "parts", version: "1.0.0", tools: tools(s.info.cwd) }) } }),
    start(h) {
      host = h;
    },
    // хранить нечего
    stop() {},
  };
  return { module: mod, tools };
}
