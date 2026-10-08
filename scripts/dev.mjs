// Starts the API (port 8787) and the UI dev server (port 5173) together. Ctrl+C stops both.
import { spawn } from "node:child_process";

const procs = [
  spawn("npm", ["run", "api", "--workspace", "backend"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev", "--workspace", "frontend"], { stdio: "inherit" }),
];
const stop = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", (code) => { if (code) { stop(); process.exit(code); } });
