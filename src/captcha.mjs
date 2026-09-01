// Shopify: mint Aliyun captcha verify params using ZCode's OWN renderer via CDP.
// Strategy:
//  - Ensure ZCode is running with --remote-debugging-port=<port>.
//  - Attach to first page target, load/inject the Aliyun SDK, init with the real
//    (region, prefix, sceneId) from client/configs, then run traceless verification.
//  - Return captchaVerifyParam string exactly like the app's renderer produces.
import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { CONFIG } from './config.mjs';
import { bumpStat } from './state.mjs';
import { evalInPage } from './cdp.mjs';

let proxyPid = null;
let startedByUs = false;

export function cdpUrl() { return `http://127.0.0.1:${CONFIG.cdpPort}`; }

async function cdpAlive() {
  try {
    const r = await fetch(`${cdpUrl()}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

function zcodeRunning() {
  try {
    const out = childProcess.execFileSync('powershell',
      ['-NoProfile', '-Command', '(Get-Process ZCode -ErrorAction SilentlyContinue | Measure-Object).Count'],
      { encoding: 'utf8', timeout: 4000 });
    return Number(out.trim()) > 0;
  } catch { return false; }
}

function launchZCode() {
  console.log('[captcha] launching ZCode with CDP on :' + CONFIG.cdpPort);
  const p = childProcess.spawn(CONFIG.zcodeExe, [`--remote-debugging-port=${CONFIG.cdpPort}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  p.unref();
  proxyPid = p.pid;
  startedByUs = true;
}

export async function ensureCdpReady({ timeoutMs = 40000 } = {}) {
  if (await cdpAlive()) return true;
  if (!CONFIG.autoLaunch) return false;
  if (!fs.existsSync(CONFIG.zcodeExe)) {
    throw new Error('ZCode.exe not found at ' + CONFIG.zcodeExe);
  }
  if (!zcodeRunning()) launchZCode();
  else console.log('[captcha] ZCode running but CDP not yet ready, waiting…');
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1000);
    if (await cdpAlive()) return true;
  }
  return false;
}

const ALIYUN_SDK = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';

export async function mintCaptchaParam({ region, prefix, sceneId }) {
  const ready = await ensureCdpReady();
  if (!ready) throw new Error('CDP not reachable (ZCode should be running with --remote-debugging-port=' + CONFIG.cdpPort + ')');

  const expr = `(async () => {
    const log = [];
    const t0 = Date.now();
    document.querySelectorAll('[id^="__zc_captcha_"]').forEach(e => e.remove());
    const CTR = '__zc_captcha_' + Math.random().toString(36).slice(2, 8);
    const BTN = CTR + '_btn', EL = CTR + '_el';
    const ctr = document.createElement('div');
    ctr.id = CTR;
    ctr.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;overflow:hidden;z-index:-1;';
    ctr.innerHTML = '<div id="' + EL + '"></div><button id="' + BTN + '" type="button">v</button>';
    document.body.appendChild(ctr);

    let inst = null, param = null, failInfo = null;
    try {
      if (typeof window.initAliyunCaptcha !== 'function') {
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = ${JSON.stringify(ALIYUN_SDK)};
          s.onload = res;
          s.onerror = () => rej(new Error('aliyun sdk load failed'));
          document.head.appendChild(s);
        });
        log.push('sdk loaded');
      }
      window.AliyunCaptchaConfig = { region: ${JSON.stringify(region)}, prefix: ${JSON.stringify(prefix)} };
      window.initAliyunCaptcha({
        SceneId: ${JSON.stringify(sceneId)},
        mode: 'popup',
        element: '#' + EL,
        button: '#' + BTN,
        showErrorTip: false,
        getInstance(i) { inst = i; log.push('instance ready'); },
        success(p) { param = p; log.push('success len=' + p.length); },
        fail(e) { failInfo = e; log.push('fail ' + JSON.stringify(e)); },
        onError(e) { failInfo = e; log.push('onerror ' + JSON.stringify(e)); },
      });
      for (let i = 0; i < 100 && !inst; i++) await new Promise(r => setTimeout(r, 100));
      if (!inst) throw new Error('no instance');
      if (typeof inst.startTracelessVerification === 'function') inst.startTracelessVerification();
      else if (typeof inst.show === 'function') inst.show();
      for (let i = 0; i < 220 && !param && !failInfo; i++) await new Promise(r => setTimeout(r, 50));
      ctr.remove();
      if (param) return { ok: true, param, ms: Date.now() - t0, log };
      return { ok: false, reason: 'verify failed', failInfo, log, ms: Date.now() - t0 };
    } catch (e) {
      ctr.remove();
      return { ok: false, reason: String(e && e.message || e), log, ms: Date.now() - t0 };
    }
  })()`;

  const out = await evalInPage(CONFIG.cdpPort, expr, { timeoutMs: 30000 });
  if (!out?.ok || !out.param) throw new Error('captcha failed: ' + JSON.stringify(out));
  bumpStat('captchas');
  return out.param;
}

export function cleanupCdpOwnedProcesses() {
  if (startedByUs && proxyPid) {
    console.log('[captcha] closing bot-managed ZCode instance (pid', proxyPid + ')');
    try { process.kill(proxyPid); } catch {}
    startedByUs = false;
  }
}

export function setCdpOwnedPid(pid) {
  proxyPid = pid;
  startedByUs = true;
}
