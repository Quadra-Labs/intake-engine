// evalWake.ts — best-effort "wake the evaluation enclave" signal. A paid job will be delivered
// soon, and at delivery the validator needs the (possibly stopped) eval Nitro instance UP to
// capture start_data + validate. So on JobPaid we start the instance via the AWS CLI. Opt-in: a
// no-op unless EVAL_INSTANCE_ID is set, so dev/e2e are unaffected. NEVER throws; NEVER blocks the
// payment flow (fire-and-forget). The power-manager poller handles stopping the instance when idle.

import { execFile } from 'node:child_process';

const INSTANCE_ID = process.env.EVAL_INSTANCE_ID?.trim();
const REGION = process.env.EVAL_AWS_REGION?.trim() || process.env.AWS_REGION?.trim() || 'us-east-1';

// `start-instances` is idempotent (harmless on an already-running instance), but don't spam AWS.
const THROTTLE_MS = 60_000;
let lastWakeMs = 0;

/** Start the eval instance so it's up by delivery time. No-op when EVAL_INSTANCE_ID is unset. */
export function wakeEval(): void {
    if (!INSTANCE_ID) return;
    const now = Date.now();
    if (now - lastWakeMs < THROTTLE_MS) return;
    lastWakeMs = now;
    execFile(
        'aws',
        ['ec2', 'start-instances', '--instance-ids', INSTANCE_ID, '--region', REGION],
        { timeout: 15_000 },
        (err) => {
            if (err) console.warn(`[intake] eval wake failed: ${err.message}`);
            else console.log(`[intake] eval wake sent (${INSTANCE_ID})`);
        },
    );
}
