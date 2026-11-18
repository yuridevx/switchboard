// Сборка страницы в web/dist: адрес флота — адрес самой страницы; вне прода — с комментариями к элементам.
import { spawnSync } from "node:child_process";
import path from "node:path";

export function buildPage(root, { prod = false } = {}) {
  const r = spawnSync("npx", ["vite", "build"], { cwd: path.join(root, "web"), shell: true, env: { ...process.env, VITE_FLEET: "origin", ...(prod ? {} : { VITE_COMMENTS: "1" }) }, stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) throw new Error(`страница не собралась: vite build вышел с кодом ${r.status}`);
}
