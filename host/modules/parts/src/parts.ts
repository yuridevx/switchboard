// Модуль parts: сервер MCP parts в каждой сессии — выпуски флота из разговора. Пять инструментов на все части:
// list, upload, deploy, set, log. Зовёт «выпуски», keeper'ов машин и журнал машины; больше ничего. Хранить нечего.
// Ответы не ждут выхода процессов: итог видно в list и журнале флота.
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Host, Module, Result } from "@switchboard/host";
import { packDir, sha256hex, shaLine } from "@switchboard/release";

/** Предел PUT архива и хэша в R2 — как предел скачивания архива части у keeper. */
const PUT_MS = 10 * 60_000;

type Text = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
type PlanEntry = { pin?: string };
type Listed = { parts: Record<string, unknown>; machines: Array<{ machine: string; plan: Record<string, PlanEntry> }>; rev: number };
type KeeperState = { keeper: string; rev: number; os: string; parts: Array<{ part: string; [k: string]: unknown }> };

const text = (t: string, isError = false): Text => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const json = (x: unknown) => text(JSON.stringify(x, null, 2));
const failed = (what: string, r: Result & { ok: false }) => text(`${what}: ${r.error}`, true);

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
        "Загрузить версию приложения из папки на этой машине: упаковать, посчитать хэш и положить архив и хэш по двум ссылкам «выпусков». stable не трогает — новая версия становится edge. Версия загружается один раз. Части сборки (host, keeper, Worker'ы) загружает CI.",
        {
          part: z.string().describe("имя приложения"),
          version: z.string().describe("версия — три числа, например 1.4.0"),
          dir: z.string().describe("папка с app.json в корне; относительная — от рабочей папки сессии"),
        },
        async ({ part, version, dir }) => {
          const root = resolve(cwd, dir);
          if (!existsSync(join(root, "app.json"))) return text(`no_app_json: в ${root} нет app.json`, true);
          const r = await ask("releases.upload", { part, version });
          if (!r.ok) return failed("releases.upload", r);
          const links = r.result as { tgz: string; sha256: string };
          const data = packDir(root);
          const sha256 = sha256hex(data);
          for (const [url, body] of [
            [links.tgz, data],
            [links.sha256, Buffer.from(shaLine(sha256, version))],
          ] as const) {
            // предел PUT — как у keeper на скачивание архива части: 10 мин
            const ac = new AbortController();
            const late = setTimeout(() => ac.abort(), PUT_MS);
            let put: Response;
            try {
              put = await fetch(url, { method: "PUT", body: new Uint8Array(body), signal: ac.signal });
            } catch (e) {
              const why = ac.signal.aborted ? `R2 не ответил за ${PUT_MS / 60_000} мин` : String(e);
              return text(`upload_failed: ${why} на ${new URL(url).pathname}`, true);
            } finally {
              clearTimeout(late);
            }
            if (!put.ok) return text(`upload_failed: R2 ответил ${put.status} на ${new URL(url).pathname}`, true);
          }
          return json({ part, version, bytes: data.length, sha256 });
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
