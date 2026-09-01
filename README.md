# ZCode Auto-Claim Bot

An unattended watcher for Z.ai / ZCode free-token drops. It polls the same offer surface the
desktop app uses, and the instant a new claimable plan appears it claims it **on your behalf,
using your own logged-in account**, then pings you on Telegram.

Read the [Terms of Service warning](#terms-of-service-warning) before you run this.

```
   Z.ai offer surface                    your machine                         you
   ────────────────────                  ────────────                         ───
   GET  billing/preview  ───── poll ──▶  detect new plan_id                   
                                          │                                   
                                          ├─ new / changed / re-listed?        
                                          │        │                           
                                          │        ▼                           
   Aliyun Captcha (traceless) ◀── CDP ─── ZCode renderer mints param           
                                          │        │                           
   POST billing/claim ────────────────────┘        │                           
                                                   ▼                           
                                          Telegram  ────────────────────────▶  ✅ / ⏳ / ❌
```

---

## Terms of Service warning

**This probably violates the Z.ai / ZCode terms of service, and using it may get your account
suspended or banned. You accept that risk by running it.**

Why it is risky, stated plainly:

- The drops are **first come, first served** promotions with a hard cap on packs. Automating
  a race for a scarce promotional resource is materially different from automating something
  you already own.
- Z.ai explicitly attaches an **Aliyun Captcha** challenge to the claim endpoint. A captcha is
  a signal that the operator does not want automated clients on that endpoint. This bot works
  around it not by breaking the captcha, but by borrowing a genuine one from the real app.
- We send traffic that is deliberately shaped to look like the desktop client (matching
  headers, jittered timing). Deliberately evading detection is a worse position to be in than
  merely automating.
- The bot claims **at most one pack per offer**, on **one account**, and never creates
  accounts, never shares claims, and never resells anything. That restraint is deliberate. It
  does not make the tool compliant, it only keeps the blast radius small.

If a formal permission or an official API exists for your use case, use that instead. If you
are uncomfortable with the risk, delete the directory.

---

## How it works

### 1. Detection (read only, no side effects)

Every poll issues one `GET`:

```
GET https://zcode.z.ai/api/v1/zcode-plan/billing/preview
      ?app_version=3.10.2&platform=win32-x64
Authorization: Bearer <your ZCode JWT>
X-Device-Mid, X-Request-Id, X-ZCode-App-Version, X-Platform, ... (app parity headers)
```

which returns the currently listed offers:

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

This is exactly the call the desktop app makes for the claimable card. Because we call it
directly we have none of the app's caching problems, which is why users are told "don't see
it? restart the app". A bot never needs restarting.

### 2. The captcha problem, and the solution

The claim endpoint is **not** open. Probing it directly:

| request | response |
|---|---|
| no captcha header | `400 {"code":3007,"msg":"captcha verify failed"}` |
| empty captcha header | `400 {"code":3007,"msg":"captcha verify failed"}` |
| garbage captcha header | `400 3007`, then `429` from repeated bad attempts |
| **valid captcha param** | passes through to the real check, e.g. `1005 quota exhausted` |

So a valid `X-Aliyun-Captcha-Verify-Param` is mandatory. That param is a signed blob produced
by the Aliyun Captcha 2.0 JavaScript SDK, which needs a real browser environment:

```
eyJjZXJ0aWZ5SWQiOi...  →  {"certifyId":"...","sceneId":"11xygtvd","isSign":true,"securityToken":"..."}
```

Synthesising it in Node is not feasible, and running the SDK in a headless browser is a coin
flip because the risk engine grades the environment.

**Solution: ask the real app for one.** ZCode is Electron, so we launch (or attach to) it with
`--remote-debugging-port`, then speak the Chrome DevTools Protocol to its renderer and run the
identical code path the Claim button uses:

```js
window.AliyunCaptchaConfig = { region: 'sgp', prefix: 'no8xfe' };
window.initAliyunCaptcha({ SceneId: '11xygtvd', mode: 'popup', element, button, ... });
instance.startTracelessVerification();   // no slider: risk engine passes it silently
// success(param) -> param.length ≈ 280
```

The result is byte-for-byte the same kind of param your own clicks produced, minted in about
1.8 seconds, in the environment Aliyun already trusts. ZCode must be running (the bot starts
it itself if needed), but you never touch it and no window interaction happens.

### 3. The claim

```
POST /api/v1/zcode-plan/billing/claim
Content-Type: application/json
X-Aliyun-Captcha-Verify-Param: <minted, single use>
X-Aliyun-Captcha-Verify-Region: sgp
{"plan_id":"zcode-v3-start-plan-0901-2"}
```

Response codes, mapped from the app's own i18n table:

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
| `src/index.mjs` | service loop: run a pass, compute next delay, sleep in slices |
| `src/run-core.mjs` | one pass: fetch offers, diff against state, decide, claim, alert |
| `src/schedule.mjs` | hot windows derived from real drop history, plus jitter |
| `src/zcode-auth.mjs` | decrypt the JWT out of ZCode's credential store |
| `src/zcode-client.mjs` | preview / claim / client-configs with app parity headers |
| `src/cdp.mjs` | minimal Chrome DevTools Protocol client over raw WebSocket |
| `src/captcha.mjs` | launch or attach to ZCode, mint a captcha param in its renderer |
| `src/state.mjs` | durable JSON state (offers, hashes, budgets, backoffs) |
| `src/telegram.mjs` | alerts |
| `src/run-once.mjs` | single pass, for testing or a cron/task scheduler |

Zero npm dependencies. Node 18+ (uses built in `fetch` and `WebSocket`).

### Detection and claiming are separate subsystems

They have independent cadences, independent budgets and independent failure modes. Detection
is a cheap read only `GET`; claiming is rate limited, captcha gated and budgeted.

- **Detection** runs every 2 minutes in a hot window (or whenever an unclaimed offer is
  live), and every 30 minutes otherwise, jittered 15 percent.
- **Claiming** only fires on a transition: new plan id, changed content hash, re-listed
  offer, or an elapsed exhaustion backoff. A poll that finds nothing new issues **zero**
  claim requests.

Verified on this machine: 6 polls produced exactly 1 claim attempt.

### Identity model (the part that prevents redundant claims)

A plan is keyed by two things, never by its display name:

1. `plan_id`, the offer and wave identity. `zcode-v3-start-plan-0901-2` is September 1,
   wave 2.
2. A **content hash**:
   `sha1(name + entitlements[entitlement_id | show_name | grant_units | period])`

The hash matters because a wave re-open can reuse the same `plan_id` with refreshed quota.
Same hash plus `1005` means "already handled, wait". A different hash is a genuine change and
triggers a claim plus a `🔁 OFFER CHANGED` alert. Offers that vanish from preview are marked
unlisted (paused wave, no claiming) and treated as a re-open if they come back.

### Backoff, budgets, entropy

Repeated `1005` (quota exhausted) backs off progressively, tuned to the observed wave gap of
roughly 1 hour 41 minutes between wave 1 and wave 2 on September 1:

```
#1 ~4 min   #2 ~6.4 min   #3 ~10 min   #4 ~16 min   #5+ ~25 min (capped)
```

Hard ceilings: **24 claim attempts per plan per day**, **60 global per day**, `429` triggers a
global backoff of 15 then 30 then 60 minutes. Captcha rejection is retried with a freshly
minted param and pauses the plan for 30 minutes after three failures.

To make the traffic look unmechanical rather than robotic:

- poll intervals jittered 15 percent
- claim retry delays jittered 35 to 40 percent
- a random 0.25 to 1.6 second pause precedes every request
- a fresh UUID `X-Request-Id` and a fresh single use captcha param per attempt

### Schedule, derived from actual drop history

| window (UTC) | why |
|---|---|
| Fri and Sat 15:30 to 17:45 | Weekend Build opens Saturday 00:00 Beijing, which is Friday 16:00 UTC (August 15, August 21) |
| Sun 15:55 to 17:00 | second and third weekend day, plus the Monday 09:00 Beijing close |
| daily 13:25 to 17:40 | surprise drops posted 13:54Z and 15:35Z on September 1 |
| daily 20:30 to 23:59 | Beijing off peak 22:00 to 08:00 (UTC+8), where retries historically land |
| daily 00:00 to 02:30 | the 10 PM ET / 7 PM PT burn deadline tail |
| otherwise | 30 minute baseline |

All seven historical drop timestamps were checked against these windows and every one lands
in a hot window, while a quiet Tuesday morning stays on the baseline.

---

## Reverse engineering notes

How the protocol was recovered, in case you need to redo it after an update:

1. `resources/app.asar` unpacked with `@electron/asar`. Main process code lives in
   `out/main/` and `out/host/`, renderer in `out/renderer/assets/`.
2. Grepped for `api/v1/` paths, which surfaced `zcode-plan/billing/{preview,claim}` and the
   surrounding service methods `getManualClaimPlanPreviews` and `claimManualPlan`.
3. Read the request builders to recover every header, the version constant (`gr` = `3.10.2`,
   confirmed against `out/metadata/build-meta.json`), and `X-Platform` (`win32-x64`).
4. Credentials live in `~/.zcode/v2/credentials.json`, encrypted as
   `enc:v1:<base64url(iv)>.<base64url(tag)>.<base64url(ciphertext)>` with AES-256-GCM. The key
   is `sha256(ZCODE_CREDENTIAL_SECRET)` or, when that env var is absent,
   `sha256("zcode-credential-fallback:<platform>:<homedir>:<username>")`.
5. Confirmed the live traffic by pointing the app at a local logging forwarder. ZCode resolves
   its API origin from `ZCODE_PRODUCTION_BASE_URL`, so launching it with that environment
   variable set redirects the app's own calls through a plain HTTP listener. No TLS
   interception or CA installation needed. Several real Claim clicks were captured this way,
   including the full captcha param and the `1005 quota exhausted` responses.
6. Discovered the captcha is Aliyun 2.0 with a **traceless** mode
   (`instance.startTracelessVerification()`), which is why the real app usually claims without
   ever showing a slider, and why borrowing the param from the app works.

Capture evidence is in `reference-capture-log.jsonl`, which is gitignored because it contains
your JWT and captcha params.

---

## Setup

```powershell
cd path\to\zcode-claim-bot
copy .env.example .env        # then fill in Telegram values
node src\run-once.mjs        # single pass
node src\index.mjs           # continuous
```

Requires Windows, Node 18+, and a ZCode desktop install that has been signed into at least
once so the credentials file exists.

### Telegram

1. Message `@BotFather`, create a bot, copy the API token.
2. Send your new bot any message.
3. Fetch your chat id from `https://api.telegram.org/bot<TOKEN>/getUpdates`.
4. Put both values in `.env`.

### Autostart

```powershell
# from inside the repo folder:
schtasks /Create /F /TN "ZCodeClaimBot" /SC ONLOGON /RL HIGHEST /TR '"powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "'"$(Resolve-Path .\start-bot.ps1)"'"'
```

---

## Configuration

| key | default | meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | | from BotFather |
| `TELEGRAM_CHAT_ID` | | from `getUpdates` |
| `ZCODE_EXE` | default install path | ZCode.exe location |
| `ZCODE_CDP_PORT` | `9333` | port used to mint captchas |
| `ZCODE_AUTO_LAUNCH` | `true` | set `false` to only claim when ZCode is already running |
| `POLL_IDLE_MINUTES` | `30` | baseline cadence |
| `POLL_HOT_MINUTES` | `2` | cadence in hot windows |
| `CLAIM_RETRY_TIMES` | `12` | attempts inside one claim burst |
| `CLAIM_RETRY_DELAY_SEC` | `20` | spacing inside a burst |
| `CLAIM_RETRY_EXHAUSTED` | `true` | `false` = claim each offer exactly once |
| `CLAIM_MODEL_FILTER` | | only claim matching models, e.g. `glm-5.3-flash` |
| `CLAIM_MIN_TOKENS` | `0` | ignore offers smaller than this |

---

## Security

- `.env` and `data/` are gitignored. **Never commit `.env`**, it contains your Telegram bot
  token, which grants full control of the bot.
- The credential file is never written to; the bot reads and decrypts it in memory each pass.
- The ZCode JWT is read fresh on every cycle, so when the desktop app refreshes its session
  the bot picks up the new token automatically.
- The CDP debugging port is bound to `127.0.0.1` only, and it does allow local code execution
  in the ZCode renderer while open. Treat it as a local-only debug surface.

---

## Known limits

- The bot depends on the Aliyun traceless path passing. If Z.ai changes the captcha to always
  require interaction, claims will fail and you will get a Telegram notice, after which you
  click the in-app card yourself.
- The app version header is hardcoded to `3.10.2`. After a ZCode update, update it too or risk
  `1004 ineligible`.
- Detection is limited to what the preview endpoint exposes. An offer that is only announced
  on social media and never published to the API will be missed.
