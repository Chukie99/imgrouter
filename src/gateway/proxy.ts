import { listAccounts } from "../db/accounts.js";
import { listClientKeys } from "../db/clientKeys.js";
import { resolveModel, modelIds } from "./models.js";
import { logRequest } from "./logs.js";
import { config } from "../config.js";
import * as keyPool from "../pool/keyPool.js";
import { MOCK_PNG_B64 } from "../worker/generator.js";

export interface ProxyResult {
  status: number;
  body: unknown;
  model?: string;
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
function sanitize(message: string, body: unknown): string {
  let safe=message;
  const secrets=[...listAccounts().map(a=>a.apiKey),...listClientKeys().map(k=>k.key)];
  const walk=(value:unknown):void=>{if(!value||typeof value!=='object')return;for(const [name,v] of Object.entries(value)){if((name==='text'||name==='data')&&typeof v==='string'&&v.length)secrets.push(v);else if(typeof v==='object')walk(v);}};
  walk(body);
  for(const secret of secrets) if(secret) safe=safe.split(secret).join('[redacted]');
  return safe.replace(/AIza[\w-]+|sk-[\w-]+/g,'[redacted]').slice(0,500);
}
async function forward(model: string, body: unknown, requestedModel = model): Promise<ProxyResult> {
  await keyPool.rolloverAccounts();
  if (config.mockGemini === "ok") {
    logRequest(requestedModel,model,200,0,undefined,"Mock provider");
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
    if (!account) {
      if (attempt===0) logRequest(requestedModel,model,last.status,0,undefined,undefined,'No active key ready: check disabled keys, cooldown, quota, or RPM');
      return last;
    }
    const started = Date.now();
    const record=(status:number,error?:string)=>logRequest(requestedModel,model,status,Date.now()-started,account.id,account.label,error?sanitize(error,body):undefined);

    try {
      const url = `${config.geminiBaseUrl}/models/${encodeURIComponent(model)}:generateContent`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": account.apiKey },
          signal: AbortSignal.timeout(90000),
          body: JSON.stringify(body),
        });
      } catch (error) {
        await keyPool.reportFailed(account.id);
        record(502, `Network error: ${(error as Error).message}`);
        last = { status: 502, body: errorBody(502, `network: ${(error as Error).message}`) };
        exclude.add(account.id);
        continue;
      }

      if (response.ok) {
        let json: unknown;
        try { json = await response.json(); } catch {
          await keyPool.reportFailed(account.id);
          record(502,"Invalid JSON from provider");
          return { status: 502, body: errorBody(502, "Invalid JSON from provider") };
        }
        const imageResponse=json as {candidates?:Array<{content?:{parts?:Array<{inlineData?:{data?:string}}>}}>};
        if(!imageResponse.candidates?.some(c=>c.content?.parts?.some(p=>p.inlineData?.data))) {
          await keyPool.reportFailed(account.id);record(502,'Provider returned no image; check safety filtering or model image support');
          return {status:502,body:errorBody(502,'Provider returned no image; check safety filtering or model image support')};
        }
        await keyPool.reportSuccess(account.id);
        record(200);
        return { status: 200, body: json };
      }

      const { parsed, message } = await readError(response);
      record(response.status,message);
      exclude.add(account.id);
      if (response.status === 429) {
        const daily = /per\s*day|perday|daily|quota.*day/i.test(message);
        if (daily) await keyPool.reportQuotaExhausted(account.id, undefined);
        else await keyPool.reportRateLimited(account.id, retryAfterMs(response, parsed));
      } else {
        await keyPool.reportFailed(account.id);
      }
      last = { status: response.status, body: parsed };
      if (response.status !== 429 && response.status < 500) return last;
    } finally {
      await keyPool.releaseKey(account.id);
    }
  }

  return last;
}

/** Retry keys within the same model; reference-image requests never switch models. */
export async function proxyGenerateContent(model: string, body: unknown): Promise<ProxyResult> {
  const route = resolveModel(model);
  if (!route) return { status: 400, body: errorBody(400, 'Unknown model or combo; use /v1/models') };
  const request = body as { contents?: Array<{ parts?: Array<Record<string, unknown>> }>; allow_model_fallback?: boolean };
  if (!Array.isArray(request.contents) || request.contents.some(c => !c || !Array.isArray(c.parts) || c.parts.some(p => !p || typeof p !== 'object'))) {
    return { status: 400, body: errorBody(400, 'contents must contain messages with a parts array') };
  }
  const hasReferences = request.contents?.some(c => c.parts?.some(p => p.inlineData || p.fileData));
  const targets = route.fallback && !hasReferences && request.allow_model_fallback !== false ? route.models : route.models.slice(0, 1);
  const { allow_model_fallback: _option, ...providerBody } = request;
  let last: ProxyResult = { status: 503, body: errorBody(503, 'No model available') };
  for (const target of targets) {
    last = { ...await forward(target, providerBody, model), model: target };
    if (last.status === 200 || ![429, 502, 503, 504].includes(last.status)) break;
  }
  return last;
}
export function listModels(): { models: Array<Record<string, unknown>> } {
  return { models: modelIds().map(id => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: ['generateContent'] })) };
}
