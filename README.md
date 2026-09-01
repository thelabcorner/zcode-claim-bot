<div align="center">

# ZCode Auto-Claim Bot

**Unattended claimer for Z.ai / ZCode free-token drops, on your own account, with Telegram alerts.**

[![ci](https://github.com/thelabcorner/zcode-claim-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/thelabcorner/zcode-claim-bot/actions/workflows/ci.yml)
[![license: Unlicense](https://img.shields.io/badge/license-Unlicense-blue.svg)](LICENSE)
[![platform: Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?logo=windows&logoColor=white)](https://github.com/thelabcorner/zcode-claim-bot)
[![runtime: Node 18+](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-44cc11.svg)](package.json)
[![self-hosted CI](https://img.shields.io/badge/CI-self--hosted%20homelab-orange)](.github/workflows/ci.yml)

<br />

> [!WARNING]
> **This almost certainly violates the Z.ai / ZCode terms of service, and using it may get your account suspended or permanently banned.**
> It automates a first-come-first-served promotion and works around an anti-bot captcha.
> You accept that risk by running it. Read the [full reasoning](#terms-of-service-warning) first.

</div>

---

## Table of contents

- [What it does](#what-it-does)
- [Terms of Service warning](#terms-of-service-warning)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Detection vs claiming](#detection-vs-claiming)
- [Reverse engineering notes](#reverse-engineering-notes)
- [Configuration](#configuration)
- [Security](#security)
- [Known limits](#known-limits)
- [Contributing](#contributing)
- [License](#license)

---

## What it does

Z.ai periodically releases free inference-token packs ("Global Build", "Weekend Build") that
are claimed from inside the ZCode desktop app. Supplies are tiny and the packs are gone in
minutes, often before the app's cached offer card even refreshes.

This bot polls Z.ai's own offer endpoint directly, and the moment a new claimable plan appears
it claims it for you, using your real logged-in account, then messages you on Telegram.

| | |
|---|---|
| ⚡ **Detection** | ~2 min during known drop windows, 30 min otherwise |
| 🔐 **Auth** | your own ZCode JWT, read fresh every cycle |
| 🧩 **Captcha** | minted by the real ZCode renderer over CDP (traceless) |
| 📱 **Alerts** | new offer, wave change, claimed, exhausted, fault |
| 🛡 **Budgets** | 24 attempts/plan/day, 60 global/day, progressive backoff |
| 📦 **Deps** | zero npm packages, Node built-ins only |

---

## Terms of Service warning

This is not boilerplate. It is the honest risk assessment, and you should weigh it.

**Why this is risky:**

1. **Scarce promotional resource.** The drops are first-come-first-served with a hard pack
   cap. Automating a race for something scarce, that the operator intends as a goodwill
   gesture, is materially different from automating your own data.
2. **There is a captcha, and we route around it.** Z.ai attaches an Aliyun Captcha challenge
   to the claim endpoint. A captcha is an explicit signal the operator does not want automated
   clients there. This tool does not break the captcha; it borrows a genuine one from the real
   app. That is circumvention in spirit even though no challenge is defeated.
3. **Traffic is shaped to look like the client.** Matching headers, jittered timing, and
   single-use tokens are deliberate anti-detection measures, which is a worse position to
   defend than simply automating loudly.

**What this tool deliberately does not do:**

- claims at most **one pack per offer**, on **one account**
- no account creation, no multi-accounting, no rotating identities
- no resale, no token transfer, no sharing of claims
- no attempts to defeat, replay, or forge captcha challenges

That restraint keeps the blast radius small. **It does not make the tool compliant.**

If your use case has official support or an official API, use that. If you are not comfortable
with the risk, delete the directory now.

---

## Quick start

Requires Windows 10/11, Node 18+, and a ZCode desktop install that you have signed into at
least once (so the credential store exists).

```powershell
git clone https://github.com/thelabcorner/zcode-claim-bot.git
cd zcode-claim-bot
copy .env.example .env
# fill in TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
node src\run-once.mjs     # single pass, safe to try
node src\index.mjs        # continuous
```

### Telegram bot

1. Message [@BotFather](https://t.me/BotFather), `/newbot`, copy the API token.
2. Send your new bot any message (this is required, or `getUpdates` is empty).
3. Get your chat id: `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Put both values in `.env`.

### Run at login

```powershell
schtasks /Create /F /TN "ZCodeClaimBot" /SC ONLOGON /RL HIGHEST /TR '"powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "'"$(Resolve-Path .\start-bot.ps1)"'"'
```

---

## How it works

### 1. Detection (read-only, no side effects)

Each poll issues one `GET` against the same endpoint the desktop app uses for its card:

```
GET https://zcode.z.ai/api/v1/zcode-plan/billing/preview
      ?app_version=3.10.2&platform=win32-x64
Authorization: Bearer <your ZCode JWT>
X-Device-Mid / X-Request-Id / X-ZCode-App-Version / X-Platform  (app parity headers)
```

```json
{"code":0,"data":{"plans":[{
  "plan_id":"zcode-v3-start-plan-0901-2",
  "name":"ZCode Global Build",
  "priority":110,
  "entitlements":[{
    "entitlement_id":"ent_gb_0901_2_glm_5p3f",
    "show_name":"GLM-5.3-Flash",
    "grant_units":100000000,
    "period":"one_time"
  }]
}]}}
```

Because we hit the API directly instead of the app's cached view, the "don't see it? restart
the app" problem disappears. A bot never needs restarting.

### 2. The captcha problem

The claim endpoint is not open. Probing it directly:

| request | response |
|---|---|
| no captcha header | `400 {"code":3007,"msg":"captcha verify failed"}` |
| empty captcha header | `400 3007` |
| garbage captcha header | `400 3007`, then `429` after repeats |
| **valid captcha param** | passes, reaching the real check (e.g. `1005 quota exhausted`) |

The required `X-Aliyun-Captcha-Verify-Param` is a signed blob from the Aliyun Captcha 2.0 JS
SDK, which needs a real browser environment:

```
eyJjZXJ0aWZ5SWQiOi...  ->  {"certifyId":"...","sceneId":"11xygtvd","isSign":true,"securityToken":"..."}
```

Synthesising it in Node is not feasible, and running the SDK headless is a coin flip because
the risk engine grades the environment.

**Solution: ask the real app for one.** ZCode is Electron, so we launch (or attach to) it with
`--remote-debugging-port`, then drive its renderer over the Chrome DevTools Protocol through
the identical code path the Claim button uses:

```js
window.AliyunCaptchaConfig = { region: 'sgp', prefix: 'no8xfe' };
window.initAliyunCaptcha({ SceneId: '11xygtvd', mode: 'popup', element, button, ... });
instance.startTracelessVerification();   // no slider: risk engine passes it silently
// success(param) -> param.length ~= 280
```

The param is byte-for-byte the same kind your own clicks produced, minted in ~1.8s, inside the
environment Aliyun already trusts. ZCode must be running (the bot starts it if needed), but
you never touch it and no window interaction occurs.

### 3. The claim

```
POST /api/v1/zcode-plan/billing/claim
X-Aliyun-Captcha-Verify-Param: <minted, single use>
X-Aliyun-Captcha-Verify-Region: sgp
{"plan_id":"zcode-v3-start-plan-0901-2"}
```

| code | meaning | bot action |
|---|---|---|
| `0` | claimed | ✅ Telegram, mark terminal |
| `1001` | plan not found | stop |
| `1002` | offer ended / unavailable | ❌ terminal |
| `1003` | already claimed | terminal |
| `1004` | account or client version ineligible | ❌ terminal (usually a stale app version) |
| `1005` | quota exhausted | ⏳ keep watching, waves refill |
| `3001` | invalid request | stop |
| `3007` | captcha rejected | re-mint, pause after 3 |
| `401` | token expired | ⚠️ Telegram: sign in once |
| `429` | rate limited | global backoff 15 → 30 → 60 min |

---

## Architecture

| file | responsibility |
|---|---|
| `src/index.mjs` | service loop: run a pass, compute delay, sleep in slices |
| `src/run-core.mjs` | one pass: fetch offers, diff state, decide, claim, alert |
| `src/schedule.mjs` | hot windows from real drop history, plus jitter |
| `src/zcode-auth.mjs` | decrypt the JWT from ZCode's credential store |
| `src/zcode-client.mjs` | preview / claim / client-configs with app parity headers |
| `src/zcode-api.mjs` | endpoint and header definitions |
| `src/cdp.mjs` | minimal Chrome DevTools Protocol client over raw WebSocket |
| `src/captcha.mjs` | attach to ZCode, mint a captcha param in its renderer |
| `src/state.mjs` | durable JSON state (offers, hashes, budgets, backoffs) |
| `src/telegram.mjs` | alerts |
| `src/run-once.mjs` | single pass, for testing or a task scheduler |

Zero npm dependencies: Node 18+ built-in `fetch` and `WebSocket`.

---

## Detection vs claiming

These are **separate subsystems** with independent cadences, budgets, and failure modes. This
is the single most important design decision in the project.

```
┌─ DETECTION (every ~2 min) ──────────┐   ┌─ CLAIM (gated, on demand) ──────────┐
│ fetchPreview()  read-only GET       │   │ mint captcha via CDP                │
│ hash plan_id + entitlements         │   │ POST /billing/claim {plan_id}       │
│ diff vs data/state.json             │──▶│ fires only on a transition:         │
│ emit: new / changed / re-listed /   │   │   new-offer · content-changed ·     │
│       expired / unlisted / wait     │   │   re-listed · exhausted-retry       │
│ no token spend, no captcha, no risk │   │ obeys spacing + daily budgets       │
└─────────────────────────────────────┘   └─────────────────────────────────────┘
```

- **Detection** runs every 2 min in a hot window (or while an unclaimed offer is live), else
  30 min, jittered 15%.
- **Claiming** fires only on a transition. A poll that finds nothing new issues **zero** claim
  requests.

Measured on a live run: 7 polls produced 2 claim attempts.

### Identity model

A plan is keyed by two things, never by its display name:

1. `plan_id`: the offer and wave identity. `zcode-v3-start-plan-0901-2` is Sep 1, wave 2.
2. A **content hash**: `sha1(name + entitlements[entitlement_id | show_name | grant_units | period])`

The hash matters because a wave re-open can reuse the same `plan_id` with refreshed quota.
Same hash plus `1005` means "already handled, wait". A different hash is a genuine change and
triggers a claim plus an `OFFER CHANGED` alert. Offers vanishing from preview are marked
unlisted (paused wave, no claiming) and treated as a re-open if they return.

### Backoff, budgets, entropy

Repeated `1005` backs off progressively, tuned to the observed ~1h41m wave gap:

```
#1 ~4 min   #2 ~6.4 min   #3 ~10 min   #4 ~16 min   #5+ ~25 min (capped)
```

Ceilings: **24 attempts/plan/day**, **60 global/day**, `429` → global backoff 15 → 30 → 60 min.
Captcha rejection re-mints and pauses the plan 30 min after three failures.

Entropy, so traffic is irregular rather than mechanical:

- poll intervals jittered 15%
- claim retry delays jittered 35-40%
- random 0.25-1.6s pause before every request
- fresh UUID `X-Request-Id` and fresh single-use captcha param per attempt

### Schedule, derived from real drop history

| window (UTC) | why |
|---|---|
| Fri & Sat 15:30-17:45 | Weekend Build opens Sat 00:00 Beijing = Fri 16:00 UTC (Aug 15, Aug 21) |
| Sun 15:55-17:00 | weekend day 2/3, plus Mon 09:00 Beijing close |
| daily 13:25-17:40 | surprise drops posted 13:54Z and 15:35Z (Sep 1) |
| daily 20:30-23:59 | Beijing off-peak 22:00-08:00 (UTC+8), where retries land |
| daily 00:00-02:30 | 10 PM ET / 7 PM PT burn-deadline tail |
| otherwise | 30 min baseline |

All seven historical drop timestamps fall inside a hot window; a quiet Tuesday morning stays
on the baseline.

---

## Reverse engineering notes

How the protocol was recovered, so you can redo it after an app update:

1. Unpack `resources/app.asar` with `@electron/asar`. Main process code is in `out/main/` and
   `out/host/`; renderer in `out/renderer/assets/`.
2. Grep for `api/v1/` paths, which surfaces `zcode-plan/billing/{preview,claim}` and the
   service methods `getManualClaimPlanPreviews` and `claimManualPlan`.
3. Read the request builders to recover every header, the version constant (`gr` = `3.10.2`,
   confirmed against `out/metadata/build-meta.json`), and `X-Platform` (`win32-x64`).
4. Credentials live in `~/.zcode/v2/credentials.json`, encrypted as
   `enc:v1:<base64url(iv)>.<base64url(tag)>.<base64url(ciphertext)>` with AES-256-GCM. Key is
   `sha256(ZCODE_CREDENTIAL_SECRET)`, or absent that env var
   `sha256("zcode-credential-fallback:<platform>:<homedir>:<username>")`.
5. Confirm live traffic by pointing the app at a local logging forwarder. ZCode resolves its
   API origin from `ZCODE_PRODUCTION_BASE_URL`, so launching it with that variable set
   redirects the app's own calls through a plain HTTP listener. No TLS interception, no CA
   installation. Several real Claim clicks were captured this way, including the full captcha
   param and the `1005` responses.
6. The captcha is Aliyun 2.0 in **traceless** mode (`instance.startTracelessVerification()`),
   which is why the real app usually claims with no slider, and why borrowing the param works.

Evidence is in `reference-capture-log.jsonl`, gitignored because it contains your JWT and real
captcha params.

---

## Configuration

| key | default | meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | | from BotFather |
| `TELEGRAM_CHAT_ID` | | from `getUpdates` |
| `ZCODE_EXE` | auto-detected | ZCode.exe location |
| `ZCODE_CDP_PORT` | `9333` | port used to mint captchas |
| `ZCODE_AUTO_LAUNCH` | `true` | `false` = only claim when ZCode is already running |
| `POLL_IDLE_MINUTES` | `30` | baseline cadence |
| `POLL_HOT_MINUTES` | `2` | cadence in hot windows |
| `CLAIM_RETRY_TIMES` | `12` | attempts inside one claim burst |
| `CLAIM_RETRY_DELAY_SEC` | `20` | spacing inside a burst |
| `CLAIM_RETRY_EXHAUSTED` | `true` | `false` = claim each offer exactly once |
| `CLAIM_MODEL_FILTER` | | only claim matching models, e.g. `glm-5.3-flash` |
| `CLAIM_MIN_TOKENS` | `0` | ignore offers smaller than this |

---

## Security

- `.env` and `data/` are gitignored. **Never commit `.env`**: it holds your Telegram bot token,
  which grants full control of the bot. Telegram tokens pushed to public repos are scraped in
  seconds.
- The credential file is only ever read and decrypted in memory, never written.
- The ZCode JWT is re-read every cycle, so app-side session refresh is picked up automatically.
- The CDP debugging port binds to `127.0.0.1` only. It does permit local code execution in the
  ZCode renderer while open, so treat it as a local-only debug surface.
- CI fails the build if a Telegram token appears in tracked files.

To harden further: run under a dedicated low-privilege Windows account and keep the repo
private if you do not want your automation patterns public.

---

## Known limits

- The bot depends on the Aliyun traceless path passing. If Z.ai starts requiring interaction,
  claims fail and you get a Telegram notice, after which you click the in-app card yourself.
- The app version header is hardcoded to `3.10.2`. After a ZCode update, update it or risk
  `1004 ineligible`.
- Detection is limited to the preview endpoint. An offer announced only on social media and
  never published to the API will be missed.
- Single platform: Windows paths and the Electron launch path are Windows-specific.

---

## Contributing

Issues and PRs are welcome, with two firm boundaries, given the ToS situation above:

- **No multi-accounting, no claim sharing, no resale, no captcha forgery.** PRs adding those
  will be rejected.
- Keep the zero-dependency rule. Node built-ins only.

```powershell
node --check src\index.mjs     # syntax
node src\run-once.mjs          # one pass, no side effects beyond a possible claim
```

CI runs on a self-hosted homelab runner on push and PR to `main`:

```yaml
runs-on: [self-hosted, homelab]
if: github.actor == github.repository_owner
```

The owner guard exists because self-hosted runners execute arbitrary workflow code on real
hardware; forks do not get to run jobs there.

---

## License

[Unlicense](LICENSE): released into the public domain. Do anything you want with it.

The license covers the code, not the consequences. Automating a third-party service may breach
its terms and may get your account banned. That risk sits with whoever runs it.
