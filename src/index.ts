import { ensureDefaultClientKey } from "./db/clientKeys.js";
import { config } from "./config.js";
import { getDb } from "./db/index.js";
import { startServer } from "./api/server.js";


async function main(): Promise<void> {
  getDb();
  ensureDefaultClientKey();

  const server = startServer();


  const shutdown = () => {

    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`[imgrouter] listening on http://${config.host}:${config.port}`);
  console.log(`[imgrouter] db=${config.dbPath}`);
  console.log(`[imgrouter] images=${config.imagesDir}`);
  if (config.mockGemini) console.log(`[imgrouter] MOCK_GEMINI=${config.mockGemini} (no real calls)`);

  // Gateway only: no scene scheduler or background image generation.
}

main().catch((error) => {
  console.error("[imgrouter] fatal:", error);
  process.exit(1);
});

