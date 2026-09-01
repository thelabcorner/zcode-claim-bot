export const APP_VERSION = '3.10.2';
export const PLATFORM = `${process.platform}-${process.arch}`;
export const BASE_URL = process.env.ZCODE_BASE_URL || 'https://zcode.z.ai';

export const CLAIM_ERROR_CODES = {
  1001: 'plan not found',
  1002: 'offer ended or unavailable',
  1003: 'already claimed',
  1004: 'account/client not eligible',
  1005: 'daily claim quota exhausted',
  3001: 'invalid request params',
  3007: 'captcha verification failed',
  401: 'login required / token expired',
};

const osCategory = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';

export function buildHeaders(token) {
  const h = {
    'User-Agent': `ZCode/${APP_VERSION}`,
    'HTTP-Referer': BASE_URL,
    'X-Title': 'Z Code@electron',
    'X-ZCode-App-Version': APP_VERSION,
    'X-Platform': PLATFORM,
    'X-Client-Language': 'en-US',
    'X-Client-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
    'X-Os-Category': osCategory,
  };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

export async function zcodeFetch(path, { token, method = 'GET', body, query, timeoutMs = 20000 } = {}) {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { ...buildHeaders(token), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON (waf page etc) */ }
    return { status: res.status, json, text: text.slice(0, 2000) };
  } finally {
    clearTimeout(t);
  }
}

export async function getClaimPreviews(token) {
  const r = await zcodeFetch('/api/v1/zcode-plan/billing/preview', {
    token,
    query: { app_version: APP_VERSION, platform: PLATFORM },
  });
  if (r.json && r.json.code === 0 && r.json.data) {
    const plans = r.json.data.plans ?? [];
    return {
      ok: true,
      plans: plans
        .filter(p => typeof p.plan_id === 'string' && p.plan_id.trim())
        .map(p => ({
          planId: p.plan_id.trim(),
          name: (p.name ?? '').trim(),
          description: (p.description ?? '').trim(),
          priority: Number.isFinite(p.priority) ? p.priority : 0,
          entitlements: (p.entitlements ?? [])
            .filter(e => typeof e.entitlement_id === 'string' && e.entitlement_id.trim())
            .map(e => ({
              entitlementId: e.entitlement_id.trim(),
              showName: (e.show_name ?? '').trim(),
              meter: (e.meter ?? '').trim(),
              unitType: (e.unit_type ?? '').trim(),
              grantUnits: Number.isFinite(e.grant_units) ? e.grant_units : 0,
              period: (e.period ?? '').trim(),
            })),
        })),
      raw: r.json,
    };
  }
  return { ok: false, status: r.status, code: r.json?.code, msg: r.json?.msg ?? r.text.slice(0, 200), raw: r.json };
}

export async function claimPlan(token, planId, { captchaVerifyParam, captchaRegion } = {}) {
  const headers = {};
  if (captchaVerifyParam) {
    headers['X-Aliyun-Captcha-Verify-Param'] = captchaVerifyParam;
    if (captchaRegion) headers['X-Aliyun-Captcha-Verify-Region'] = captchaRegion;
  }
  const r = await zcodeFetch('/api/v1/zcode-plan/billing/claim', {
    token,
    method: 'POST',
    body: { plan_id: planId },
    headers,
  });
  const code = r.json?.code;
  if (code === 0 && r.json?.data?.plan) {
    const p = r.json.data.plan;
    return {
      success: true,
      code: 0,
      msg: (r.json.msg ?? '').trim(),
      plan: {
        userPlanId: (p.user_plan_id ?? '').trim(),
        planId: p.plan_id?.trim() || planId,
        status: (p.status ?? '').trim(),
        startsAt: Number.isFinite(p.starts_at) ? p.starts_at : undefined,
        endsAt: Number.isFinite(p.ends_at) ? p.ends_at : undefined,
      },
    };
  }
  return {
    success: false,
    code: code ?? r.status ?? -1,
    msg: (r.json?.msg ?? '').trim() || CLAIM_ERROR_CODES[code] || `claim failed (http ${r.status})`,
    endsAt: Number.isFinite(r.json?.data?.plan?.ends_at) ? r.json.data.plan.ends_at : undefined,
  };
}
