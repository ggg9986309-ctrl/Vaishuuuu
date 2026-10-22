import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const root = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8888" } },
  build: { chunkSizeWarningLimit: 900 },
});
