import { randomUUID } from 'node:crypto';

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import type { DataLayer, GatewayClient } from 'quadra-data';

import type { IntakeConfig } from './config.js';
import { Store, type ActiveJob } from './store.js';
import { Payments } from './payments.js';
import { JobPaidWatcher, type JobPaidEvent } from './events.js';
import type { AgentNotifier } from './notify.js';

/** Parse a lifetime like "5m" / "30s" / "2h" / "1d" into milliseconds. */
export function parseLifetimeMs(lifetime: string): number {
    const m = /^(\d+)\s*(s|m|h|d)$/.exec(lifetime.trim());
    if (!m) throw new Error(`bad lifetime "${lifetime}"`);
    const n = Number(m[1]);
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
    return n * unit;
}

/** What an agent submits to open a job. */
export interface JobSubmission {
    template_id: string;
    lifetime: string;
    cost: number;
    asset: string;
}

/** The session handed back to the agent (relayed to the user, who pays it). */
export interface Session {
    session_id: string;
    job_id: string;
    agent_wallet: string;
    cost: number;
}

/** Orchestrates auth'd submissions, payment detection, delivery, and refunds. */
export class IntakeEngine {
    #dl: DataLayer;
    #gateway: GatewayClient;
    #config: IntakeConfig;
    #store: Store;
    #payments: Payments;
    #watcher: JobPaidWatcher;
    #sui: SuiJsonRpcClient;
    #timer: ReturnType<typeof setInterval> | undefined;
    #notifier: AgentNotifier | undefined;

    constructor(
        dl: DataLayer,
        gateway: GatewayClient,
        config: IntakeConfig,
        notifier?: AgentNotifier,
    ) {
        this.#dl = dl;
        this.#gateway = gateway;
        this.#config = config;
        this.#notifier = notifier;
        this.#sui = new SuiJsonRpcClient({
            url: getJsonRpcFullnodeUrl(dl.config.network),
            network: dl.config.network,
        });
        this.#store = new Store(config.redisUrl, config.pendingTtlMs);
        this.#payments = new Payments({
            sui: this.#sui,
            keypair: config.keypair,
            quadraPackageId: config.quadraPackageId,
            intakeCapId: config.intakeCapId,
            intakeConfigId: config.intakeConfigId,
        });
        this.#watcher = new JobPaidWatcher(
            this.#sui,
            this.#store,
            config.quadraPackageId,
            config.pollMs,
            (e) => this.#onJobPaid(e),
        );
    }

    start(): void {
        this.#watcher.start();
        this.#timer = setInterval(() => void this.#scanDeadlines(), this.#config.pollMs);
        console.log(
            `[intake] started: poll ${this.#config.pollMs}ms, network ${this.#dl.config.network}`,
        );
    }

    async stop(): Promise<void> {
        this.#watcher.stop();
        if (this.#timer) clearInterval(this.#timer);
        await this.#store.close();
    }

    /** Validate the template, mint ids, hold the job pending payment, return the session. */
    async submit(agentWallet: string, input: JobSubmission): Promise<Session> {
        const template = await this.#dl.jobTemplates.get(input.template_id);
        if (!template) throw new Error(`unknown template ${input.template_id}`);
        if (!input.lifetime) throw new Error('lifetime is required');
        if (!(input.cost > 0)) throw new Error('cost must be > 0');
        if (!template.allowed_assets.includes(input.asset)) {
            throw new Error(`asset ${input.asset} not allowed by template ${template.id}`);
        }
        if (parseLifetimeMs(input.lifetime) < template.minimum_lifetime) {
            throw new Error(`lifetime below the template minimum (${template.minimum_lifetime}ms)`);
        }

        const session: Session = {
            session_id: `sess_${randomUUID()}`,
            job_id: `job_${randomUUID()}`,
            agent_wallet: agentWallet,
            cost: input.cost,
        };
        await this.#store.putPending({
            ...session,
            template,
            lifetime: input.lifetime,
            asset: input.asset,
            created_at: Date.now(),
        });
        return session;
    }

    /**
     * The agent claims it delivered `job_id` (its sealed result is stored). Asks
     * the validator engine — which decrypts and has the evaluation engine check
     * the output — and on a valid verdict releases payment and schedules the
     * job's scoring at lifetime end. The intake engine never reads the result.
     */
    async deliver(
        jobId: string,
        agentWallet: string,
    ): Promise<{ released: boolean; reason?: string }> {
        const job = await this.#store.getActive(jobId);
        if (!job || job.agent_wallet !== agentWallet) {
            return { released: false, reason: 'unknown job' };
        }
        if (!job.releasable || !job.lifetime || !job.asset) {
            return { released: false, reason: 'job is not releasable' };
        }

        // The validator decrypts + has the eval engine check the output, and
        // returns the start data (price at delivery) for us to record.
        const verdict = await this.#askValidator(jobId, job.asset);
        if (!verdict.valid) {
            return { released: false, reason: verdict.reason ?? 'invalid result' };
        }

        if (!(await this.#store.tryLockSettle(jobId))) {
            return { released: false, reason: 'job is settling' }; // refund in progress
        }
        try {
            await this.#payments.release(job.escrow_id);
            await this.#store.removeActive(jobId);
            console.log(`[intake] released payment for ${jobId}`);
        } catch (error) {
            const reason = error instanceof Error ? error.message : 'release failed';
            console.error(`[intake] release ${jobId} failed:`, reason);
            return { released: false, reason };
        } finally {
            await this.#store.unlockSettle(jobId);
        }

        // Validated: register the job for scoring at lifetime end, carrying the
        // asset + start data so the scheduler can score against the delivery price.
        try {
            await this.#gateway.scheduleJob(jobId, job.paid_at_ms + parseLifetimeMs(job.lifetime), {
                asset: job.asset,
                data: verdict.start_data ?? {},
            });
        } catch (error) {
            console.error(
                `[intake] scheduling ${jobId} failed:`,
                error instanceof Error ? error.message : error,
            );
        }
        return { released: true };
    }

    /** Ask the validator engine (under the scheduler) whether the result is valid,
     * and for the start data captured at delivery. */
    async #askValidator(
        jobId: string,
        asset: string,
    ): Promise<{ valid: boolean; reason?: string; start_data?: Record<string, unknown> }> {
        const res = await fetch(`${this.#config.validatorUrl}/validate`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-quadra-internal': this.#config.internalToken,
            },
            body: JSON.stringify({ job_id: jobId, asset }),
        });
        if (!res.ok) throw new Error(`validator responded ${res.status}`);
        return (await res.json()) as {
            valid: boolean;
            reason?: string;
            start_data?: Record<string, unknown>;
        };
    }

    async status(): Promise<{ pending: number; active: number }> {
        return this.#store.counts();
    }

    /** A paid job becomes active with a delivery deadline; orphan payments (no
     * pending session) still get a deadline so the user is refunded after the wait. */
    async #onJobPaid(event: JobPaidEvent): Promise<void> {
        const pending = await this.#store.takePending(event.session_id);
        const deadline_ms = event.paid_at_ms + this.#config.jobTtlMs + this.#config.refundBufferMs;
        // Only a known session paid at (or above) its agreed cost is releasable;
        // underpaid or orphan payments are tracked solely so they get refunded.
        const releasable = pending != null && event.cost >= pending.cost;
        const job: ActiveJob = {
            job_id: event.job_id,
            session_id: event.session_id,
            agent_wallet: event.agent_wallet,
            escrow_id: event.escrow_id,
            cost: event.cost,
            paid_at_ms: event.paid_at_ms,
            deadline_ms,
            releasable,
            // Kept so `deliver` can validate + schedule the scoring window.
            ...(pending ? { lifetime: pending.lifetime, asset: pending.asset } : {}),
        };
        await this.#store.putActive(job);
        if (releasable) {
            // Tell the agent its job is paid so it can start working.
            this.#notifier?.jobPaid(event.agent_wallet, {
                session_id: event.session_id,
                job_id: event.job_id,
                escrow_id: event.escrow_id,
                cost: event.cost,
                paid_at_ms: event.paid_at_ms,
                deadline_ms,
            });
            console.log(
                `[intake] job ${job.job_id} paid; active until ${new Date(deadline_ms).toISOString()}`,
            );
        } else if (pending)
            console.warn(
                `[intake] job ${job.job_id} underpaid (${event.cost} < ${pending.cost}); will refund`,
            );
        else
            console.warn(
                `[intake] payment for unknown/expired session ${event.session_id}; will refund`,
            );
    }

    /** Refund jobs whose deadline passed without a delivery (the scheduler scores). */
    async #scanDeadlines(): Promise<void> {
        let due: string[];
        try {
            due = await this.#store.dueDeadlines(Date.now());
        } catch (error) {
            console.error(
                '[intake] deadline scan failed:',
                error instanceof Error ? error.message : error,
            );
            return;
        }
        for (const jobId of due) {
            if (!(await this.#store.tryLockSettle(jobId))) continue; // delivery in progress
            try {
                const job = await this.#store.getActive(jobId);
                if (!job) {
                    await this.#store.removeActive(jobId); // stale zset entry
                    continue;
                }
                await this.#payments.refundNotDelivered(job.escrow_id);
                await this.#store.removeActive(jobId); // settled — never refund twice
                // Scoring + failure recording for a missed delivery is the
                // scheduler's job (it owns agent_scores / delayed_failed_jobs).
                console.log(`[intake] refunded non-delivered ${jobId}`);
            } catch (error) {
                // e.g. ETooEarly under clock skew — leave it for the next scan.
                console.error(
                    `[intake] refund ${jobId} failed:`,
                    error instanceof Error ? error.message : error,
                );
            } finally {
                await this.#store.unlockSettle(jobId);
            }
        }
    }
}
