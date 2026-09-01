// Shared poll/claim logic used by run-once and the long-running service.
//
// Identity/hash model (so we never redundantly claim something unclaimable):
//   plan key       = plan_id                     (per-offer/wave id, e.g. ...0901-2)
//   content hash   = sha1(name + normalized entitlements[entitlementId|showName|grantUnits|period])
//                    -> catches wave re-opens that reuse the same plan_id
//   state flags    = claimed / expired / unlisted / backoffUntil / per-day budget
// Terminal states (never claim again): claimed, expired(ends_at passed), unavailable(1002), ineligible(1004)
// Retryable states: 1005 quota-exhausted (waves refill), 3007 captcha (fresh param), 429 (backoff)
import crypto from 'crypto';
import { setTimeout as sleep } from 'timers/promises';
import { CONFIG } from './config.mjs';
import { loadToken, loadUserInfo } from './zcode-auth.mjs';
import { fetchPreview, fetchClientConfigs, extractCaptchaConfig, postClaim } from './zcode-client.mjs';
import { mintCaptchaParam, ensureCdpReady } from './captcha.mjs';
import { getPlan, setPlan, getMeta, setMeta, bumpStat, listPlans } from './state.mjs';
import { sendTelegram, fmtClaimAlert, fmtNewOfferAlert } from './telegram.mjs';
import { isHotWindow, jitter } from './schedule.mjs';

export const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// ---- entropy helpers -------------------------------------------------------
const rand = (min, max) => min + Math.random() * (max - min);
const humanPause = () => sleep(rand(250, 1600)); // look like a person, not a loop
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

// per-plan attempt spacing: tighter while a drop window is open, loose otherwise.
// Observed wave gap was ~1h41m (wave1 13:54Z -> wave2 15:35Z), so on repeated
// 1005-quota-exhausted we back off progressively instead of hammering:
//   base 4m (hot) / 12m (idle), x1.6 per consecutive exhaustion, capped 25m/45m.
const BASE_SPACING_MS = () => (isHotWindow() ? 4 * 60_000 : 12 * 60_000);
const MAX_SPACING_MS = () => (isHotWindow() ? 25 * 60_000 : 45 * 60_000);
function exhaustedSpacing(streak) {
  const base = BASE_SPACING_MS() * Math.pow(1.6, Math.max(0, Math.min(streak, 6)));
  return Math.min(base, MAX_SPACING_MS());
}
const MAX_PER_PLAN_DAY = 24;   // hard ceiling of claim attempts per plan per day
const MAX_GLOBAL_DAY = 60;
const BACKOFF_429 = [15, 30, 60]; // minutes, escalates, caps

// ---- helpers ---------------------------------------------------------------
function planTotalTokens(p) { return p.entitlements.reduce((s, e) => s + (e.grantUnits || 0), 0); }
function planModelNames(p) { return [...new Set(p.entitlements.map(e => e.showName).filter(Boolean))]; }

export function contentHash(p) {
  const norm = {
    name: p.name ?? '',
    ents: [...p.entitlements]
      .map(e => [e.entitlementId, e.showName, e.grantUnits, e.period].join('|'))
      .sort()
      .join(';'),
  };
  return crypto.createHash('sha1').update(JSON.stringify(norm)).digest('hex').slice(0, 12);
}

function matchesFilter(p) {
  if (CONFIG.modelFilter.length) {
    const names = planModelNames(p).map(m => m.toLowerCase());
    if (!CONFIG.modelFilter.some(f => names.some(m => m.includes(f)))) return false;
  }
  if (CONFIG.minTokens > 0 && planTotalTokens(p) < CONFIG.minTokens) return false;
  return true;
}

function todayCount(p) {
  const d = p.daily;
  return d && d.date === dayKey() ? d.count : 0;
}
function bumpDaily(p) {
  const date = dayKey();
  return { date, count: todayCount(p) + 1 };
}

async function getCaptchaConfigCached(token) {
  let cfg = getMeta('captchaCfg');
  if (cfg?.sceneId && cfg?.prefix && cfg?.region) return cfg;
  const cc = await fetchClientConfigs(token);
  if (!cc.ok) return null;
  cfg = extractCaptchaConfig(cc.data);
  if (cfg?.sceneId) setMeta('captchaCfg', cfg);
  return cfg;
}

export async function attemptClaim(plan, { reason } = {}) {
  const prev = getPlan(plan.planId) ?? {};
  if (prev.claimed) return { skipped: 'already-claimed' };

  // global safety rails
  const g = getMeta('global') ?? {};
  if (g.backoffUntil && Date.now() < g.backoffUntil) return { skipped: 'global-backoff', until: g.backoffUntil };
  if ((g.daily?.date === dayKey() ? g.daily.count : 0) >= MAX_GLOBAL_DAY) return { skipped: 'global-daily-cap' };
  if (todayCount(prev) >= MAX_PER_PLAN_DAY) return { skipped: 'plan-daily-cap' };

  const token = loadToken();
  if (!token) {
    await sendTelegram('⚠️ ZCode bot: no auth token. Open ZCode and sign in.');
    return { error: 'no-token' };
  }
  const captchaCfg = await getCaptchaConfigCached(token);
  if (!captchaCfg?.sceneId || !captchaCfg?.prefix || !captchaCfg?.region) {
    await sendTelegram('⚠️ ZCode bot: Aliyun captcha config missing.');
    return { error: 'no-captcha-config' };
  }
  if (!(await ensureCdpReady().catch(() => false))) {
    await sendTelegram(`⚠️ ZCode bot: cannot reach ZCode CDP port ${CONFIG.cdpPort}; cannot mint captcha.`);
    return { error: 'no-cdp' };
  }

  log(`claim attempt [${reason ?? 'scheduled'}] on ${plan.planId}`);
  setPlan(plan.planId, {
    ...prev,
    planSnapshot: plan,
    contentHash: contentHash(plan),
    lastTried: new Date().toISOString(),
    lastClaimAt: Date.now(),
    attempts: (prev.attempts ?? 0) + 1,
    daily: bumpDaily(prev),
  });
  setMeta('global', { ...g, daily: bumpDaily(g) });

  let lastResp = null;
  let captchaFails = 0;
  const tries = Math.max(1, Math.min(CONFIG.claimRetryTimes, 6));
  for (let i = 0; i < tries; i++) {
    let param;
    try {
      await humanPause();
      param = await mintCaptchaParam(captchaCfg);
    } catch (e) {
      log('captcha mint error:', e.message);
      await sleep(jitter(4000, 0.4));
      continue;
    }
    const resp = await postClaim(token, plan.planId, param, captchaCfg.region);
    bumpStat('claims');
    lastResp = resp;
    const s = getPlan(plan.planId) ?? {};

    if (resp.ok) {
      const p0 = resp.result.plan ?? {};
      setPlan(plan.planId, { claimed: true, lastCode: 0, claimedAt: new Date().toISOString(), endsAt: p0.ends_at });
      await sendTelegram(fmtClaimAlert({
        mode: 'success',
        planId: plan.planId,
        planName: plan.name,
        modelNames: planModelNames(plan),
        totalTokens: planTotalTokens(plan),
        success: true,
        endsAt: p0.ends_at,
        attempts: getPlan(plan.planId)?.attempts ?? 1,
      }));
      return { ok: true };
    }

    setPlan(plan.planId, { lastCode: resp.code, lastMsg: resp.msg, endsAt: resp.endsAt ?? s.endsAt });
    log(`  -> code=${resp.code} msg=${resp.msg}`);

    // terminal: offer ended / not eligible / already claimed
    if (resp.code === 1003) { setPlan(plan.planId, { claimed: true }); return { ok: true, already: true }; }
    if (resp.code === 1002 || resp.code === 1004) {
      setPlan(plan.planId, { expired: true, terminal: 'unavailable' });
      if (!s.alerted?.expired) {
        await sendTelegram(fmtClaimAlert({
          mode: 'fail', planId: plan.planId, planName: plan.name,
          modelNames: planModelNames(plan), totalTokens: planTotalTokens(plan),
          success: false, msg: resp.msg, endsAt: resp.endsAt,
        }));
        setPlan(plan.planId, { alerted: { ...s.alerted, expired: true } });
      }
      return { unavailable: true };
    }

    // quota exhausted: normal for waves; stop this burst, poll loop retries later
    if (resp.code === 1005) {
      setPlan(plan.planId, { exhaustedStreak: (s.exhaustedStreak ?? 0) + 1 });
      if (!s.alerted?.exhausted) {
        await sendTelegram([
          '⏳ ZCODE OFFER — QUOTA EXHAUSTED',
          '──────────────',
          plan.name ? `offer: ${plan.name}` : null,
          `plan: \`${plan.planId}\``,
          `models: ${planModelNames(plan).join(', ')}`,
          resp.endsAt ? `expires: ${new Date(resp.endsAt * 1000).toLocaleString('sv-SE')}` : null,
          '',
          'Watching for wave re-opens; will retry at human-ish spacing.',
          new Date().toLocaleString('sv-SE'),
        ].filter(Boolean).join('\n'));
        setPlan(plan.planId, { alerted: { ...s.alerted, exhausted: true } });
      }
      return { exhausted: true, endsAt: resp.endsAt };
    }

    // captcha rejected -> fresh param, brief backoff; after 3, pause the plan
    if (resp.code === 3007) {
      captchaFails += 1;
      if (captchaFails >= 3) {
        setPlan(plan.planId, { backoffUntil: Date.now() + 30 * 60_000 });
        await sendTelegram('⚠️ ZCode bot: captcha rejected 3× — pausing claims 30m to be safe.');
        return { captcha: true };
      }
      await sleep(jitter(6000, 0.5));
      continue;
    }

    // rate limited -> escalate global backoff
    if (resp.status === 429) {
      const n = Math.min((getMeta('429count') ?? 0), BACKOFF_429.length - 1);
      const mins = BACKOFF_429[n];
      setMeta('429count', n + 1);
      setMeta('global', { ...(getMeta('global') ?? {}), backoffUntil: Date.now() + mins * 60_000 });
      log(`rate-limited; global backoff ${mins}m`);
      await sendTelegram(`⚠️ ZCode bot: hit 429 rate-limit — backing off ${mins}m.`);
      return { rateLimited: true };
    }

    await sleep(jitter(CONFIG.claimRetryDelaySec * 1000, 0.4));
  }
  return { exhausted: lastResp?.code === 1005, lastResp };
}

// Decide, per preview poll, what to do with each listed plan.
async function handlePlan(p, token) {
  const now = Date.now();
  const hash = contentHash(p);
  const s = getPlan(p.planId) ?? {};

  if (s.claimed) return 'claimed';
  if (s.expired) return 'terminal';
  if (s.backoffUntil && now < s.backoffUntil) return 'backoff';

  // ends_at passed -> terminal
  if (s.endsAt && s.endsAt * 1000 < now) {
    setPlan(p.planId, { expired: true, terminal: 'ends_at-passed' });
    return 'expired';
  }

  if (!s.planId) {
    setPlan(p.planId, {
      planId: p.planId, contentHash: hash,
      firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
      planSnapshot: p, alerted: {},
    });
    log('NEW OFFER:', p.planId, planModelNames(p).join(','), planTotalTokens(p).toLocaleString());
    await sendTelegram(fmtNewOfferAlert({
      planId: p.planId, planName: p.name, modelNames: planModelNames(p),
      totalTokens: planTotalTokens(p), priority: p.priority,
    }));
    await attemptClaim(p, { reason: 'new-offer' });
    return 'new';
  }

  // wave re-open under the same plan_id -> content changed
  if (s.contentHash && s.contentHash !== hash) {
    log('OFFER CONTENT CHANGED (possible wave re-open):', p.planId, `${s.contentHash} -> ${hash}`);
    setPlan(p.planId, {
      contentHash: hash,
      alerted: { ...(s.alerted ?? {}), exhausted: false, expired: false },
      exhaustedStreak: 0,
      unlistedAt: null,
      lastSeen: new Date().toISOString(),
    });
    await sendTelegram([
      '🔁 ZCODE OFFER CHANGED — retrying',
      '──────────────',
      `plan: \`${p.planId}\``,
      `${s.contentHash} → ${hash}`,
      `models: ${planModelNames(p).join(', ')}`,
      '', new Date().toLocaleString('sv-SE'),
    ].join('\n'));
    await attemptClaim(p, { reason: 'content-changed' });
    return 'changed';
  }

  setPlan(p.planId, { lastSeen: new Date().toISOString() });

  // never tried yet
  if (!s.lastClaimAt) { await attemptClaim(p, { reason: 'first-try' }); return 'first'; }

  // exhausted -> progressive backoff (waves refill ~1-2h apart), only while offer alive
  if (s.lastCode === 1005) {
    if (!CONFIG.retryExhausted) return 'watch-only';
    const spacing = jitter(exhaustedSpacing(s.exhaustedStreak ?? 1), 0.35);
    if (now - s.lastClaimAt >= spacing) { await attemptClaim(p, { reason: 'exhausted-retry' }); return 'retry'; }
    return 'wait';
  }
  return 'idle';
}

export async function runOnce() {
  bumpStat('polls');
  let token;
  try { token = loadToken(); } catch (e) { log('auth load failed:', e.message); return 2; }
  if (!token) return 2;

  await humanPause();
  const prev = await fetchPreview(token);
  if (!prev.ok) {
    log('preview failed:', prev.status, prev.code ?? '', prev.msg ?? '');
    setMeta('lastError', { when: new Date().toISOString(), status: prev.status, code: prev.code, msg: prev.msg });
    if (prev.status === 401 || prev.code === 401) {
      await sendTelegram('⚠️ ZCode bot: token rejected (401). Open ZCode and sign in again.');
    }
    return 1;
  }
  setMeta('lastError', null);

  const listed = (prev.plans ?? []).filter(matchesFilter);
  const listedIds = new Set(listed.map(p => p.planId));

  // mark plans that vanished from preview (paused wave) — keep watching, no claiming
  for (const [pid, s] of listPlans()) {
    if (s.claimed || s.expired) continue;
    if (!listedIds.has(pid)) {
      setPlan(pid, { unlistedAt: new Date().toISOString() });
    } else if (s.unlistedAt) {
      // reappeared after a pause-cycle -> treat as re-open
      setPlan(pid, {
        unlistedAt: null,
        alerted: { ...(s.alerted ?? {}), exhausted: false, expired: false },
        exhaustedStreak: 0,
      });
      log('OFFER RE-LISTED after pause:', pid);
      await sendTelegram(`🔁 ZCODE OFFER RE-LISTED — retrying\n──────────────\nplan: \`${pid}\``);
      await attemptClaim(s.planSnapshot ?? { planId: pid, name: s.planSnapshot?.name, entitlements: s.planSnapshot?.entitlements ?? [] }, { reason: 're-listed' });
    }
  }

  const actions = [];
  for (const p of listed) actions.push([p.planId, await handlePlan(p, token)]);
  if (listed.length) log('plans:', actions.map(([id, a]) => `${id.split('-').pop()}:${a}`).join(' '));

  const anyActiveUnclaimed = listed.some(p => {
    const s = getPlan(p.planId) ?? {};
    return !s.claimed && !s.expired;
  });
  return { anyActiveUnclaimed };
}
