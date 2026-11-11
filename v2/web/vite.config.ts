import react from "@vitejs/plugin-react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

/** Комментарии к прототипу на моке: страница шлёт пачку серверу разработки, он дописывает её строкой в файл; читает docs/designs/v2-focus/watch.mjs. */
const comments = (): Plugin => ({
  name: "prototype-comments",
  configureServer(server) {
    server.middlewares.use("/__comments", (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        fs.appendFileSync(path.join(os.homedir(), ".switchboard-dev", "v2-focus-comments.jsonl"), JSON.stringify({ at: Date.now(), ...JSON.parse(body) }) + "\n");
        res.end("{}");
      });
    });
  },
});

export default defineConfig({
  plugins: [react(), comments()],
  server: { port: 4820, strictPort: true },
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 900 },
});
