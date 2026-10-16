import { config } from "./config.js";
import { getDb } from "./db/index.js";
import { startServer } from "./api/server.js";
import { runLoop } from "./scheduler/dispatcher.js";

async function main(): Promise<void> {
  getDb();

  const server = startServer();
  const stop = { stopped: false };

  const shutdown = () => {
    stop.stopped = true;
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`[imgrouter] listening on http://localhost:${config.port}`);
  console.log(`[imgrouter] db=${config.dbPath}`);
  console.log(`[imgrouter] images=${config.imagesDir}`);
  if (config.mockGemini) console.log(`[imgrouter] MOCK_GEMINI=${config.mockGemini} (no real calls)`);

  await runLoop(stop);
}

main().catch((error) => {
  console.error("[imgrouter] fatal:", error);
  process.exit(1);
});
