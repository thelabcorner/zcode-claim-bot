// Schedule derived from the actual @zcode_ai drop history (all times UTC):
//   R1 2026-08-15 16:00Z open (Sat 00:00 cn) · announced 13:43Z
//   R2 2026-08-21 16:00Z open (Sat 00:00 cn) · announced 13:07Z
//   Surprise 2026-09-01: w1 post 13:54Z · w2 post 15:35Z (+1h41m)
//   Beijing off-peak retry success window: 22:00–08:00 (+8) => 14:00–00:00Z
//   Burn deadline: 10pm ET => 02:00Z (next day)
// Strategy: preview polls are cheap/read-only => poll fast in windows,
// slow elsewhere. Claim attempts are spaced per-plan, see run-core.mjs.

const WINDOWS = [
  { days: [5], from: '15:30', to: '17:45', label: 'weekend-build opening (Sat 00:00 cn)' },
  { days: [6], from: '15:30', to: '17:45', label: 'weekend-build day-2' },
  { days: [0], from: '15:55', to: '17:00', label: 'weekend-build day-3 / close' },
  { days: ['*'], from: '13:25', to: '17:40', label: 'surprise-drop watch (US-morning posts)' },
  { days: ['*'], from: '20:30', to: '23:59', label: 'beijing-night wave re-opens' },
  { days: ['*'], from: '00:00', to: '02:30', label: '10pm-ET burn tail' },
];

function toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }

export function currentHotWindow(now = new Date()) {
  const dow = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (const w of WINDOWS) {
    const inDay = w.days.includes('*') || w.days.includes(dow);
    if (!inDay) continue;
    if (mins >= toMin(w.from) && mins <= toMin(w.to)) return w.label;
  }
  return null;
}

export function isHotWindow(now) { return currentHotWindow(now) !== null; }

export function jitter(ms, pct = 0.15) { return Math.round(ms * (1 + (Math.random() * 2 - 1) * pct)); }

// Active-but-unclaimed offer overrides to hot cadence; checked by run-core.
export function nextPollMs(cfg = {}, { liveUnclaimedOffer = false } = {}) {
  const hotMs = (cfg.pollHotMin ?? 2) * 60_000;
  const idleMs = (cfg.pollIdleMin ?? 30) * 60_000;
  if (liveUnclaimedOffer || isHotWindow()) return jitter(hotMs);
  return jitter(idleMs);
}

export function describeNow() {
  const w = currentHotWindow();
  return `${new Date().toISOString()} hot=${w ? '"' + w + '"' : 'no'}`;
}
