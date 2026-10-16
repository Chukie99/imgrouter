import { config } from "../config.js";
import type { Account } from "../db/types.js";

export type GenFailureKind = "rate_limited" | "quota_exhausted" | "failed";

export type GenOutcome =
  | { ok: true; b64: string }
  | { ok: false; kind: GenFailureKind; message: string; retryAfterMs?: number; resetAtMs?: number };

// 1x1 transparent PNG — used only by MOCK_GEMINI=ok.
export const MOCK_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

export interface ReferenceImage {
  mimeType: string;
  data: string;
}

export interface GenerateInput {
  prompt: string;
  model?: string;
  referenceImages?: ReferenceImage[];
}

export type KeyTestOutcome =
  | { ok: true; message: string; models: number; hasImageModel: boolean }
  | { ok: false; message: string };

/**
 * Validate an API key without spending image quota: ListModels is a free call.
 * Confirms the key is accepted and whether the configured image model is exposed.
 */
export async function testApiKey(apiKey: string): Promise<KeyTestOutcome> {
  if (config.mockGemini) {
    return config.mockGemini === "ok"
      ? { ok: true, message: "mock: key accepted", models: 1, hasImageModel: true }
      : { ok: false, message: `mock: ${config.mockGemini}` };
  }

  const url = `${config.geminiBaseUrl}/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`;
  let response: Response;
  try {
    response = await fetch(url, { method: "GET" });
  } catch (error) {
    return { ok: false, message: `network: ${(error as Error).message}` };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      /* not JSON */
    }
    return { ok: false, message };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, message: "invalid JSON from provider" };
  }

  const models = (json as { models?: Array<{ name?: string }> }).models ?? [];
  const target = `models/${config.geminiImageModel}`;
  const hasImageModel = models.some((m) => m.name === target);
  return {
    ok: true,
    message: hasImageModel ? "key valid · image model available" : "key valid · image model not listed",
    models: models.length,
    hasImageModel,
  };
}

/**
 * Build the `contents` array for generateContent.
 * Per the image-editing docs, reference image parts come BEFORE the text prompt
 * (gemini-2.5-flash-image supports up to 3 reference images).
 */
export function buildContents(input: GenerateInput): Array<{ parts: Array<Record<string, unknown>> }> {
  const parts: Array<Record<string, unknown>> = [];
  for (const ref of input.referenceImages ?? []) {
    parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.data } });
  }
  parts.push({ text: input.prompt });
  return [{ parts }];
}

/** Call Gemini's native image generation endpoint for one prompt. */
export async function generateImage(account: Account, input: GenerateInput): Promise<GenOutcome> {
  if (config.mockGemini === "ok") return { ok: true, b64: MOCK_PNG_B64 };
  if (config.mockGemini === "quota") {
    return { ok: false, kind: "quota_exhausted", message: "mock: quota_exhausted" };
  }
  if (config.mockGemini === "rate") {
    return { ok: false, kind: "rate_limited", message: "mock: rate_limited", retryAfterMs: 2000 };
  }

  const model = input.model ?? config.geminiImageModel;
  const url = `${config.geminiBaseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(account.apiKey)}`;
  const requestBody = {
    contents: buildContents(input),
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    return { ok: false, kind: "failed", message: `network: ${(error as Error).message}` };
  }

  if (!response.ok) return parseError(response);

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, kind: "failed", message: "invalid JSON from provider" };
  }

  const payload = json as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>;
  };
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  const image = parts.find((part) => part.inlineData?.data);

  if (!image?.inlineData?.data) {
    return { ok: false, kind: "failed", message: "no image in provider response" };
  }
  return { ok: true, b64: image.inlineData.data };
}

async function parseError(response: Response): Promise<GenOutcome> {
  const status = response.status;
  const text = await response.text().catch(() => "");
  let message = `HTTP ${status}`;
  let retryAfterMs: number | undefined;

  const headerRetry = response.headers.get("retry-after");
  if (headerRetry) {
    const seconds = Number(headerRetry);
    if (Number.isFinite(seconds)) retryAfterMs = seconds * 1000;
  }

  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; details?: Array<Record<string, unknown>> };
    };
    if (parsed.error?.message) message = parsed.error.message;
    for (const detail of parsed.error?.details ?? []) {
      const type = String(detail["@type"] ?? "");
      const delay = detail.retryDelay;
      if (type.includes("RetryInfo") && typeof delay === "string") {
        const seconds = Number.parseFloat(delay.replace("s", ""));
        if (Number.isFinite(seconds)) retryAfterMs = seconds * 1000;
      }
    }
  } catch {
    /* response body was not JSON */
  }

  if (status === 429 || status === 403) {
    const daily = /per\s*day|perday|daily|quota.*day/i.test(message);
    if (daily) {
      return {
        ok: false,
        kind: "quota_exhausted",
        message,
        resetAtMs: retryAfterMs ? Date.now() + retryAfterMs : undefined,
      };
    }
    return { ok: false, kind: "rate_limited", message, retryAfterMs };
  }

  return { ok: false, kind: "failed", message };
}
