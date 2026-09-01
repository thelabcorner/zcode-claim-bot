import { runOnce, log } from './run-core.mjs';

const r = await runOnce();
log('once pass complete');
process.exit(typeof r === 'number' ? r : 0);
