// Разработка страницы на живом флоте: локальная сборка, а /call, /mcp и сокеты /f, /m уходят на адрес флота (SB2_BASE).
// npx vite --config vite.live.config.ts --port 4831, затем http://localhost:4831/?fleet=http://localhost:4831
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const base = process.env.SB2_BASE;
if (!base) throw new Error("нужен SB2_BASE — адрес флота");
const to = { target: base, changeOrigin: true, secure: true };
export default defineConfig({
  plugins: [react()],
  server: { strictPort: true, proxy: { "/call": to, "/mcp": to, "/health": to, "/token": to, "/f/": { ...to, ws: true }, "/m/": { ...to, ws: true } } },
});
