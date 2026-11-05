import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { refuse } from "@switchboard/host";
import type { Frame, Host, Module } from "@switchboard/host";
import { findShell, shellVersion, SHELLS } from "./os.ts";
import type { ShellName } from "./os.ts";
import { makeRuns } from "./runs.ts";
import { toolsOf } from "./tools.ts";

const DEFAULT_TIMEOUT = 120;
const seconds = (v: unknown) => typeof v === "number" && v > 0;

export function make() {
  let host: Host;
  const runs = makeRuns(() => host);
  const tools = (me: string) => toolsOf(me, () => host);

  let armed = false;
  const form = (why: string) => refuse("bad_frame", why);
  const existing = (req: Frame) => {
    const run = runs.get(req.run);
    if (!run) throw refuse("no_run", `run ${req.run}: запуска нет`);
    return run;
  };

  const module: Module = {
    start(h) {
      host = h;
    },
    stop: () => runs.stop(),
    session: ({ info: { callsign } }) => ({ mcpServers: { shell: createSdkMcpServer({ name: "shell", tools: tools(callsign) }) } }),
    requests: {
      async "shell.run"(req, ctx) {
        const { run: id, shell, script, stdin, timeout = DEFAULT_TIMEOUT, background } = req;
        if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id)) throw form("run: нужен id запуска");
        if (!SHELLS.includes(shell as ShellName)) throw form(`shell: ${shell} — нужен bash, pwsh или powershell`);
        if (typeof script !== "string") throw form("script: нужен текст");
        if (stdin !== undefined && typeof stdin !== "string") throw form("stdin: нужен текст");
        if (typeof background !== "boolean") throw form("background: обязательный выбор true или false");
        if (!seconds(timeout)) throw form("timeout: секунды больше 0");
        if (background && req.timeout === undefined) throw form("background: true — timeout обязателен");
        if (runs.has(id)) throw form(`run ${id}: такой запуск уже есть`);
        const path = findShell(shell as ShellName);
        if (!path) throw refuse("no_shell", `${shell}: на машине ${host.machine} нет`);
        if (!armed) {
          armed = true;
          ctx.signal.addEventListener("abort", () => runs.halt(), { once: true });
        }
        const run = runs.start({ id, owner: ctx.from, shell: shell as ShellName, path, script, stdin, timeout: timeout as number, background });
        if (!background) await run.done;
        return run.snapshot();
      },
      async "shell.wait"(req) {
        const run = existing(req);
        if (typeof req.timeout !== "number" || req.timeout < 0) throw form("timeout: секунды ожидания, 0 — сразу");
        await runs.wait(run, req.timeout * 1000);
        return run.snapshot();
      },
      "shell.kill"(req) {
        const run = existing(req);
        if (run.ended === undefined) runs.kill(run, "killed");
        return undefined;
      },
      async "shell.info"() {
        const found = await Promise.all(
          SHELLS.map(async (name) => {
            const path = findShell(name);
            return path ? [[name, { version: await shellVersion(name, path), path }]] : [];
          }),
        );
        return { shells: Object.fromEntries(found.flat() as Array<[string, unknown]>) };
      },
    },
  };

  return { module, tools };
}
