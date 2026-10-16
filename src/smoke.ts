import fs from "node:fs";
import path from "node:path";

// Self-contained test env — must be set before config.js is imported.
process.env.MOCK_GEMINI ??= "ok";
process.env.DB_PATH ??= path.resolve(process.cwd(), "data/smoke.db");
process.env.IMAGES_DIR ??= path.resolve(process.cwd(), "data/smoke-images");

const { config } = await import("./config.js");
const { getDb } = await import("./db/index.js");
const { createAccount, createAccounts, deleteAccountsByStatus, getAccount, listAccounts, updateAccount } = await import(
  "./db/accounts.js"
);
const { parseKeys } = await import("./util/parseKeys.js");
const { createProjectWithScenes, getScenes } = await import("./db/projects.js");
const { runOnce } = await import("./scheduler/dispatcher.js");
const { buildContents } = await import("./worker/generator.js");
const keyPool = await import("./pool/keyPool.js");
const jobsApi = await import("./db/jobs.js");
const clientKeysApi = await import("./db/clientKeys.js");
const proxy = await import("./gateway/proxy.js");
const openai = await import("./gateway/openai.js");
const settingsApi = await import("./db/settings.js");

let failures = 0;
function assert(condition: boolean, label: string): void {
  if (condition) console.log(`  ok: ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL: ${label}`);
  }
}

function resetTables(): void {
  getDb().exec("DELETE FROM jobs; DELETE FROM scenes; DELETE FROM projects; DELETE FROM accounts; DELETE FROM quota_log; DELETE FROM client_keys; DELETE FROM settings;");
}

async function main(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(config.dbPath + suffix, { force: true });
  getDb();

  console.log("scenario 1: full capacity, 50 scenes (10 keys x 5)");
  resetTables();
  for (let i = 0; i < 10; i += 1) createAccount(`acct-${i}`, `key-${i}`, 5);
  const project1 = createProjectWithScenes({
    title: "video-1",
    stylePrompt: "flat vector, consistent character",
    prompts: Array.from({ length: 50 }, (_unused, i) => `scene ${i + 1}`),
  });
  const run1 = await runOnce();
  console.log(`  summary: ${JSON.stringify(run1)}`);
  assert(run1.done === 50 && run1.deferred === 0, "all 50 generated in one pass");
  const scenes1 = getScenes(project1.project.id);
  assert(scenes1.filter((s) => s.status === "done").length === 50, "50 scenes marked done");
  assert(Boolean(scenes1[0]?.outputPath) && fs.existsSync(scenes1[0]!.outputPath!), "image file written to disk");

  console.log("scenario 2: quota-limited today (3 keys x 5 = 15) for 50 scenes");
  resetTables();
  for (let i = 0; i < 3; i += 1) createAccount(`limited-${i}`, `lkey-${i}`, 5);
  createProjectWithScenes({
    title: "video-2",
    prompts: Array.from({ length: 50 }, (_unused, i) => `limited scene ${i + 1}`),
  });
  const run2 = await runOnce();
  console.log(`  summary: ${JSON.stringify(run2)}`);
  assert(run2.capacity === 15, "capacity is 15");
  assert(run2.done === 15 && run2.deferred === 35, "15 done today, 35 deferred");

  console.log(`scenario 3: proactive RPM pacing (1 key, dayLimit 10, rpm=${config.rpmPerKey})`);
  resetTables();
  createAccount("rpm-key", "rpmkey", 10);
  createProjectWithScenes({
    title: "video-3",
    prompts: Array.from({ length: 10 }, (_unused, i) => `rpm scene ${i + 1}`),
  });
  const run3 = await runOnce();
  console.log(`  summary: ${JSON.stringify(run3)}`);
  assert(run3.capacity === 10, "daily capacity is 10");
  assert(run3.done === config.rpmPerKey, `capped at rpm (${config.rpmPerKey}), not 10, in one window`);
  assert(run3.nextWakeAt != null, "scheduler knows when an RPM slot frees up");

  console.log("scenario 4: auto-anchor — scene #1 anchors the rest (no refImagePath)");
  resetTables();
  createAccount("anchor-key", "akey", 20);
  const project4 = createProjectWithScenes({
    title: "video-4",
    prompts: ["hero close-up", "hero mid shot", "hero action", "hero back"],
  });
  const run4 = await runOnce();
  console.log(`  summary: ${JSON.stringify(run4)}`);
  const scenes4 = getScenes(project4.project.id);
  const anchor4 = scenes4.find((s) => s.idx === 0);
  assert(run4.done === 4, "all 4 scenes completed in one pass (anchor barrier resolved)");
  assert(anchor4?.status === "done" && Boolean(anchor4.outputPath), "scene #1 produced the anchor image");
  assert(scenes4.every((s) => s.status === "done"), "every sibling finished off the anchor");

  console.log("scenario 5: explicit reference image (refImagePath)");
  resetTables();
  const refPath = path.join(path.dirname(config.dbPath), "smoke-ref.png");
  fs.mkdirSync(path.dirname(refPath), { recursive: true });
  fs.writeFileSync(
    refPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      "base64",
    ),
  );
  createAccount("ref-key", "rkey", 10);
  const project5 = createProjectWithScenes({
    title: "video-5",
    refImagePath: refPath,
    prompts: ["a", "b", "c"],
  });
  const run5 = await runOnce();
  console.log(`  summary: ${JSON.stringify(run5)}`);
  assert(run5.done === 3, "all 3 scenes use the explicit reference without waiting on an anchor");
  assert(getScenes(project5.project.id).every((s) => s.status === "done"), "explicit-ref project fully done");

  console.log("scenario 6: reference-image request shape");
  const contents = buildContents({
    prompt: "hello",
    referenceImages: [{ mimeType: "image/png", data: "AAA" }],
  });
  const parts = contents[0]!.parts;
  assert(parts.length === 2, "one inline image + one text part");
  const image = parts[0]!.inlineData as { mimeType: string; data: string };
  assert(image.mimeType === "image/png" && image.data === "AAA", "reference image inlined as inlineData");
  assert(parts[1]!.text === "hello", "text prompt placed after the reference image");

  console.log("scenario 7: crash recovery — stale 'running' jobs are re-queued");
  resetTables();
  createAccount("crash-key", "ckey", 10);
  const project7 = createProjectWithScenes({ title: "video-7", prompts: ["x", "y"] });
  getDb().prepare("UPDATE jobs SET state = 'running', leaseUntil = ?").run(Date.now() - 1000);
  const reclaimed = jobsApi.reclaimStale();
  assert(reclaimed === 2, "both stuck jobs reclaimed to 'pending'");
  const run7 = await runOnce();
  console.log(`  summary: ${JSON.stringify(run7)}`);
  assert(run7.done === 2, "reclaimed jobs completed after the crash");
  assert(getScenes(project7.project.id).every((s) => s.status === "done"), "project recovered fully");

  console.log("scenario 8: quota rollover reactivates a blocked key");
  resetTables();
  const blocked = createAccount("roll-key", "rlkey", 5);
  updateAccount(blocked.id, { status: "blocked", dayUsed: 5, resetAt: Date.now() - 1000 });
  const reset = await keyPool.rolloverAccounts();
  assert(reset >= 1, "rollover found an expired window");
  const after = getAccount(blocked.id)!;
  assert(after.status === "active" && after.dayUsed === 0, "key reactivated with dayUsed=0");
  assert(listAccounts().length === 1, "account list intact");

  console.log("scenario 9: bulk import parsing + dedupe + bulk delete");
  resetTables();
  const blob = [
    "# my gemini keys",
    "AIza" + "a".repeat(35),
    "chan2,AIza" + "b".repeat(35) + ",7",
    "AIza" + "c".repeat(35) + " chan3",
    "garbage 😀",
  ].join("\n");
  const parsed = parseKeys(blob);
  assert(parsed.entries.length === 3, "3 keys parsed from mixed formats");
  assert(parsed.invalid.length === 1, "1 malformed line flagged");
  assert(parsed.entries[1]!.label === "chan2" && parsed.entries[1]!.dayLimit === 7, "label + dayLimit parsed");
  assert(parsed.entries[2]!.label === "chan3", "key-first line detected and labelled");
  const r1 = createAccounts(parsed.entries);
  assert(r1.added === 3 && r1.skipped === 0, "bulk insert added 3");
  const r2 = createAccounts(parsed.entries);
  assert(r2.added === 0 && r2.skipped === 3, "re-import skips duplicates");
  assert(listAccounts().length === 3, "account count is 3");
  assert(deleteAccountsByStatus(["active"]) === 3, "bulk delete by status removed 3");

  console.log("scenario 10: client keys — create, verify, revoke");
  resetTables();
  const ck = clientKeysApi.createClientKey("my-app");
  assert(ck.key.startsWith("sk-"), "issued key has sk- prefix");
  assert(clientKeysApi.listClientKeys().length === 1, "key listed");
  assert(clientKeysApi.findClientKey(ck.key)?.id === ck.id, "issued key verifies");
  assert(clientKeysApi.findClientKey("sk-nope") === null, "unknown key rejected");
  clientKeysApi.touchClientKey(ck.id);
  assert(clientKeysApi.listClientKeys()[0]!.uses === 1, "use counter increments");
  assert(clientKeysApi.deleteClientKey(ck.id) === 1 && clientKeysApi.listClientKeys().length === 0, "key revoked");

  console.log("scenario 11: gateway proxy forwards Gemini-native calls (mock)");
  resetTables();
  createAccount("gw-key", "gwkey", 10);
  const gw = await proxy.proxyGenerateContent(config.geminiImageModel, { contents: [{ parts: [{ text: "hi" }] }] });
  const gwBody = gw.body as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }> };
  const gwPart = gwBody.candidates?.[0]?.content?.parts?.[0];
  assert(gw.status === 200 && Boolean(gwPart?.inlineData?.data), "mock gateway returns an image part");
  assert(
    proxy.listModels().models[0]!.name === `models/${config.geminiImageModel}`,
    "models list exposes the configured image model",
  );

  console.log("scenario 12: OpenAI-compatible images + settings (mock)");
  resetTables();
  const oa = await openai.openAIImageGeneration({ prompt: "a cat", responseFormat: "b64_json" }, "http://localhost:8787");
  const oaData = (oa.body as { data?: Array<{ b64_json?: string; url?: string }> }).data ?? [];
  assert(oa.status === 200 && Boolean(oaData[0]?.b64_json), "OpenAI image endpoint returns b64_json");
  const oaUrl = await openai.openAIImageGeneration({ prompt: "a dog", responseFormat: "url" }, "http://localhost:8787");
  const oaUrlData = (oaUrl.body as { data?: Array<{ url?: string }> }).data ?? [];
  assert(Boolean(oaUrlData[0]?.url?.startsWith("http://localhost:8787/files/")), "response_format=url returns a served file URL");
  assert(openai.listOpenAIModels().data[0]!.id === config.geminiImageModel, "OpenAI models list exposes the image model");
  assert(settingsApi.requireApiKey() === true, "requireApiKey defaults to true");
  settingsApi.setRequireApiKey(false);
  assert(settingsApi.requireApiKey() === false, "requireApiKey can be turned off");

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
