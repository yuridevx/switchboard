// Загрузка Worker-модулей из CI (deploy-workers.mjs): вход отклонён, нет токена, вызов не уложился в предел,
// веб не загружается. wrangler и сборка подменяются предзагрузкой: настоящий Cloudflare не трогается.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "deploy-workers.mjs");

/** Предзагрузка: дочерний процесс заменён на код child, предел 45 с — на 300 мс. */
function preload(child: { wrangler: string; build: string }): string {
  const f = join(mkdtempSync(join(tmpdir(), "deploy-pre-")), "pre.mjs");
  writeFileSync(
    f,
    `import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const orig = cp.spawnSync;
cp.spawnSync = (cmd, args, o = {}) => {
  const code = String(args[0]).endsWith("build.mjs") ? ${JSON.stringify(child.build)} : ${JSON.stringify(child.wrangler)};
  return orig(cmd, ["-e", code], { ...o, stdio: "ignore", input: undefined, timeout: o.timeout === 45000 ? 300 : o.timeout });
};
syncBuiltinESMExports();
`,
  );
  return pathToFileURL(f).href;
}

function deploy(args: string[], o: { token?: boolean; pre?: string } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, SWITCHBOARD_DEV_DIR: mkdtempSync(join(tmpdir(), "deploy-dev-")) };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  if (o.token) Object.assign(env, { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" });
  const r = spawnSync(process.execPath, [...(o.pre ? ["--import", o.pre] : []), script, ...args], { env, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, err: r.stderr, out: r.stdout };
}

describe("deploy-workers: загрузка из CI", () => {
  it("3153 · номер не того вида — отказ словами, выход 1, ничего не загружено", () => {
    // источник: чьё: код (deploy-workers.mjs — номер вида 1.1.58)
    const r = deploy(["--upload", "1.1"], { token: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain("deploy: --upload <номер вида 1.1.58>");
  });

  it("3154 · нет токена или аккаунта Cloudflare — отказ словами, выход 1", () => {
    // источник: чьё: код
    const r = deploy(["--upload", "1.1.99"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("deploy: нет CLOUDFLARE_API_TOKEN или CLOUDFLARE_ACCOUNT_ID");
  });

  it("3155 · wrangler не завершился за предел — убит, причина словами, выход 1: прогон CI красный", () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; предел — вдвое выше самого долгого шага (22 с)
    const r = deploy(["--upload", "1.1.99"], { token: true, pre: preload({ wrangler: "setTimeout(() => {}, 60000)", build: "" }) });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/deploy: wrangler versions upload .* — не завершился за 45 с/);
  });

  it("5146 · загрузка без выкладки — только Worker-модули: веб не собирается и не загружается", () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): веб больше не загружает
    const r = deploy(["--upload", "1.1.99"], { token: true, pre: preload({ wrangler: "", build: "process.exit(1)" }) });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/phone|pult/);
    expect(r.out).toContain("deploy: загружено 1.1.99, ничего не выложено");
  });
});
