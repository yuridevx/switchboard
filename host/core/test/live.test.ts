// Живой прогон: настоящий Agent SDK 0.3.311 и настоящий claude, модель claude-haiku-4-5, временная папка проекта.
// Без SWITCHBOARD_LIVE=1 пропускается. Держатели — настоящий файл keeper из SWITCHBOARD_HOLDER.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { Module } from "../contract.ts";
import { Kernel } from "../src/kernel.ts";
import { realHolders } from "../src/holders.ts";
import { claudePath } from "../src/release.ts";
import { CORE, module, until } from "../stand/index.ts";

describe.skipIf(process.env.SWITCHBOARD_LIVE !== "1" || !process.env.SWITCHBOARD_HOLDER)("живой прогон: настоящий SDK и claude", () => {
  it("ход сессии через ядро: spawn у держателя, хук и поле модуля, result, штатный stop", async () => {
    const home = mkdtempSync(join(tmpdir(), "switchboard-live-"));
    const project = mkdtempSync(join(tmpdir(), "switchboard-live-project-"));
    writeFileSync(join(project, "README.md"), "Временная папка живого прогона Switchboard.\n");
    const events: string[] = [];
    const live: Module = {
      session: (s) => ({ model: "claude-haiku-4-5", append: `Твой callsign — ${s.info.callsign}.` }),
      fields: { turns: (s) => s.store<number>().get() ?? 0 },
      on: {
        event(s, m) {
          events.push(m.type);
          if (m.type === "result") s.store<number>().update((n = 0) => n + 1);
        },
      },
    };
    const functions: Record<string, (...a: any[]) => Promise<unknown>> = {};
    for (const [n, f] of Object.entries(sdk)) if (typeof f === "function") functions[n] = f as never;
    const kernel = new Kernel({
      home,
      config: { machine: "live" },
      core: CORE,
      release: { version: "live", sdk: "0.3.311", modules: [module("host-live", live)], workers: {} },
      sdk: { query: sdk.query, functions, cli: async () => ({ code: 0, out: "" }) },
      holders: realHolders(home, process.env.SWITCHBOARD_HOLDER),
    });
    await kernel.start();
    const s = await kernel.open({ callsign: "lab@live", cwd: project });
    expect(s.state).toBe("idle");
    s.facade(kernel.mods[0]).input("Ответь одним словом: пинг");
    await until(() => events.includes("result") && s.state === "idle", 120_000);
    expect(s.record()).toMatchObject({ callsign: "lab@live", state: "idle", sdk: "0.3.311", turns: 1 });
    expect(s.model).toContain("haiku");
    await s.stop();
    expect(s.state).toBe("stopped");
    expect(claudePath(join(import.meta.dirname, ".."))).toBeTruthy();
  }, 180_000);
});
