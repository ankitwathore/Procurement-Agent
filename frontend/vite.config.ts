import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API (npm run api) serves the saved live runs on 8787; the dev server proxies /api to it.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
});
