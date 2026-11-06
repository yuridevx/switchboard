// Запросы shell.*: проверка кадра и запуски этой машины; модели — те же запросы инструментами.
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { refuse } from "@switchboard/host";
import type { Ctx, Frame, Host, Module } from "@switchboard/host";
import { pathOf, SHELLS, versionOf, type Shell } from "./os.ts";
import { makeRuns, type Spec } from "./runs.ts";
import { toolsOf } from "./tools.ts";

const RUN_ID = /^[\w-]{1,64}$/;
const badFrame = (why: string) => refuse("bad_frame", why);

/** Кадр shell.run → запуск; шелл ищется уже после формы. */
function specOf(f: Frame): Omit<Spec, "path" | "from"> {
  const { run, shell, script, stdin, timeout, background } = f;
  if (typeof run !== "string" || !RUN_ID.test(run)) throw badFrame("run: нужен id запуска");
  if (!SHELLS.includes(shell as Shell)) throw badFrame(`shell: ${String(shell)} — нужен bash, pwsh или powershell`);
  if (typeof script !== "string") throw badFrame("script: нужен текст");
  if (stdin !== undefined && typeof stdin !== "string") throw badFrame("stdin: нужен текст");
  if (typeof background !== "boolean") throw badFrame("background: обязательный выбор true или false");
  if (timeout !== undefined && (typeof timeout !== "number" || timeout <= 0)) throw badFrame("timeout: секунды больше 0");
  if (background && timeout === undefined) throw badFrame("background: true — timeout обязателен");
  return { id: run, shell: shell as Shell, script, stdin, timeout, background };
}

export function make() {
  let host: Host;
  const runs = makeRuns(() => host);
  let armed = false;
  /** Ядро ждёт начатые запросы до stop(): запуски гаснут по сигналу остановки, он приходит с запросом. */
  const arm = ({ signal }: Ctx) => {
    if (!armed) signal.addEventListener("abort", () => runs.halt(), { once: true });
    armed = true;
  };
  const runOf = (f: Frame) => {
    const run = runs.get(f.run);
    if (!run) throw refuse("no_run", `run ${String(f.run)}: запуска нет`);
    return run;
  };
  const tools = (me: string) => toolsOf(() => host, me);

  const module: Module = {
    start: (h) => void (host = h),
    stop: () => runs.close(),
    session: ({ info: { callsign } }) => ({ mcpServers: { shell: createSdkMcpServer({ name: "shell", tools: tools(callsign) }) } }),
    requests: {
      async "shell.run"(f, ctx) {
        arm(ctx);
        const spec = specOf(f);
        if (runs.get(spec.id)) throw badFrame(`run ${spec.id}: такой запуск уже есть`);
        const path = pathOf(spec.shell);
        if (!path) throw refuse("no_shell", `${spec.shell}: на машине ${host.machine} нет`);
        const run = runs.start({ ...spec, path, from: ctx.from });
        return spec.background ? runs.snapshot(run) : runs.wait(run);
      },
      "shell.wait"(f) {
        const run = runOf(f);
        const { timeout } = f;
        if (typeof timeout !== "number" || timeout < 0) throw badFrame("timeout: секунды ожидания, 0 — сразу");
        return runs.wait(run, timeout * 1000);
      },
      async "shell.kill"(f) {
        await runs.kill(runOf(f));
      },
      async "shell.info"() {
        const found = SHELLS.flatMap((shell) => {
          const path = pathOf(shell);
          return path ? [{ shell, path }] : [];
        });
        const rows = await Promise.all(found.map(async ({ shell, path }) => [shell, { version: await versionOf(shell, path), path }]));
        return { shells: Object.fromEntries(rows) };
      },
    },
  };
  return { module, tools };
}
