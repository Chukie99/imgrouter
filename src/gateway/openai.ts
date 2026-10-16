import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { proxyGenerateContent } from "./proxy.js";

function upstreamMessage(body: unknown): string {
  const parsed = body as { error?: { message?: string } };
  return parsed?.error?.message ?? "upstream error";
}

function extractImageB64(body: unknown): string | null {
  const parsed = body as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }> };
  const part = parsed.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  return part?.inlineData?.data ?? null;
}

export interface OpenAIImageInput {
  model?: string;
  prompt: string;
  n?: number;
  responseFormat?: string;
}

/**
 * OpenAI-compatible text-to-image. Translates the request to a Gemini
 * generateContent call, runs it through the key pool, and reshapes the result.
 */
export async function openAIImageGeneration(
  input: OpenAIImageInput,
  origin: string,
): Promise<{ status: number; body: unknown }> {
  const model = input.model && /^gemini/i.test(input.model) ? input.model : config.geminiImageModel;
  const n = Math.min(Math.max(Math.floor(input.n ?? 1) || 1, 1), 10);
  const created = Math.floor(Date.now() / 1000);
  const data: Array<Record<string, string>> = [];

  for (let i = 0; i < n; i += 1) {
    const result = await proxyGenerateContent(model, {
      contents: [{ parts: [{ text: input.prompt }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    });

    if (result.status !== 200) {
      return { status: result.status, body: { error: { message: upstreamMessage(result.body), type: "upstream_error" } } };
    }

    const b64 = extractImageB64(result.body);
    if (!b64) return { status: 502, body: { error: { message: "no image in provider response", type: "upstream_error" } } };

    if (input.responseFormat === "url") {
      const dir = path.join(config.imagesDir, "_openai");
      fs.mkdirSync(dir, { recursive: true });
      const id = randomUUID();
      fs.writeFileSync(path.join(dir, `${id}.png`), Buffer.from(b64, "base64"));
      data.push({ url: `${origin}/files/_openai/${id}.png` });
    } else {
      data.push({ b64_json: b64 });
    }
  }

  return { status: 200, body: { created, data } };
}

/** OpenAI-compatible model list — the image model clients should ask for. */
export function listOpenAIModels(): { object: string; data: Array<Record<string, unknown>> } {
  return {
    object: "list",
    data: [{ id: config.geminiImageModel, object: "model", created: 0, owned_by: "imgrouter" }],
  };
}
