// Выпуски флота из разговора: инструменты MCP сессии поверх запросов «Выпусков», gate, keeper'ов и журнала машины.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Host, Module, Result } from "@switchboard/host";
import { download, entries, packModule, refused, upload, type Net } from "@switchboard/release";

const HOUR_MS = 3600_000;
const LOG_LINES = 50;

type State = { parts: Array<{ part: string }> };
type Listed = { parts: unknown; modules?: unknown; machines: Array<{ machine: string; plan: Record<string, { pin?: string }> }> };

const text = (s: string, isError?: true) => ({ content: [{ type: "text" as const, text: s }], ...(isError && { isError }) });
const json = (value: unknown) => text(JSON.stringify(value));
const answer = (type: string, r: Result) => (r.ok ? json(r.result) : text(refused(type, r), true));

/** Ошибка инструмента — текст модели, а не сбой модуля. */
const guarded = <A, E>(fn: (args: A, extra: E) => Promise<ReturnType<typeof text>>) => async (args: A, extra: E) => {
  try {
    return await fn(args, extra);
  } catch (e) {
    return text((e as Error).message, true);
  }
};

export function make() {
  let host: Host;
  const net: Net = { ask: (type, frame) => host.request(type, { v: 1, ...frame }), fetch: (url, init) => fetch(url, init as RequestInit) };

  async function list({ part }: { part?: string }) {
    const keys = await host.read("keys.list", { v: 1, role: "host" });
    if (!keys.ok) return text(`список машин неизвестен: keys.list — ${keys.error}`, true);
    const names = (keys.result as { passes: Array<{ name: string }> }).passes.map((p) => p.name);
    const [catalog, ...states] = await Promise.all([host.read("releases.list", { v: 1, ...(part && { part }) }), ...names.map((m) => host.read("keeper.state", { v: 1, to: `.keeper@${m}` }))]);
    const listed = catalog.ok ? (catalog.result as Listed) : null;
    const machines = names.map((machine, i) => {
      const r = states[i];
      if (!r.ok) return { machine, error: r.error };
      const state = r.result as State;
      const plan = listed?.machines.find((m) => m.machine === machine)?.plan;
      const parts = state.parts.filter((p) => !part || p.part === part).map((p) => (plan?.[p.part]?.pin ? { ...p, pin: plan[p.part].pin } : p));
      return { machine, ...state, parts };
    });
    if (listed) return json({ parts: listed.parts, modules: listed.modules, machines });
    const why = !catalog.ok && catalog.error === "timeout" ? "каталог не ответил за 10 с" : `каталог отказал (${(catalog as { error: string }).error})`;
    return json({ error: `${why}: edge, stable и закрепления неизвестны`, machines });
  }

  async function take({ part, version, dir }: { part: string; version?: string; dir: string }, cwd: string, signal?: AbortSignal) {
    const got = await net.ask("releases.fetch", { part, ...(version && { version }) });
    if (!got.ok) return text(refused("releases.fetch", got), true);
    const found = got.result as { version: string; url: string };
    const tgz = await download(net, found.url, (why) => `fetch_failed: ${why} на ${part} ${found.version}`, signal);
    const target = join(resolve(cwd, dir), "vendor", part);
    rmSync(target, { recursive: true, force: true });
    const files = entries(tgz).filter((e) => e.data);
    for (const f of files) {
      mkdirSync(dirname(join(target, f.path)), { recursive: true });
      writeFileSync(join(target, f.path), f.data!);
    }
    return json({ part, version: found.version, dir: target, files: files.map((f) => f.path) });
  }

  const tools = (cwd: string) => [
    tool(
      "list",
      "Каталог частей (edge, stable) и состояние каждой машины от её keeper; закреплённая часть — с pin. error: timeout у машины значит: она не ответила, остальные верны, повтори вызов.",
      { part: z.string().optional() },
      guarded(list),
    ),
    tool(
      "upload",
      "Упаковать модуль из папки с module.json (относительная — от рабочей папки сессии) и загрузить в каталог. Версия загружается один раз: тот же архив второй раз — same, другой — version_exists.",
      { dir: z.string() },
      guarded(async ({ dir }, extra) => {
        const m = packModule(resolve(cwd, dir));
        const { same } = await upload(net, m, (extra as { signal?: AbortSignal }).signal);
        return json({ part: m.name, version: m.version, ...(same ? { same } : { bytes: m.tgz.length, sha256: m.sha }) });
      }),
    ),
    tool(
      "fetch",
      "Положить модуль каталога (контракт и стенд) в <dir>/vendor/<part>/: dir — корень репо, относительный — от рабочей папки сессии; без version — новейшая. Прежнее содержимое vendor/<part> заменяется.",
      { part: z.string(), version: z.string().optional(), dir: z.string() },
      guarded((args, extra) => take(args, cwd, (extra as { signal?: AbortSignal }).signal)),
    ),
    tool(
      "deploy",
      "Выложить часть: stable на версию, без version — edge; part * — части Cloudflare, keeper и host на edge. Модуль сборки — новая сборка его приложений, version null — снять модуль, latest — все модули на новейшие одной проверкой. Откат — тот же вызов со старой версией.",
      { part: z.string(), version: z.string().nullable().optional(), latest: z.literal(true).optional(), without: z.array(z.string()).optional(), check_with: z.array(z.string()).optional() },
      guarded(async (args) => answer("releases.deploy", await net.ask("releases.deploy", args) as Result)),
    ),
    tool(
      "set",
      "Правка плана машины: pin (null — снять), on, force, env, remove; у keeper — только pin. Чистый перезапуск части: чистый перезапуск — on: false, затем on: true.",
      { machine: z.string(), part: z.string(), pin: z.string().nullable().optional(), on: z.boolean().optional(), force: z.boolean().optional(), env: z.record(z.string(), z.string()).optional(), remove: z.boolean().optional() },
      guarded(async (args) => answer("releases.set", await net.ask("releases.set", args) as Result)),
    ),
    tool(
      "log",
      "Журнал части на машине; по умолчанию — последний час и 50 строк. Host машины мёртв — причину даёт list (keeper.state).",
      { machine: z.string(), part: z.string().optional(), since: z.string().optional(), limit: z.number().optional() },
      guarded(async ({ machine, part, since, limit = LOG_LINES }) =>
        answer("machine.journal", await host.read("machine.journal", { v: 2, machine, ...(part && { part }), since: since ?? new Date(Date.now() - HOUR_MS).toISOString(), limit })),
      ),
    ),
  ];

  const module: Module = {
    start: (h) => void (host = h),
    session: (s) => ({ mcpServers: { parts: createSdkMcpServer({ name: "parts", tools: tools(s.info.cwd) }) } }),
  };
  return { module, tools };
}
