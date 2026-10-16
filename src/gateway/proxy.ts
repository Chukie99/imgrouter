import { config } from "../config.js";
import * as keyPool from "../pool/keyPool.js";
import { MOCK_PNG_B64 } from "../worker/generator.js";

export interface ProxyResult {
  status: number;
  body: unknown;
}

interface ProviderError {
  error?: { code?: number; status?: string; message?: string; details?: Array<Record<string, unknown>> };
}

function errorBody(status: number, message: string): ProviderError {
  return { error: { code: status, message } };
}

function retryAfterMs(response: Response, parsed: ProviderError): number | undefined {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  for (const detail of parsed.error?.details ?? []) {
    const type = String(detail["@type"] ?? "");
    const delay = detail.retryDelay;
    if (type.includes("RetryInfo") && typeof delay === "string") {
      const seconds = Number.parseFloat(delay.replace("s", ""));
      if (Number.isFinite(seconds)) return seconds * 1000;
    }
  }
  return undefined;
}

async function readError(response: Response): Promise<{ parsed: ProviderError; message: string }> {
  const text = await response.text().catch(() => "");
  let parsed: ProviderError;
  try {
    parsed = JSON.parse(text) as ProviderError;
  } catch {
    parsed = errorBody(response.status, text || `HTTP ${response.status}`);
  }
  return { parsed, message: parsed.error?.message ?? `HTTP ${response.status}` };
}

/**
 * Forward a Gemini-native generateContent request through the key pool.
 * The client's key is imgrouter's own; the upstream Gemini key is chosen here.
 * Retries across keys on rate limit / quota, mirroring the batch dispatcher.
 */
export async function proxyGenerateContent(model: string, body: unknown): Promise<ProxyResult> {
  if (config.mockGemini === "ok") {
    return {
      status: 200,
      body: {
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: MOCK_PNG_B64 } }] } }],
      },
    };
  }
  if (config.mockGemini === "quota") {
    return { status: 429, body: errorBody(429, "mock: quota_exhausted") };
  }
  if (config.mockGemini === "rate") {
    return { status: 429, body: errorBody(429, "mock: rate_limited") };
  }

  const exclude = new Set<string>();
  let last: ProxyResult = { status: 503, body: errorBody(503, "no key available (quota, rate limit, or cooldown)") };

  for (let attempt = 0; attempt < config.maxAttempts; attempt += 1) {
    const account = await keyPool.acquireKey(exclude);
    if (!account) return last;

    try {
      const url = `${config.geminiBaseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(account.apiKey)}`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (error) {
        await keyPool.reportFailed(account.id);
        last = { status: 502, body: errorBody(502, `network: ${(error as Error).message}`) };
        exclude.add(account.id);
        continue;
      }

      if (response.ok) {
        const json = await response.json().catch(() => ({}));
        await keyPool.reportSuccess(account.id);
        return { status: 200, body: json };
      }

      const { parsed, message } = await readError(response);
      exclude.add(account.id);
      if (response.status === 429 || response.status === 403) {
        const daily = /per\s*day|perday|daily|quota.*day/i.test(message);
        if (daily) await keyPool.reportQuotaExhausted(account.id, undefined);
        else await keyPool.reportRateLimited(account.id, retryAfterMs(response, parsed));
      } else {
        await keyPool.reportFailed(account.id);
      }
      last = { status: response.status, body: parsed };
    } finally {
      await keyPool.releaseKey(account.id);
    }
  }

  return last;
}

/** Gemini-native ListModels payload for the models imgrouter exposes. */
export function listModels(): { models: Array<Record<string, unknown>> } {
  return {
    models: [
      {
        name: `models/${config.geminiImageModel}`,
        displayName: "Gemini Image",
        supportedGenerationMethods: ["generateContent"],
      },
    ],
  };
}
