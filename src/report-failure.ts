import 'dotenv/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './config';
import { EVERY_WATCH, reportHealth, runLogUrl, WORKFLOW } from './health';
import { notify } from './notifier';

// The workflow runs this when a step around the tracker fails (installing, testing), so you hear
// about it like any other problem: once, then every 12 hours until a run gets through again — and
// then that it is fixed. FAILED_STEP names the step.
const HEALTH_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'state', 'health.json');
const step = process.env.FAILED_STEP?.trim() || 'A setup step';
const env = loadEnv();
const outcome = await reportHealth(HEALTH_PATH, {
  problems: [{ key: WORKFLOW, label: EVERY_WATCH, detail: `“${step}” failed, so nothing was checked` }],
  checked: new Set([WORKFLOW]), now: new Date(), runUrl: runLogUrl(),
}, (html) => notify(env, html, { preview: false }), { save: !env.dryRun });
console.log(`Failed step "${step}": report ${outcome}.`);
// The workflow then sends a plain message itself rather than lose this one.
if (outcome === 'failed') process.exitCode = 1;
