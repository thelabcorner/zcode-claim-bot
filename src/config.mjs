// Central config: file `.env` (simple key=value) + process env override.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function loadDotEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      out[m[1]] = m[2].trim();
    }
  } catch {}
  return out;
}

const env = { ...loadDotEnv(path.join(root, '.env')), ...process.env };

function defaultZcodeExe() {
  const base = path.join(env.LOCALAPPDATA || '', 'Programs', 'ZCode');
  try {
    if (fs.existsSync(path.join(base, 'ZCode.exe'))) return path.join(base, 'ZCode.exe');
  } catch {}
  return 'ZCode.exe';  // fall back to PATH
}

export const CONFIG = {
  telegramToken: env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: env.TELEGRAM_CHAT_ID || '',
  zcodeExe: env.ZCODE_EXE || defaultZcodeExe(),
  cdpPort: Number(env.ZCODE_CDP_PORT || 9333),
  autoLaunch: String(env.ZCODE_AUTO_LAUNCH ?? 'true') !== 'false',
  pollIdleMin: Number(env.POLL_IDLE_MINUTES || 30),
  pollHotMin: Number(env.POLL_HOT_MINUTES || 2),
  claimRetryTimes: Number(env.CLAIM_RETRY_TIMES || 12),
  claimRetryDelaySec: Number(env.CLAIM_RETRY_DELAY_SEC || 20),
  // keep retrying an offer that says "quota exhausted" (waves re-open) until it ends.
  // set false to only claim once per offer (zero retry spam).
  retryExhausted: String(env.CLAIM_RETRY_EXHAUSTED ?? 'true') !== 'false',
  modelFilter: (env.CLAIM_MODEL_FILTER || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  minTokens: Number(env.CLAIM_MIN_TOKENS || 0),
  dataDir: path.join(root, 'data'),
};
