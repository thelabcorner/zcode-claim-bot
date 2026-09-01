#!/usr/bin/env node
// Long-running mode: poll forever with schedule-aware intervals + entropy.
import { setTimeout as sleep } from 'timers/promises';
import { CONFIG } from './config.mjs';
import { nextPollMs, describeNow, jitter } from './schedule.mjs';
import { runOnce, log } from './run-core.mjs';
import { sendTelegram } from './telegram.mjs';
import { loadUserInfo } from './zcode-auth.mjs';

async function main() {
  log('zcode-claim-bot service mode');
  try {
    const user = loadUserInfo();
    if (user?.user_id) log('account:', user.user_id);
  } catch {}
  log('telegram:', CONFIG.telegramToken && CONFIG.telegramChatId ? 'configured' : 'NOT CONFIGURED (alerts off)');
  log(`cadence: idle ${CONFIG.pollIdleMin}m / hot ${CONFIG.pollHotMin}m (+entropy)`);
  log(`safety: plan cap ${24}/day, global cap ${60}/day, 429 backoff 15→30→60m`);
  await sendTelegram('🤖 ZCode auto-claim bot started.');

  for (;;) {
    let liveUnclaimed = false;
    try {
      const r = await runOnce();
      liveUnclaimed = r?.anyActiveUnclaimed ?? false;
    } catch (e) {
      log('cycle error:', e.message);
      await sendTelegram(`❌ ZCode bot error: ${e.message.slice(0, 350)}`).catch(() => {});
    }
    const wait = nextPollMs(CONFIG, { liveUnclaimedOffer: liveUnclaimed });
    log(`next poll in ${(wait / 60000).toFixed(1)} min (${describeNow()})`);
    // sleep in slices so SIGINT lands promptly
    let left = wait;
    while (left > 0) { const step = Math.min(left, 5000); await sleep(step); left -= step; }
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await sendTelegram('🛑 ZCode bot stopped.'); process.exit(0); });
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
