// Файл claude из пакета SDK и команда claude.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { CALL_MS } from "@sb/protocol";

const req = createRequire(import.meta.url);

export function sdkVersion(): string {
  return (JSON.parse(readFileSync(join(req.resolve("@anthropic-ai/claude-agent-sdk"), "..", "package.json"), "utf8")) as { version: string }).version;
}

/** Файл claude в пакете SDK: Host находит его сам, поиск внутри SDK на Linux идёт через process.report, это 20 с на wsl. */
export function claudePath(): string | undefined {
  const file = `claude${process.platform === "win32" ? ".exe" : ""}`;
  for (const libc of ["", "-musl"]) {
    try {
      return req.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${libc}/${file}`);
    } catch {
      // пакета этой libc на машине нет
    }
  }
  return undefined;
}

/** Команда claude: вывод вместе, предел ms — потом убита. */
export const claudeCli =
  (bin: string | undefined, ms = CALL_MS) =>
  (args: string[], env: Record<string, string | undefined>, input?: string): Promise<{ code: number | null; out: string }> => {
    if (!bin) return Promise.resolve({ code: null, out: "claude не найден в пакете SDK" });
    return new Promise((resolve) => {
      const p = spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let out = "";
      const timer = setTimeout(() => {
        p.kill("SIGKILL");
        // ответ сейчас: close ждёт и потомков, которые держат вывод
        resolve({ code: null, out: `${out}claude не ответил за ${ms / 1000} с` });
      }, ms);
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.stdin.on("error", () => {});
      p.stdin.end(input);
      p.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: null, out: String(e) });
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, out });
      });
    });
  };
