import { CONFIG } from './config.mjs';

const API = () => `https://api.telegram.org/bot${CONFIG.telegramToken}`;

export async function sendTelegram(text, { parseMode = 'Markdown' } = {}) {
  if (!CONFIG.telegramToken || !CONFIG.telegramChatId) return { skipped: true };
  try {
    const res = await fetch(`${API()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.telegramChatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });
    const j = await res.json();
    return j.ok ? j.result : { error: j.description };
  } catch (e) {
    return { error: e.message };
  }
}

export function fmtClaimAlert({ mode, planId, planName, modelNames, totalTokens, success, msg, endsAt, attempts }) {
  const lines = [];
  lines.push(mode === 'success' ? '✅ ZCODE CLAIM — SUCCESS' : '❌ ZCODE CLAIM — FAILED');
  lines.push('──────────────');
  if (planName) lines.push(`offer: ${planName}`);
  lines.push(`plan: \`${planId}\``);
  if (modelNames?.length) lines.push(`models: ${modelNames.join(', ')}`);
  if (totalTokens) lines.push(`tokens: ${totalTokens.toLocaleString()}`);
  if (endsAt) lines.push(`expires: ${new Date(endsAt * 1000).toLocaleString('sv-SE')}`);
  if (!success) lines.push(`reason: ${msg}`);
  if (attempts && attempts > 1) lines.push(`attempts: ${attempts}`);
  lines.push('');
  lines.push(new Date().toLocaleString('sv-SE'));
  return lines.join('\n');
}

export function fmtNewOfferAlert({ planId, planName, modelNames, totalTokens, priority }) {
  return [
    '🆕 ZCODE OFFER DETECTED — claiming now',
    '──────────────',
    planName ? `offer: ${planName}` : null,
    `plan: \`${planId}\``,
    modelNames?.length ? `models: ${modelNames.join(', ')}` : null,
    totalTokens ? `tokens: ${totalTokens.toLocaleString()}` : null,
    priority != null ? `priority: ${priority}` : null,
    '',
    new Date().toLocaleString('sv-SE'),
  ].filter(Boolean).join('\n');
}
