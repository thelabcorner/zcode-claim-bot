// Durable JSON state: offers seen, claimed, notify dedup, last poll info.
import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.mjs';

const FILE = path.join(CONFIG.dataDir, 'state.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {
      // plan_id -> { firstSeen, lastTried, attempts, lastCode, success, planSnapshot }
      plans: {},
      // last-ish client config hash, to detect new drops
      lastConfigHash: '',
      lastPollOkAt: null,
      lastError: null,
      notifiedClaimSuccess: {},
      notifiedNewPlan: {},
      stats: { polls: 0, claims: 0, captchas: 0 },
    };
  }
}

let state = load();

function persist() {
  try {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[state] persist failed:', e.message);
  }
}

export function getPlan(pid) { return state.plans[pid]; }
export function listPlans() { return Object.entries(state.plans); }
export function setPlan(pid, patch) {
  state.plans[pid] = { ...(state.plans[pid] ?? {}), ...patch };
  persist();
}
export function setMeta(key, value) { state[key] = value; persist(); }
export function getMeta(key) { return state[key]; }
export function bumpStat(key) { state.stats[key] = (state.stats[key] ?? 0) + 1; persist(); }
export function stats() { return { ...state.stats, lastPollOkAt: state.lastPollOkAt, lastError: state.lastError }; }
