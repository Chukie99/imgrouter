import path from "node:path";

// .env is optional; Node >=20.12 exposes process.loadEnvFile.
try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env");
} catch {
  /* no .env file — fall back to real env / defaults */
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

export const config = {
  port: num("PORT", 8787),
  host: str("HOST", "127.0.0.1"),
  providerManagedQuota: str("PROVIDER_MANAGED_QUOTA", "true") !== "false",
  dbPath: str("DB_PATH", path.resolve(process.cwd(), "data/imgrouter.db")),
  imagesDir: str("IMAGES_DIR", path.resolve(process.cwd(), "data/images")),

  geminiBaseUrl: str("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, ""),
  geminiImageModel: str("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image"),

  defaultDayLimit: num("DEFAULT_DAY_LIMIT", 5),
  maxInflightPerKey: num("MAX_INFLIGHT_PER_KEY", 1),
  rpmPerKey: num("RPM_PER_KEY", 5),
  maxAttempts: num("MAX_ATTEMPTS", 3),

  resetTzOffsetMinutes: num("RESET_TZ_OFFSET_MINUTES", -420),

  dispatcherIntervalMs: num("DISPATCHER_INTERVAL_MS", 15000),
  rateLimitCooldownMs: num("RATE_LIMIT_COOLDOWN_MS", 45000),
  leaseTimeoutMs: num("LEASE_TIMEOUT_MS", 120000),

  mockGemini: str("MOCK_GEMINI", "") as "" | "ok" | "quota" | "rate",
} as const;

