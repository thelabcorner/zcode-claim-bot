import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { BASE_URL, APP_VERSION, PLATFORM, zcodeFetch, getClaimPreviews, claimPlan, CLAIM_ERROR_CODES } from './zcode-api.mjs';

const telemetryPath = path.join(os.homedir(), '.zcode', 'v2', 'telemetry-state.json');

export function getDeviceMid() {
  try {
    const j = JSON.parse(fs.readFileSync(telemetryPath, 'utf8'));
    if (j?.deviceMid) return j.deviceMid;
  } catch {}
  return undefined;
}

// Full app-parity headers beyond zcode-api.mjs defaults.
export function buildAppHeaders(token) {
  const h = {
    'X-Release-Channel': 'production',
    'X-Os-Version': os.version?.() ?? 'Windows 11 Pro',
    'X-Request-Id': crypto.randomUUID(),
    'Accept': '*/*',
    'Accept-Language': '*',
  };
  const mid = getDeviceMid();
  if (mid) h['X-Device-Mid'] = mid;
  return h;
}

// Re-export with header merge
export async function fetchPreview(token) {
  const base = new URL(BASE_URL + '/api/v1/zcode-plan/billing/preview');
  base.searchParams.set('app_version', APP_VERSION);
  base.searchParams.set('platform', PLATFORM);
  const res = await fetch(base, {
    headers: {
      'User-Agent': `ZCode/${APP_VERSION}`,
      'HTTP-Referer': BASE_URL,
      'X-Title': 'Z Code@electron',
      'X-ZCode-App-Version': APP_VERSION,
      'X-Platform': PLATFORM,
      'X-Client-Language': 'en-US',
      'X-Client-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
      'X-Os-Category': process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...buildAppHeaders(token),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (res.status === 200 && json?.code === 0 && json.data) {
    return { ok: true, data: json.data, plans: normalizePlans(json.data), raw: json };
  }
  return { ok: false, status: res.status, code: json?.code ?? null, msg: json?.msg ?? text.slice(0, 300), raw: json };
}

export function normalizePlans(data) {
  const plans = Array.isArray(data.plans) ? data.plans : [];
  return plans
    .map(p => ({
      planId: typeof p.plan_id === 'string' ? p.plan_id.trim() : '',
      name: (p.name ?? '').trim(),
      description: (p.description ?? '').trim(),
      priority: Number.isFinite(p.priority) ? p.priority : 0,
      entitlements: (Array.isArray(p.entitlements) ? p.entitlements : [])
        .filter(e => typeof e?.entitlement_id === 'string')
        .map(e => ({
          entitlementId: e.entitlement_id.trim(),
          showName: (e.show_name ?? '').trim(),
          model: (e.meter ?? '').trim(),
          unitType: (e.unit_type ?? '').trim(),
          grantUnits: Number.isFinite(e.grant_units) ? e.grant_units : 0,
          period: (e.period ?? '').trim(),
          effectiveAt: Number.isFinite(e.effective_at) ? e.effective_at : undefined,
        })),
    }))
    .filter(p => p.planId);
}

export async function postClaim(token, planId, captchaVerifyParam, captchaRegion) {
  const url = BASE_URL + '/api/v1/zcode-plan/billing/claim';
  const body = JSON.stringify({ plan_id: planId });
  const headers = {
    'User-Agent': `ZCode/${APP_VERSION}`,
    'HTTP-Referer': BASE_URL,
    'X-Title': 'Z Code@electron',
    'X-ZCode-App-Version': APP_VERSION,
    'X-Platform': PLATFORM,
    'X-Client-Language': 'en-US',
    'X-Client-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
    'X-Os-Category': process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...buildAppHeaders(token),
    ...(captchaVerifyParam ? {
      'X-Aliyun-Captcha-Verify-Param': captchaVerifyParam,
      ...(captchaRegion ? { 'X-Aliyun-Captcha-Verify-Region': captchaRegion } : {}),
    } : {}),
  };
  const res = await fetch(url, { method: 'POST', headers, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const code = json?.code;
  if (res.status === 200 && code === 0 && json?.data?.plan) {
    return { ok: true, result: { success: true, code: 0, msg: json.msg ?? '', plan: json.data.plan }, raw: json, status: res.status };
  }
  return {
    ok: false,
    status: res.status,
    code: code ?? null,
    msg: json?.msg ?? CLAIM_ERROR_CODES[code] ?? text.slice(0, 200),
    raw: json,
    endsAt: json?.data?.plan?.ends_at,
  };
}

export async function fetchClientConfigs(token) {
  const url = new URL(BASE_URL + '/api/v1/client/configs');
  url.searchParams.set('app_version', APP_VERSION);
  url.searchParams.set('platform', PLATFORM);
  const res = await fetch(url, {
    headers: {
      'User-Agent': `ZCode/${APP_VERSION}`,
      'HTTP-Referer': BASE_URL,
      'X-Title': 'Z Code@electron',
      'X-ZCode-App-Version': APP_VERSION,
      'X-Platform': PLATFORM,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...buildAppHeaders(token),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (res.status === 200 && json?.code === 0 && json.data) {
    return { ok: true, data: json.data, raw: json };
  }
  return { ok: false, status: res.status, code: json?.code ?? null, msg: json?.msg ?? text.slice(0, 200) };
}

export function extractCaptchaConfig(data) {
  return data?.configs?.captcha ?? null;
}
