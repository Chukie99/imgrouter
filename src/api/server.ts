import { combos, saveCombo, deleteCombo, extraModels, addModel, removeModel } from "../gateway/models.js";
import { recentRequests } from "../gateway/logs.js";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import {
  createAccount,
  createAccounts,
  deleteAccount,
  deleteAccounts,
  deleteAccountsByStatus,
  getAccount,
  listAccounts,
} from "../db/accounts.js";
import { parseKeys } from "../util/parseKeys.js";
import { testApiKey } from "../worker/generator.js";
import { createClientKey, deleteClientKey, findClientKey, listClientKeys, touchClientKey } from "../db/clientKeys.js";
import { listModels, proxyGenerateContent } from "../gateway/proxy.js";
import { listOpenAIModels, openAIImageGeneration } from "../gateway/openai.js";
import { requireApiKey, setRequireApiKey } from "../db/settings.js";
import * as keyPool from "../pool/keyPool.js";
import type { Account, AccountStatus } from "../db/types.js";

const KNOWN_STATUSES: AccountStatus[] = ["active", "blocked", "disabled"];

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "*",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 36 * 1024 * 1024) throw Object.assign(new Error("Request body exceeds 36 MiB"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw Object.assign(new Error("Invalid JSON body"), { status: 400 }); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("body must be a JSON object"), { status: 400 });
  }
  return parsed as Record<string, unknown>;
}

function maskAccount(account: Account): Omit<Account, "apiKey"> {
  const { apiKey: _apiKey, ...rest } = account;
  return rest;
}

// Gemini clients send the key via `x-goog-api-key`, `?key=`, or Bearer.
function readClientKey(req: IncomingMessage, url: URL): string {
  const header = req.headers["x-goog-api-key"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return url.searchParams.get("key")?.trim() ?? "";
}

function unauthorized(res: ServerResponse, shape: "gemini" | "openai" = "gemini"): void {
  if (shape === "openai") {
    json(res, 401, { error: { message: "invalid or missing imgrouter API key", type: "invalid_request_error" } });
    return;
  }
  json(res, 401, { error: { code: 401, status: "UNAUTHORIZED", message: "invalid or missing imgrouter API key" } });
}

/**
 * Enforce the client key when required. Returns the matched key (or null when
 * auth is off). On failure it writes a 401 in the matching surface's shape.
 */
function guardApi(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  shape: "gemini" | "openai" = "gemini",
): { ok: true; key: string | null } | { ok: false } {
  if (!requireApiKey()) return { ok: true, key: null };
  const found = findClientKey(readClientKey(req, url));
  if (!found) {
    unauthorized(res, shape);
    return { ok: false };
  }
  touchClientKey(found.id);
  return { ok: true, key: found.key };
}

function requestOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? `localhost:${config.port}`;
  return `http://${host}`;
}

const dashboardPath = fileURLToPath(new URL("./dashboard.html", import.meta.url));
let dashboardHtml: string | null = null;
function getDashboard(): string {
  if (dashboardHtml == null) dashboardHtml = fs.readFileSync(dashboardPath, "utf8");
  return dashboardHtml;
}

export function startServer(): Server {
  const server = createServer((req, res) => {
    route(req, res).catch((error) => {
      json(res, (error as { status?: number }).status ?? 500, { error: (error as Error).message });
    });
  });
  server.listen(config.port, config.host);
  return server;
}

export async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
  const segments = url.pathname.split("/").filter(Boolean);

  if (method === "OPTIONS") {
    json(res, 204, {});
    return;
  }

  // Admin actions are local-only and reject cross-origin browser requests.
  const publicRoute = ["v1", "v1beta", "files", "health"].includes(segments[0] ?? "");
  if (!publicRoute) {
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
    const origin = req.headers.origin;
    const sameOrigin = !origin || origin === `http://${req.headers.host}`;
    const hostname = new URL(`http://${req.headers.host ?? "localhost"}`).hostname;
    const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
    if (!local || !localHost || !sameOrigin || req.headers["sec-fetch-site"] === "cross-site") {
      json(res, 403, { error: "Dashboard administration is available locally only" }); return;
    }
  }
  // GET /  and  GET /dashboard — static single-page dashboard
  if (method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(getDashboard());
    return;
  }

  if (method === "GET" && url.pathname === "/favicon.ico") {
    json(res, 204, {});
    return;
  }

  // GET /health
  if (method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true });
    return;
  }

  // GET /status
  if (method === "GET" && url.pathname === "/status") {
    json(res, 200, {
      capacity: config.providerManagedQuota ? null : keyPool.capacity(),
      quotaMode: config.providerManagedQuota ? "provider" : "local",
      healthyKeys: keyPool.healthyKeyCount(),
      nextWakeAt: keyPool.nextWakeAt(),
      accounts: listAccounts().length,
      clientKeys: listClientKeys().length,
      gatewayBase: "/v1beta",
      openaiBase: "/v1",
      requireApiKey: requireApiKey(),
      models: listModels().models.map((m) => String(m.name)),
      combos: combos(),
      defaultModel: config.geminiImageModel,
      extraModels: extraModels(),
      requests: recentRequests(),
    });
    return;
  }

  if (segments[0] === "models") {
    if (method === "GET") { json(res, 200, { defaultModel: config.geminiImageModel, models: extraModels() }); return; }
    if (method === "POST") {
      const body = await readJson(req);
      try { addModel(body.model); json(res, 200, { models: extraModels() }); }
      catch (error) { json(res, 400, { error: (error as Error).message }); }
      return;
    }
    if (method === "DELETE" && segments[1]) {
      try { removeModel(segments[1]); json(res, 200, { models: extraModels() }); }
      catch (error) { json(res, 400, { error: (error as Error).message }); }
      return;
    }
  }
  if (segments[0] === "combos") {
    if (method === "GET") { json(res, 200, { combos: combos() }); return; }
    if (method === "POST") {
      const body = await readJson(req);
      try { json(res, 200, saveCombo(body)); } catch (error) { json(res, 400, { error: (error as Error).message }); }
      return;
    }
    if (method === "DELETE" && segments[1]) { deleteCombo(segments[1]); json(res, 200, { ok: true }); return; }
  }
  if (method === "GET" && url.pathname === "/logs") { json(res, 200, { requests: recentRequests() }); return; }

  // GET/POST /settings — dashboard-managed gateway options
  if (segments[0] === "settings") {
    if (method === "GET") {
      json(res, 200, { requireApiKey: requireApiKey() });
      return;
    }
    if (method === "POST") {
      const body = await readJson(req);
      if (typeof body.requireApiKey === "boolean") setRequireApiKey(body.requireApiKey);
      json(res, 200, { requireApiKey: requireApiKey() });
      return;
    }
  }

  // GET /files/{path} — serve generated images (used by OpenAI response_format=url)
  if (method === "GET" && segments[0] === "files") {
    const root = path.resolve(config.imagesDir);
    const abs = path.resolve(root, segments.slice(1).join("/"));
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      json(res, 404, { error: "file not found" });
      return;
    }
    const guard = guardApi(req, url, res, "openai");
    if (!guard.ok) return;
    const ext = path.extname(abs).toLowerCase();
    const type = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
    res.writeHead(200, { "content-type": type, "access-control-allow-origin": "*" });
    fs.createReadStream(abs).pipe(res);
    return;
  }

  // /clientkeys — imgrouter-issued keys for clients (dashboard management)
  if (segments[0] === "clientkeys") {
    if (method === "GET" && segments.length === 1) {
      json(res, 200, { clientKeys: listClientKeys() });
      return;
    }
    if (method === "POST" && segments.length === 1) {
      const body = await readJson(req);
      const label = typeof body.label === "string" ? body.label : "";
      json(res, 201, createClientKey(label));
      return;
    }
    if (method === "DELETE" && segments.length === 2 && segments[1]) {
      json(res, 200, { deleted: deleteClientKey(segments[1]) });
      return;
    }
  }

  // Gemini-native gateway: clients call these with an imgrouter key.
  if (segments[0] === "v1beta") {
    const guard = guardApi(req, url, res);
    if (!guard.ok) return;

    // GET /v1beta/models
    if (method === "GET" && segments.length === 2 && segments[1] === "models") {
      json(res, 200, listModels());
      return;
    }

    // POST /v1beta/models/{model}:generateContent  (also accepts :streamGenerateContent)
    if (method === "POST" && segments.length === 3 && segments[1] === "models" && segments[2]) {
      const action = segments[2];
      if (!action.endsWith(":generateContent")) { json(res, 400, { error: "Only :generateContent is supported; streaming is not supported" }); return; }
      const colon = action.lastIndexOf(":");
      const model = colon === -1 ? action : action.slice(0, colon);
      if (!model) {
        json(res, 400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "missing model name" } });
        return;
      }
      const body = await readJson(req);
      const result = await proxyGenerateContent(model, body);
      json(res, result.status, result.body);
      return;
    }
  }

  // OpenAI-compatible gateway: /v1/models and /v1/images/generations
  if (segments[0] === "v1") {
    const guard = guardApi(req, url, res, "openai");
    if (!guard.ok) return;

    if (method === "GET" && segments.length === 2 && segments[1] === "models") {
      json(res, 200, listOpenAIModels());
      return;
    }

    if (method === "POST" && segments.length === 3 && segments[1] === "images" && ["generations", "edits"].includes(segments[2] ?? "")) {
      if (!(req.headers["content-type"] ?? "").includes("application/json")) {
        json(res, 415, { error: { message: "Use application/json with reference_images or image as base64 data URLs; multipart is not supported" } }); return;
      }
      const body = await readJson(req);
      if (segments[2] === "edits" && body.image === undefined && body.reference_images === undefined) { json(res, 400, { error: { message: "Image edits require image or reference_images" } }); return; }
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) {
        json(res, 400, { error: { message: "prompt is required", type: "invalid_request_error" } });
        return;
      }
      if (body.n !== undefined && typeof body.n !== "number") { json(res, 400, { error: { message: "n must be a number" } }); return; }
      const result = await openAIImageGeneration(
        {
          model: typeof body.model === "string" ? body.model : undefined,
          prompt,
          n: typeof body.n === "number" ? body.n : undefined,
          responseFormat: typeof body.response_format === "string" ? body.response_format : undefined,
          referenceImages: body.reference_images,
          image: body.image,
          allowModelFallback: body.allow_model_fallback !== false,
        },
        requestOrigin(req),
      );
      json(res, result.status, result.body);
      return;
    }
  }

  // /accounts
  if (segments[0] === "accounts") {
    if (method === "GET" && segments.length === 1) {
      json(res, 200, { accounts: listAccounts().map(maskAccount) });
      return;
    }
    if (method === "POST" && segments.length === 1) {
      const body = await readJson(req);
      const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : "Gemini key";
      const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
      const dayLimit = undefined;
      if (!label || !apiKey) {
        json(res, 400, { error: "label and apiKey are required" });
        return;
      }
      const account = createAccount(label, apiKey, dayLimit);
      json(res, 201, maskAccount(account));
      return;
    }
    if (method === "DELETE" && segments.length === 2 && segments[1]) {
      deleteAccount(segments[1]);
      json(res, 200, { deleted: segments[1] });
      return;
    }
    // POST /accounts/bulk — paste many keys at once
    if (method === "POST" && segments.length === 2 && segments[1] === "bulk") {
      const body = await readJson(req);
      let items: Array<{ label: string; apiKey: string; dayLimit?: number }> = [];
      let invalid: string[] = [];

      if (typeof body.keys === "string") {
        const parsed = parseKeys(body.keys);
        items = parsed.entries;
        invalid = parsed.invalid;
      } else if (Array.isArray(body.accounts)) {
        for (const raw of body.accounts) {
          const entry = raw as Record<string, unknown>;
          const apiKey = typeof entry.apiKey === "string" ? entry.apiKey.trim() : "";
          const label = typeof entry.label === "string" ? entry.label.trim() : "";
          const dayLimit = typeof entry.dayLimit === "number" ? entry.dayLimit : undefined;
          if (!apiKey) {
            invalid.push(String(entry.apiKey ?? entry.label ?? "?"));
            continue;
          }
          items.push({ label: label || apiKey.slice(-6), apiKey, dayLimit });
        }
      } else {
        json(res, 400, { error: "provide keys (string) or accounts (array)" });
        return;
      }

      const result = createAccounts(items);
      json(res, 200, { added: result.added, skipped: result.skipped, invalid });
      return;
    }
    // POST /accounts/test — validate a key (by apiKey or stored account id) without spending quota
    if (method === "POST" && segments.length === 2 && segments[1] === "test") {
      const body = await readJson(req);
      const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      const id = typeof body.id === "string" ? body.id : "";
      const key = apiKey || (id ? (getAccount(id)?.apiKey ?? "") : "");
      if (!key) {
        json(res, 400, { error: "apiKey or id is required" });
        return;
      }
      const result = await testApiKey(key);
      json(res, 200, result);
      return;
    }
    // POST /accounts/delete — bulk remove by ids or by status
    if (method === "POST" && segments.length === 2 && segments[1] === "delete") {
      const body = await readJson(req);
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
      const statuses = Array.isArray(body.statuses)
        ? body.statuses.filter((s): s is AccountStatus => KNOWN_STATUSES.includes(s as AccountStatus))
        : [];
      const removed = deleteAccounts(ids) + deleteAccountsByStatus(statuses);
      json(res, 200, { removed });
      return;
    }
  }

  json(res, 404, { error: `no route for ${method} ${url.pathname}` });
}
