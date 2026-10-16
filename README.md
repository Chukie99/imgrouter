# imgrouter

A local image API gateway for your applications. Add Gemini provider keys, create an imgrouter client key, and copy the gateway's **Base URL, API key, and model/combo name** into your application. No separate 9router installation is involved.

## Run

Requires Node.js 22.13+ (Node 24 recommended).

```sh
npm ci
npm start
```

Open http://127.0.0.1:8787. The dashboard is a local administration surface. Defaults bind to `127.0.0.1`; set `HOST=0.0.0.0` only when you intend other devices to access the API. Administration remains restricted to loopback, local Host names, and same-origin requests. Normal applications authenticate with an imgrouter key; never send the underlying Gemini key to clients.

Existing CLI and Windows tray commands are retained. The normal server no longer starts the old project/scene dispatcher. Old project tables remain in the database but `/projects` and `/run` are no longer served. Starting this version will not generate images from old queued projects.

## Connect an application

| Value | Default |
|---|---|
| Base URL | `http://127.0.0.1:8787/v1` |
| API key | A persistent default key is created on first startup; copy its `sk-...` value in Overview |
| Model | `gemini-2.5-flash-image`, or a combo name you create |

Additional client keys and Gemini model routes can be added in the dashboard, alongside custom combos. Default key bootstrapping is one-time: deliberately revoking the last key does not silently restore it.

The default model is a configured route, not a guarantee of Google model availability, billing, or quota. Change `GEMINI_IMAGE_MODEL` if necessary. `GET /v1/models` exposes the configured model, combos, and their target models.

The supported OpenAI-style surface is **image generation**, not chat completions or the complete OpenAI API. Applications must call the image endpoints; a text-chat-only client will need an image integration.

```http
POST /v1/images/generations
Authorization: Bearer YOUR_IMGROUTER_KEY
Content-Type: application/json

{
  "model": "character-images",
  "prompt": "The same character entering a night market",
  "reference_images": ["data:image/png;base64,BASE64_IMAGE_HERE"],
  "response_format": "b64_json",
  "n": 1
}
```

Create `character-images` in Models & combos first, or use the configured model ID directly. `reference_images` is an **imgrouter JSON extension**; the application must explicitly send it. It accepts up to three PNG/JPEG/WebP base64 data URLs, or `{ "mimeType": "image/png", "data": "..." }` objects. Limit: 8 MiB per decoded reference, 36 MiB total JSON body. It does not fetch remote URLs or read app-local file paths.

`POST /v1/images/edits` accepts the same JSON contract with `image` (a data URL, object, or array) or `reference_images`. **Multipart/form-data is not implemented**, so an SDK's standard multipart image-edit helper is not compatible. Use an explicit JSON request or the Gemini-native API.

For native Gemini clients, use base URL `http://127.0.0.1:8787/v1beta`, the imgrouter key via `x-goog-api-key` or Bearer, and `POST /v1beta/models/{model-or-combo}:generateContent`. Native contents are forwarded intact, including image parts, conversation turns, and thought signatures. Streaming endpoints are explicitly rejected.

`response_format` supports `b64_json` (default) and `url`. Returned file URLs require the same client key when downloaded; send an Authorization header. A browser `<img src>` without authentication will not load protected files. Generated file cleanup is not automatic.

## Character consistency and combos

The **application owns the character reference and scene history**. Send the same character reference and stable character description with every scene. The gateway does not create characters, invent scene prompts, or remember prior requests. Image references follow Gemini's multimodal generateContent contract: https://ai.google.dev/gemini-api/docs/image-generation

Create combos with a name such as `character-images` and an ordered list of Gemini model IDs. These aliases are persisted and returned by `/v1/models`. The current adapter supports **Gemini only**, not arbitrary image providers.

- Keys rotate within the same model when a key is rate-limited.
- Cross-model fallback is off by default. If enabled for a combo, it applies only to requests **without image references**, and only for 429/502/503/504 failures.
- Requests containing references always use the first combo model, even when it is unavailable. They return an error instead of silently changing the model.
- `allow_model_fallback: false` disables combo model fallback for a text-only request.
- Responses from the OpenAI-style endpoint include the actual `model`. In `n > 1` requests, later images stay on the first successful model. If a later image fails, the error response includes already generated `data`.
- For a whole character sequence, call one exact model ID or keep the first combo target unchanged. Changing a combo between scene requests changes its route. Matching references improves consistency but does not guarantee identical characters.

## Limits and logs

Normal mode uses **provider-managed quota** (`PROVIDER_MANAGED_QUOTA=true`). There is no user-facing daily-limit input and no artificial five-image daily stop. Rate limits cause cooldown; explicit daily quota errors block a key until the configured reset boundary. Google quotas can be shared across multiple keys in a project; adding keys does not create quota or make paid models free. The API key test checks key validity/model listing, not successful image generation.

`RPM_PER_KEY` and `MAX_INFLIGHT_PER_KEY` provide local pacing. `MAX_ATTEMPTS` caps retries within a model. Healthy-key daily counters reset at the configured provider day boundary. `RESET_TZ_OFFSET_MINUTES` is a fixed UTC offset, so adjust it when necessary; it is not a daylight-saving timezone database.

Request logs keep the latest 1,000 provider calls and show the latest 100. They store time, requested model, actual model, HTTP status, and duration. They do not store prompts, reference bytes, or secret keys. Provider credentials and client keys are stored in the local SQLite database; protect that file.

## Validation

```sh
npm run typecheck
npm test
npm run smoke
```

Gateway tests use simulated provider responses and exercise the actual HTTP routing function without binding a port. They cover authentication, local administration restrictions, combo discovery, reference preservation across key retries, model pinning, fallback, provider-managed quotas, rollover, and private logs. The legacy smoke suite retains coverage of dormant scene scheduling helpers. Neither suite proves live Gemini access or visual character consistency. Live generation requires your own authorized provider key and quota.
