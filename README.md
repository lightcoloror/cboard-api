# Cboard API - REST API for Cboard application

[![cboard-org](https://circleci.com/gh/cboard-org/cboard-api.svg?style=shield)](https://app.circleci.com/pipelines/github/cboard-org/cboard-api)

[Cboard](https://app.cboard.io/) is an augmentative and alternative communication (AAC) web application, allowing users with speech and language impairments (autism, cerebral palsy) to communicate by symbols and text-to-speech. This repo supports the Cboard front-end, providing backend functionality and persistence.

Learn more about the [Cboard project](https://github.com/cboard-org/cboard).

## Pre-requisites

Before installing and running the Cboard API, be sure you have **locally** installed the following tools:

- Node.js: see the `.nvmrc` file for the exact version.
- MongoDB > 4.0.0 (download [here](https://docs.mongodb.com/manual/installation/))

To make sure that the Node version you use for local development is the same the deployed server uses, we recommend using the [nvm](https://github.com/nvm-sh/nvm) tool, which simplifies version management.
It automatically installs the version listed in the `.nvmrc` file when you do `nvm install`.

Use the following commands to check that you have them successfully installed, and/or to double-check your versions:

- `node -v`
- `mongo --version`

## Install

Clone the repository and install dependencies:

```bash
$ git clone https://github.com/cboard-org/cboard-api.git
$ cd cboard-api
$ nvm install
$ npm install -g yarn
$ yarn install
```

## Start the database

Start MongoDB. ([See MongoDB docs, if needed](https://docs.mongodb.com/manual/tutorial/manage-mongodb-processes/)).

```bash
$ mongod
```

## Configure environment variables

Create a `.env.development` file in the root directory of the project and add the following environment variables:

```env
AZURE_STORAGE_CONNECTION_STRING=your_azure_storage_connection_string
PRIVATE_LIBRARY_CONTAINER_NAME=cboard-private
COMMUNICATION_DIALECT_ASR_PROVIDER=tencentcloud
COMMUNICATION_TENCENTCLOUD_ASR_SECRET_ID=your_server_only_secret_id
COMMUNICATION_TENCENTCLOUD_ASR_SECRET_KEY=your_server_only_secret_key
COMMUNICATION_TENCENTCLOUD_ASR_REGION=
COMMUNICATION_DIALECT_ASR_TIMEOUT_SECONDS=30
VOLCENGINE_ASR_API_KEY=
VOLCENGINE_ASR_APP_KEY=
VOLCENGINE_ASR_ACCESS_KEY=
VOLCENGINE_ASR_BASE_URL=https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
VOLCENGINE_ASR_RESOURCE_ID=volc.bigasr.auc_turbo
FACEBOOK_APP_ID=your_facebook_app_id
FACEBOOK_APP_SECRET=your_facebook_app_secret
FACEBOOK_CALLBACK_URL=your_facebook_callback_url
GCLOUD_PROJECT=your_gcloud_project
GOOGLE_APP_ID=your_google_app_id
GOOGLE_APP_SECRET=your_google_app_secret
GOOGLE_APPLICATION_CREDENTIALS=/opt/cboard-api/google-auth.json
GOOGLE_PLAY_CREDENTIALS=/opt/cboard-api/google-play-auth.json
GOOGLE_CALLBACK_URL=your_google_callback_url
JWT_SECRET=your_jwt_secret
MONGO_URL=your_mongo_url
OPENSYMBOLS_SECRET=your_server_only_opensymbols_secret
GLOBALSYMBOLS_API_KEY=your_server_only_global_symbols_api_key
PICTOGRAM_IMAGE_PROXY_SECRET=your_independent_pictogram_proxy_secret
BACKGROUND_REMOVAL_PROVIDER=rembg
BACKGROUND_REMOVAL_API_URL=http://127.0.0.1:7000/api/remove
BACKGROUND_REMOVAL_API_KEY=
BACKGROUND_REMOVAL_TIMEOUT_MS=15000
AI_API_KEY=your_server_only_ai_key
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
AI_REQUEST_TIMEOUT_MS=15000
AI_IMAGE_MODEL=gpt-image-1
AI_IMAGE_REQUEST_TIMEOUT_MS=120000
AI_TTS_PROVIDER=openai-compatible
AI_TTS_API_KEY=your_server_only_speech_key
AI_TTS_BASE_URL=https://api.openai.com/v1
AI_TTS_MODEL=gpt-4o-mini-tts
AI_TTS_VOICE=alloy
AI_TTS_VOICES=alloy,verse
AI_TTS_TIMEOUT_MS=25000
VOLCENGINE_TTS_API_KEY=
VOLCENGINE_TTS_BASE_URL=https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse
VOLCENGINE_TTS_RESOURCE_ID=seed-tts-2.0
VOLCENGINE_TTS_VOICE=zh_female_vv_uranus_bigtts
VOLCENGINE_TTS_VOICES=zh_female_vv_uranus_bigtts
VOLCENGINE_TTS_TIMEOUT_MS=25000
COMMUNICATION_ENHANCEMENT_RATE_LIMIT_ENABLED=false
COMMUNICATION_ENHANCEMENT_POINTS_PER_MINUTE=30
COMMUNICATION_ENHANCEMENT_MONTHLY_POINTS=1000
COMMUNICATION_AI_TOKEN_QUOTA_ENABLED=false
COMMUNICATION_AI_MONTHLY_TOKEN_QUOTA=1000000
COMMUNICATION_AI_TEXT_TOKEN_RESERVATION=4096
COMMUNICATION_AI_IMAGE_TOKEN_RESERVATION=32768
REACT_APP_DEV_API_URL=your_react_app_dev_api_url
SENDGRID_API_KEY=your_sendgrid_api_key
```

`OPENSYMBOLS_SECRET` is optional. When configured, missing-word image search
falls back to the allowlisted OpenSymbols repositories after ARASAAC misses.
The shared secret remains on this API server and must never be bundled into a
web or mini-program client. Request a secret from the
[official OpenSymbols API page](https://www.opensymbols.org/api).

`GLOBALSYMBOLS_API_KEY` enables the official Global Symbols v2 API for both
the CBoard symbol editor and missing-word fallback. The key remains on this
server; clients receive only bounded results, complete public attribution and
HMAC-signed image proxy URLs. Set `PICTOGRAM_IMAGE_PROXY_SECRET` to an
independent random secret in production. `JWT_SECRET` is accepted only as a
compatibility fallback. Without a v2 key, the editor temporarily retains the
legacy Global Symbols v1 search while the communication runtime skips that
provider rather than inventing licensing metadata.

Caregiver-triggered AAC pictogram generation is optional. It reuses the same
server-only OpenAI-compatible or Azure client as communication AI, but requires
an explicit `AI_IMAGE_MODEL` or `AZURE_OPENAI_IMAGE_DEPLOYMENT`; text AI alone
does not enable image generation. `POST /gpt/communication/pictogram-generation`
accepts one authenticated label, applies the existing rate limit, monthly token
reservation and usage ledger, then normalizes provider output to a bounded PNG.
The API does not persist the prompt or image and never declares a public
license. CBoard Web and the WeChat mini program preview the result for a
caregiver and save it only as device-private data after explicit confirmation.

- **Intent:** Fill PicInterpreter issue #19's missing-pictogram maintenance gap
  without placing image-provider credentials or automatic AI decisions in the
  patient communication path.
- **Decision:** Selectively reuse CBoard AI Engine's AAC image-prompt constraints
  and the existing CBoard API AI client, authentication, quotas, usage ledger
  and PNG normalization. Do not install the unpublished local AI Engine package
  or add a second provider SDK.
- **Reason:** Image-model availability, billing and licensing differ from text
  AI. An explicit model gate plus caregiver preview prevents a configured text
  model from silently creating images or generated content from entering the
  public symbol library.
- **Evidence:** Provider, controller, Swagger, rate-limit, token-quota and usage
  tests pass `58` focused cases; CBoard Web passes `112` focused cases and an
  equivalent production build; WeChat passes `75 files / 333 tests`, TypeScript,
  ESLint, the cross-platform boundary check and a production package gate.
- **Effective scope:** Authenticated caregiver missing-word maintenance in
  CBoard Web and WeChat only. No automatic adoption, patient-triggered
  generation, public upload, public-license claim, board generation, deployment,
  preview upload or provider entitlement is implied.
- **Update record:** 2026-07-27 00:01:34 | Codex (GPT-5) documented the optional
  device-private AI pictogram generation contract and deployment variables.

Background removal is optional and disabled until
`BACKGROUND_REMOVAL_PROVIDER` is set. Use `rembg` with a self-hosted
[rembg HTTP server](https://github.com/danielgatis/rembg), or use `removebg`
with the official [remove.bg API](https://www.remove.bg/api#remove-background)
and keep `BACKGROUND_REMOVAL_API_KEY` on this API server. The default rembg
endpoint is `http://127.0.0.1:7000/api/remove`; the default remove.bg endpoint
is selected automatically when its URL is omitted. CBoard API validates the
input, forwards it in memory, and accepts only a bounded transparent PNG
response. It does not persist the source image.

To verify the configured provider without starting MongoDB or persisting an
output image, point the smoke command at a local JPEG, PNG, or WebP file:

```bash
BACKGROUND_REMOVAL_SMOKE_IMAGE=/path/to/photo.jpg npm run verify:background-removal
```

The command exercises the same provider adapter used by the API route and
prints only bounded metadata, a checksum, privacy flags, and elapsed time.

To verify the authenticated multipart route with an isolated Mongo database
and a local deterministic provider fixture, run the explicit integration gate:

```powershell
$env:COMMUNICATION_BACKGROUND_REMOVAL_HTTP_MONGO_TEST_URL='mongodb://127.0.0.1:27032/cboard-api-background-removal-http-test'
$env:COMMUNICATION_BACKGROUND_REMOVAL_HTTP_TEST_PORT='19124'
npm run verify:communication-background-removal-http-mongo
```

- **Intent:** prove that a regular authenticated caregiver can reach the
  background-removal adapter while an anonymous upload is rejected before the
  provider.
- **Decision:** reuse the existing Swagger route, Bearer authentication,
  multipart parser, provider adapter, transparent-PNG validation, Supertest,
  Nock, and a caller-provided isolated Mongo URL. The deterministic fixture
  does not call a paid provider.
- **Reason:** provider unit tests and direct smoke tests cannot prove the real
  login, role, upload, filename redaction, controller, and response chain.
- **Evidence:** the gate rejects the anonymous request with the existing CBoard
  403 behavior, renames the source to `communication-image.jpg`, accepts a
  transparent PNG only for a regular user, and passes `2/2`; all API unit tests
  pass `376/376`. The same adapter also processed the official rembg car fixture
  through a local rembg v2.0.75 server into a `480x360`, `78,560` byte PNG.
- **Scope:** development verification only. It does not configure production
  HTTPS, provider credentials, WeChat legal domains, or validate household
  photo segmentation quality.

Cantonese audio recognition is optional. Select `tencentcloud` with both
Tencent Cloud credentials to use SentenceRecognition `16k_yue`, or select
`volcengine` with a new-console `VOLCENGINE_ASR_API_KEY`. Legacy Volcengine
accounts may instead provide both `VOLCENGINE_ASR_APP_KEY` and
`VOLCENGINE_ASR_ACCESS_KEY`. The authenticated
`POST /gpt/communication/dialect-asr` route accepts one transient recording
of at most 3 MiB and 60 seconds, then returns editable source text without
matching it automatically. The Volcengine adapter reuses the official
[bigmodel flash recognition HTTP API](https://www.volcengine.com/docs/6561/1631584)
and Node 22 `fetch`; it does not add Python, WebSocket, ffmpeg, or another npm
dependency. Volcengine accepts MP3, WAV, and OGG Opus on this route; Tencent
Cloud retains its existing wider format support. CBoard API does not persist
the recording or include it in communication history, but the selected
external provider still processes it under its service terms. Keep every
credential on this API server. Tencent Cloud details remain in the official
[SentenceRecognition API](https://cloud.tencent.com/document/api/1093/35646)
and [ASR product capabilities](https://cloud.tencent.com/document/product/1093/35682).

For a credential-free engineering gate, start an isolated Mongo instance and
run `npm run verify:communication-volcengine-asr-http-mongo` with
`COMMUNICATION_VOLCENGINE_ASR_HTTP_MONGO_TEST_URL` set to that database. The
gate uses a loopback deterministic provider, verifies real CBoard login and
multipart handling, and never uploads caregiver audio or incurs provider
charges.

The parallel Tencent Cloud SDK gate is
`npm run verify:communication-tencentcloud-asr-http-mongo` with
`COMMUNICATION_TENCENTCLOUD_ASR_HTTP_MONGO_TEST_URL` set to an isolated Mongo
database. It executes the official TC3 request signer while Nock replaces only
the paid public response. Tencent Cloud limits the Base64-encoded `Data` field
to 3 MiB, so this adapter rejects an oversized encoded payload before the SDK
request even when the original file is below the shared raw-file limit.

- **Intent:** Complete the original PicInterpreter roadmap option for Doubao
  speech recognition without moving provider credentials or audio processing
  into CBoard Web or the WeChat package.
- **Decision:** Reuse the existing authenticated dialect audio endpoint,
  validation, consent, rate limit, manual text review, and local fallback.
  Add Volcengine bigmodel flash HTTP as a selectable provider while preserving
  Tencent Cloud `16k_yue` compatibility.
- **Reason:** Volcengine now exposes a one-request HTTP API for bounded audio,
  so the server can use native `fetch` instead of importing the previously
  reviewed Python/WebSocket/ffmpeg stacks. The clients already provide the
  correct privacy and correction workflow and do not need a second UI.
- **Evidence:** Provider tests cover new and legacy authentication headers,
  base64 request shape, MP3 format validation, bounded responses, silence,
  invalid audio, overload, rate limits, timeout, duration, health reporting,
  secret redaction, and the unchanged Tencent Cloud path. Cross-platform
  normalization accepts both `16k_yue` and `bigmodel` engines.
- **Scope:** Only caregiver-approved Cantonese audio recognition changes.
  Text remains editable and never triggers matching automatically. Audio and
  provider error bodies are not persisted or returned. Real recognition
  quality, provider entitlement, billing, public HTTPS, WeChat legal domains,
  and physical-device recordings still require deployment verification.
- **Update record:** 2026-07-22 14:31:35 | Codex (GPT-5.6) added the optional
  Volcengine bigmodel flash ASR provider through the existing dialect port.

Server-side speech synthesis is optional. Keep `AI_TTS_PROVIDER` empty or set
it to `openai-compatible`, then configure `AI_TTS_API_KEY` and
`AI_TTS_BASE_URL` for a dedicated OpenAI-compatible speech provider; leaving
the dedicated values blank reuses `AI_API_KEY` and `AI_BASE_URL`. To use the
current Doubao Seed TTS HTTP service instead, set `AI_TTS_PROVIDER=volcengine`
and configure the server-only `VOLCENGINE_TTS_API_KEY`, resource ID, voice,
and voice allowlist. This adapter follows the V3 SSE request shape used by the
MIT-licensed OpenClaw Volcengine provider, without adding its runtime as a
dependency. The authenticated
`POST /gpt/communication/speech` route accepts at most 300 characters and
returns a bounded MP3 with `no-store` and `nosniff` headers. CBoard API does
not persist the communication text or generated audio and does not return
provider error bodies or credentials. `AI_TTS_VOICE` selects the default and
`AI_TTS_VOICES` publishes a comma-separated allowlist for caregiver choice;
requests outside that list are rejected before the provider is called. The
WeChat client keeps WechatSI as its first choice and calls this paid fallback
only after plugin failure and only for a logged-in CBoard account.

- **Intent:** Restore the original PicInterpreter roadmap option for Doubao
  speech output without placing provider credentials in CBoard Web or WeChat.
- **Decision:** Reuse the existing speech route and provider contract, and add
  Volcengine V3 SSE as an optional provider. OpenAI-compatible speech remains
  backward compatible; no client endpoint, Python sidecar, or ffmpeg runtime
  is added.
- **Reason:** Volcengine publishes a current HTTP/SSE TTS contract and
  OpenClaw has a maintained MIT-licensed TypeScript implementation pattern.
  The separate ASR path now uses Volcengine's official one-request flash HTTP
  API as described above, while Tencent Cloud Cantonese remains compatible;
  neither path imports a Python/WebSocket stack into this API.
- **Evidence:** `communicationVolcengineTtsProvider.unit.js` covers current
  headers/body, multi-frame MP3 assembly, allowlisted voices, timeout/rate
  limits, malformed frames, and secret-safe errors. Controller tests verify
  health reporting does not expose the API key.
- **Scope:** This affects only authenticated server speech fallback when the
  deployment explicitly selects Volcengine. WechatSI and CBoard native speech
  stay first-line, and text, generated audio, credentials, and upstream error
  bodies are not persisted or returned.
- **Update record:** 2026-07-22 13:04:04 | Codex (GPT-5.6) added the optional
  Volcengine Seed TTS provider using the existing communication speech port.

## Protect optional enhancement cost

- **Intent:** Keep optional provider-backed enhancements usable without allowing one authenticated account or a faulty client to consume an unbounded amount of paid AI, speech, OCR, dialect ASR, metadata, or background-removal capacity.
- **Decision:** Reuse the ISC-licensed [rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible) Mongo adapter instead of implementing counters from scratch. Production requires a 30-point rolling minute limit and a 1000-point UTC calendar-month limit by default; development remains disabled unless explicitly enabled. Text-only edits cost 1 point, sentence generation/resegmentation/dialect normalization/server speech cost 2 points, and media-backed dialect ASR/OCR/metadata/background removal cost 4 points.
- **Reason:** The existing CBoard API already authenticates every enhancement request and already uses MongoDB. A shared atomic limiter therefore adds cost protection without introducing a second backend, a payment dependency, or patient-content storage. Weighted points reflect the materially different provider costs while preserving all local communication fallbacks.
- **Evidence:** communicationEnhancementRateLimit.unit.js verifies bounded configuration, operation weights, hashed user keys, minute and natural-month responses, fail-closed store behavior, and non-consumption by unrelated routes. productionDeployment.unit.js and npm run verify:production-deploy-template verify that production cannot disable or misconfigure the limits. The health endpoint exposes only the policy, while limit collections store a SHA-256 user identity and counters, never request text, audio, images, tokens, or provider credentials.
- **Scope:** This protects only authenticated optional enhancement routes. It does not limit CBoard's local board use, the PicInterpreter expression/receiver loops, local rules, WechatSI speech, account/settings sync, public pictogram search, or confirmed receiver records. It is not billing, a paid subscription, or a promise of provider availability; exhausted requests return 429, and an unavailable limit store returns 503 without weakening local communication.
- **Update record:** 2026-07-22 02:19:34 | Codex (GPT-5) added the shared Mongo-backed minute/month cost-protection contract, production validation, health fields, and cross-platform client notices.

## Enforce a monthly communication AI Token allowance

- **Intent:** Add a request-time monthly Token allowance for the six Chat
  Completions-backed communication operations, while keeping local AAC
  communication available when the allowance is exhausted.
- **Decision:** Reuse the existing ISC-licensed
  [rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible)
  Mongo adapter. Production reserves 4,096 Tokens for text requests and
  32,768 Tokens for image requests against a configurable 1,000,000 Token UTC
  monthly allowance. Provider-reported usage settles the reservation and
  refunds or charges the difference; a provider response without usage keeps
  the conservative reservation. Failed requests release their reservation.
- **Reason:** The API already uses this atomic Mongo limiter for enhancement
  request points, so no second datastore, Python proxy, tokenizer, or new npm
  dependency is required. OpenMeter entitlements remain the preferred future
  boundary if paid plans, top-ups, rollover, or customer billing are approved;
  LiteLLM's Python proxy and budget manager would duplicate the current Node
  provider boundary.
- **Evidence:** The quota unit suite covers configuration bounds, hashed
  monthly identities, atomic reserve/refund/penalty/release behavior, missing
  provider usage, 429/503 failures, status reads, and account deletion. The
  complete no-database API suite reports 253 passing tests, the production
  deployment template check passes, CBoard Web reports 190 suites / 1,257
  tests / 72 snapshots plus a production build, and the WeChat client reports
  65 files / 284 tests plus its production compatibility and package-size
  gate.
- **Scope:** The allowance covers only sentence generation, resegmentation,
  dialect text normalization, image OCR, pictogram metadata suggestion, and
  legacy phrase editing. TTS, dialect audio ASR, background removal, local
  rules, matching, speech, boards, and receiver communication are unchanged.
  This is not pricing, a paid plan, payment processing, or invoicing. If actual
  provider usage exceeds the conservative reservation, that one request may
  create a bounded overage which is charged before later requests are blocked.
- **Update record:** 2026-07-22 13:41:56 | Codex (GPT-5.6) added the monthly
  Token reservation, settlement, usage status, production validation, and
  cross-platform fallback contract.

## Run the API Server

In a separate terminal tab/window, run the project server.

```bash
$ npm run dev
```

For automatically restarting the server when file changes in the directory are detected

or

```bash
$ npm run start
```

Both of them start a server process listening on port 10010. You will now be able to make calls to the API.

(If you are having trouble, make sure you have successfully installed the pre-requisites -- see "Pre-requisites" section above.)

## Verify Communication Support Persistence

- **Intent:** Verify the PicInterpreter communication settings and confirmed receiver records through the real public login, HTTP, and MongoDB paths.
- **Decision:** Keep the smoke checks outside production startup. Use a local-only seeded account, an ignored `.env.development`, and an isolated MongoDB database. Do not use route mocks or test-only authentication bypasses.
- **Reason:** Unit tests cannot reproduce two requests racing on the same MongoDB `serverVersion`; a repeatable runtime check can detect false-success responses and verify client retry inputs.
- **Evidence:** The receiver smoke covers authenticated creation, stale immutable-body conflict, additive feedback retry, a structured tombstone, stale resurrection prevention, and two simultaneous feedback requests. The settings smoke covers legacy `tuyujia` preservation and neutral `communicationSupport` dual-write readback.
- **Scope:** These commands are for local development and deployment verification only. They do not prove trusted public HTTPS, production email delivery, or two physical devices.

With MongoDB and the API server already running, seed the isolated account and
run both checks:

```bash
$ npm run seed:local-runtime-user
$ npm run verify:communication-support-settings
$ npm run verify:communication-receiver-sync
```

Override `LOCAL_RUNTIME_API_URL`, `LOCAL_RUNTIME_USER_EMAIL`, and
`LOCAL_RUNTIME_USER_PASSWORD` when the local runtime does not use the defaults.
Never commit the populated `.env.development` or reuse its credentials in
production.

## Verify Communication AI Token Quota Concurrency

- **Intent:** Verify that concurrent AI enhancement requests cannot consume more than the configured monthly token quota in real MongoDB storage.
- **Decision:** Reuse the production `communicationAiTokenQuota` service and its `rate-limiter-flexible` Mongo adapter through an explicit integration command; keep the default unit suite independent from Docker.
- **Reason:** A mocked limiter cannot reproduce the upstream consume-then-reject behavior or prove that rejected reservations, provider settlement, failures, and account deletion leave one correct atomic counter.
- **Evidence:** The integration gate reproduced a rejected third reservation leaving `120` consumed tokens instead of `80`; after refunding that rejected increment through the upstream atomic `reward()` operation, the same real Mongo scenario passes.
- **Scope:** This gate covers isolated Mongo concurrency and quota accounting only. It does not call an AI provider, establish pricing, deploy production MongoDB, or prove public HTTPS and client display.

With an isolated MongoDB already running, set its test-only URL and run:

```powershell
$env:COMMUNICATION_AI_TOKEN_QUOTA_MONGO_TEST_URL='mongodb://127.0.0.1:27029/cboard-api-token-quota-test'
npm run verify:communication-ai-token-quota-mongo
```

## Deploy with trusted HTTPS

- **Intent:** Give CBoard Web and the PicInterpreter mini program one production API origin for accounts, settings, confirmed receiver records, saved phrases, account-private archives, online pictograms, AI, and optional provider-backed media processing.
- **Decision:** Keep the existing CBoard API and MongoDB architecture. Run MongoDB on an internal-only network, run the API as a read-only non-root container, and expose only Caddy on ports 80/443. Caddy terminates TLS and actively checks the public `/health` readiness endpoint. All database credentials, JWT/session secrets, provider keys, and legal origins come from an ignored deploy-time environment file.
- **Reason:** A mini program requires a stable HTTPS backend, but moving secrets or provider calls into the client would break the existing front-end/back-end boundary. Reusing the CBoard API avoids a second backend while network isolation, fail-closed secrets, and readiness checks prevent a superficially running but unusable deployment.
- **Evidence:** `npm run verify:production-deploy-template`, Docker Compose expansion, a frozen-lockfile Node 22 image build, and a local three-container HTTPS smoke passed. The smoke returned `200/connected`, returned `503/degraded` after MongoDB stopped, and recovered to `200/connected` without restarting the API. Communication/deployment tests passed `94/94`; the full controller baseline reached `202 passing / 5 pending / 7 failing`, with the seven failures requiring unconfigured GPT, IPInfo, Azure Storage, or Google Play credentials.
- **Scope:** This bundle proves local production topology, TLS termination, health behavior, and database recovery. It does not create DNS, obtain a publicly trusted certificate in this repository, configure WeChat legal domains, supply production provider credentials, or replace two-device and weak-network acceptance testing.
- **Update record:** 2026-07-21 22:35:12 | Codex (GPT-5.6) added required Azure private-library storage and container validation to the production template. The private snapshot remains authenticated and is stored with `private, no-store`; this affects the account-private picture-library path only and does not make public pictogram media private.
- **Update record:** 2026-07-27 00:46:11 | Codex (GPT-5.6) added an independent account-private device-data archive. **Intent:** support reviewed cross-device recovery without changing normal Settings/event sync. **Decision:** reuse the same authenticated archive controller and private Azure container through `/communication/private-device-data`, while keeping separate Mongo metadata and deletion from `/communication/private-library`. **Reason:** communication history and corrections must not silently enter a picture-only backup, and the default CBoard library must not be uploaded repeatedly. **Evidence:** controller, route, account cleanup and index-readiness tests pass `19/19`; Swagger exposes metadata/upload/download/delete without a blob URL. **Scope:** this is code-level readiness only; real Azure, MongoDB, HTTPS, legal-domain and two-device verification remain deployment gates.
- **Update record:** 2026-07-27 02:19:50 | Codex (GPT-5.6) upgraded the account-private picture-library archive to client-side end-to-end encryption. **Intent:** prevent the API and storage provider from reading family pictures while preserving the independent picture-only recovery path. **Decision:** reuse the existing audited Noble `scrypt + XChaCha20-Poly1305` envelope and accept only `picinterpreter-private-picture-library-encrypted` contract v2 (`.pijenc`, `application/octet-stream`) at `/communication/private-library`; keep legacy metadata deletable but return `409 PRIVATE_PICTURE_LIBRARY_REENCRYPTION_REQUIRED` for legacy reads. **Reason:** private Blob access controls are not end-to-end encryption, and a second cryptographic format would increase audit and interoperability risk. **Evidence:** picture-library controller and route tests pass `14/14`; all no-external-service API controller tests pass `374/374`; CBoard passes `203 suites / 1401 tests / 72 snapshots` and production build; WeChat passes `76 files / 339 tests`, TypeScript, ESLint, boundary and production quality gates. **Scope:** the API stores opaque ciphertext for both independent archives; real Azure, MongoDB, HTTPS, legal-domain, password-loss and two-device verification remain deployment gates.

Create the ignored environment file, replace every placeholder with independent
production values, and validate it before starting any container:

```bash
cp deploy/.env.production.example deploy/.env.production
npm run verify:production-deploy
docker compose --env-file deploy/.env.production \
  -f deploy/docker-compose.production.yml up -d --build --wait
```

Point the `API_DOMAIN` DNS records to the host and allow inbound TCP 80/443
before starting Caddy. Caddy then obtains and renews the public certificate
automatically. See the official
[Caddy automatic HTTPS quick start](https://caddyserver.com/docs/quick-starts/reverse-proxy)
and [Caddy Docker image](https://hub.docker.com/_/caddy). After
`https://<API_DOMAIN>/health` returns `{"status":"ok","database":"connected"}`,
configure that exact HTTPS origin as the mini program request domain and build
the client with `TARO_APP_API_BASE_URL=https://<API_DOMAIN>`.

The production validator requires a real `AZURE_STORAGE_CONNECTION_STRING`
and an Azure-compatible `PRIVATE_LIBRARY_CONTAINER_NAME`. Keep the container
private with no anonymous access. Container creation intentionally omits the
`x-ms-blob-public-access` header because omission is Azure's private default;
do not send `publicAccessLevel: off`, which is an SDK response value rather
than a valid container-creation access level. Its name must use 3-63 lowercase
letters, numbers, or single hyphens, and must start and end with a letter or
number.
The Web and mini-program clients may upload two independently confirmed private
archives through the authenticated API. Before encryption, the picture-only
archive is a custom `PictureLibraryArchive v1` ZIP and the compact complete
private-device-data archive adds reviewed local communication sidecars without
the complete default CBoard library. Clients encrypt both ZIP payloads with a
user-controlled recovery password before upload, and this API accepts only the
opaque `PIE2EE01` envelope for either endpoint. The two endpoints keep distinct
format identifiers, metadata, blobs, and deletion actions. Passwords and
plaintext never reach the server, no blob URL or SAS is returned, and deleting
one archive does not delete the other. Legacy plaintext picture or device-data
snapshots remain deletable but must be replaced from the original device before
they can be restored.

The API and MongoDB intentionally publish no host ports. Stop the stack without
discarding its named data volumes with:

```bash
docker compose --env-file deploy/.env.production \
  -f deploy/docker-compose.production.yml down
```

## See API Paths

Swagger provides an interactive, browser-based editor. To visualize available API endpoints:

```bash
$ localhost:10010/docs/
```

That show API swagger editor (as shown below):

<img src='https://i.imgur.com/pt0eJVQ.png' width='600' alt='Cboard API Swagger'>

## Mailing system configuration

When a new user is created using the API, some verification emails are generated. To use a specific SMPT server, locally edit the following file to use values for an SMTP server you own:
**config/env/development.js**
And look for following config block:

```javascript
    emailTransport: {
        from: 'cboard@cboard.io',
        host: 'smtp.sendgrid.net',
        port: 465,
        secure: true,
        service: 'Sendgrid',
        auth: {
            user: 'apikey',
            pass: process.env.SENDGRID_API_KEY
        }
    }
```

## Testing

There are two types of tests in the repository, that can help you with the development and the debugging of the api service:

- Postman tests
- Mocha tests

### Postman tests

Postman is a scalable API testing tool, and we mainly use it for debugging and testing during the development process. These tests are loocated under the following folder:

```
cboard-api/test/postman
```

There, you can find a **postman collection file**. This file can be imported as a new collection into Postman and you will see a list of requests and tests that you can use to exercise the cboard API.
Note: you will need a deployed and well configured cboard-api instance running on your server to execute the tests against to.

![Cboard API Postman](public/images/postman.png)

### Mocha Tests

Mocha is a javascript framework for Node.js which allows Asynchronous testing. We have developed a few Mocha test suites that are running everytime a new Pull Request is created / updated.
The goal of these tests is to verify that all of the api calls are functional and you are not introducing regression bugs into the code base.
The command to run the Mocha tests is simply:

```
npm test
```

### Verify Communication AI HTTP Token Quota With Mongo

- **Intent:** verify the authenticated HTTP path from quota reservation through an OpenAI-compatible provider response to the Mongo usage ledger and current-user quota status.
- **Decision:** keep this as an explicit integration gate. It uses a caller-provided isolated Mongo URL and a local `nock` provider; it does not contact or bill a real AI provider.
- **Reason:** controller and limiter mocks cannot prove Swagger authorization, bearer authentication, provider retries, asynchronous settlement, Mongo persistence, and pre-provider rejection as one chain.
- **Evidence:** the gate accepts provider-reported usage of 25 and 60 tokens, releases a 40-token reservation after a provider failure, exposes 85/100 tokens to the same regular user, and rejects the next request with 429 before any provider call. `npm run test:unit` passes 376 tests.
- **Scope:** this verifies the development API, an isolated Mongo instance, and the OpenAI-compatible chat-completions contract. It does not verify production credentials, provider billing, public HTTPS, or WeChat legal domains.

```powershell
$env:COMMUNICATION_AI_HTTP_QUOTA_MONGO_TEST_URL='mongodb://127.0.0.1:27031/cboard-api-ai-http-quota-test'
$env:COMMUNICATION_AI_HTTP_QUOTA_TEST_PORT='19123'
npm run verify:communication-ai-http-quota-mongo
```

### Verify Visual Communication AI Through HTTP and Mongo

- **Intent:** verify authenticated OCR, editable pictogram metadata, and private AAC pictogram generation as one OpenAI-compatible visual chain.
- **Decision:** keep this as an explicit integration gate using a caller-provided isolated Mongo URL, the installed official OpenAI SDK, and local `nock` provider responses; it does not contact or bill a real model.
- **Reason:** isolated helper tests cannot prove JWT authorization, Swagger multipart handling, in-memory Data URLs, image-generation parameters, private response headers, PNG normalization, and Mongo quota settlement together.
- **Evidence:** anonymous OCR is rejected before the provider; authenticated OCR and metadata send only the exact in-memory image Data URL; generation sends a hashed user id and returns a bounded private 300x300 PNG; provider-reported usage settles to 77 tokens. The gate passes `3/3`, the related background-removal gate passes `2/2`, and `npm run test:unit` passes `377/377`.
- **Scope:** this verifies the development API and deterministic provider boundary. It does not verify production credentials, visual quality, provider retention, billing, public HTTPS, WeChat legal domains, or physical-device behavior.

```powershell
$env:COMMUNICATION_VISUAL_AI_HTTP_MONGO_TEST_URL='mongodb://127.0.0.1:27038/cboard-api-visual-ai-http-test'
$env:COMMUNICATION_VISUAL_AI_HTTP_TEST_PORT='19131'
npm run verify:communication-visual-ai-http-mongo
```

### Verify Phone Authentication Through Tencent SDK and Mongo

- **Intent:** verify the complete public HTTP paths for registration, purpose-bound phone login, and phone password reset instead of treating isolated controller tests as an authenticated account flow.
- **Decision:** keep this as an explicit integration gate. It uses a caller-provided isolated Mongo URL, the installed official Tencent Cloud SMS SDK, and local `nock` responses for `sms.tencentcloudapi.com`; it never sends a real SMS. The test uses the production Swagger, controller, service, repository, password hashing, JWT, and CBoard login code.
- **Reason:** unit tests cannot prove the official SDK request, Swagger routing, Mongo challenge persistence, purpose isolation, one-time token consumption, and JWT revocation operate together. A real provider call requires approved credentials and incurs external risk.
- **Evidence:** the gate observes signed `SendSms` requests with the expected E.164 phone, template parameters, and challenge context; rejects a wrong code and cross-purpose token use; completes registration and phone login; rejects token replay; resets the password; invalidates the old JWT and password; accepts the new password and JWT; and never returns the raw phone or `authVersion`. It passes `2/2` against isolated Mongo, while `npm run test:unit` passes `376/376`.
- **Scope:** this verifies development HTTP routing, the official SDK request contract, isolated Mongo persistence, purpose-bound one-time authentication, password hashing, and JWT revocation. It does not verify Tencent Cloud credentials, an approved SMS signature/template, provider delivery, a physical phone, public HTTPS, international numbers, or production anti-abuse controls.

```powershell
$env:PHONE_VERIFICATION_HTTP_MONGO_TEST_URL='mongodb://127.0.0.1:27033/cboard-phone-verification-http-test'
$env:PHONE_VERIFICATION_HTTP_TEST_PORT='19125'
npm run verify:phone-verification-http-mongo
```

### Verify Authenticated Volcengine TTS HTTP

- **Intent:** prove that an authenticated CBoard user can traverse the public speech route and the configured Volcengine V3 SSE provider without exposing the server key.
- **Decision:** use an explicit isolated-Mongo gate and a local deterministic SSE server; keep the production China-region endpoint and provider implementation unchanged.
- **Reason:** provider unit mocks do not prove Swagger scopes, bearer authentication, native HTTP transport, private response headers, or multi-frame audio assembly as one chain.
- **Evidence:** anonymous speech returns 403 before the provider; a regular user receives the exact MP3 bytes with `private, no-store`. The local server observes the bounded text, voice, rate, resource ID, request UUID and server-only API key. OpenClaw commit `642befa179d377395c1bb927f4bb562a29af9d67` Volcengine tests pass 22/22; cboard-api unit tests pass 376/376.
- **Scope:** this is an engineering contract test, not real Volcengine billing or audio-quality validation. It does not prove production credentials, entitlement, public HTTPS, WeChat legal domains, physical-device playback, latency or cost.

```powershell
$env:COMMUNICATION_VOLCENGINE_TTS_HTTP_MONGO_TEST_URL='mongodb://127.0.0.1:27034/cboard-volcengine-tts-http-test'
npm run verify:communication-volcengine-tts-http-mongo
```

## License

Code - [GPLv3](https://github.com/shayc/cboard/blob/master/LICENSE)  
Symbols - [CC BY-SA](https://creativecommons.org/licenses/by-sa/2.0/uk/)
