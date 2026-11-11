import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 4820, strictPort: true },
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 900 },
});
