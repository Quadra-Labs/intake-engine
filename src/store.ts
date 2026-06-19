import { Redis } from 'ioredis';
import type { JobTemplate } from 'quadra-data';

/** A job proposed by an agent, waiting for the user to pay (15-min window). */
export interface PendingJob {
    session_id: string;
    job_id: string;
    agent_wallet: string;
    template: JobTemplate;
    lifetime: string;
    asset: string;
    cost: number;
    created_at: number;
    /** Scoreless jobs are paid on delivery (result stored), never validated/scored. */
    scoreless: boolean;
}

/** A paid job awaiting delivery (30-min window). */
export interface ActiveJob {
    job_id: string;
    session_id: string;
    agent_wallet: string;
    escrow_id: string;
    cost: number;
    paid_at_ms: number;
    deadline_ms: number;
    /** False for underpaid or orphan payments — never release, only refund. */
    releasable: boolean;
    /** Scoreless: paid on delivery (result stored), never validated/scored. */
    scoreless: boolean;
    /** The agreed lifetime (e.g. "5m"); absent for orphan/scoreless payments. Used
     * to schedule the job's scoring window once the delivery validates. */
    lifetime?: string;
    /** The asset the job targets; absent for orphan/scoreless payments. */
    asset?: string;
}

const PENDING = (s: string): string => `intake:pending:${s}`;
const ACTIVE = (j: string): string => `intake:job:${j}`;
const DEADLINES = 'intake:deadlines';
const CURSOR = 'intake:events:cursor';
const SETTLE = (j: string): string => `intake:settling:${j}`;

/** Redis-backed store for pending + active jobs and the event cursor. */
export class Store {
    #redis: Redis;
    #pendingTtlMs: number;

    constructor(redisUrl: string, pendingTtlMs: number) {
        this.#redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
        this.#pendingTtlMs = pendingTtlMs;
    }

    async putPending(job: PendingJob): Promise<void> {
        await this.#redis.set(
            PENDING(job.session_id),
            JSON.stringify(job),
            'PX',
            this.#pendingTtlMs,
        );
    }

    /** Atomically read-and-remove a pending session. Null if it expired/never existed. */
    async takePending(sessionId: string): Promise<PendingJob | null> {
        const raw = await this.#redis.getdel(PENDING(sessionId));
        return raw ? (JSON.parse(raw) as PendingJob) : null;
    }

    async putActive(job: ActiveJob): Promise<void> {
        // Keep the record a little past its deadline so the scan can act on it.
        const px = Math.max(job.deadline_ms - Date.now() + 600_000, 1);
        await this.#redis
            .multi()
            .set(ACTIVE(job.job_id), JSON.stringify(job), 'PX', px)
            .zadd(DEADLINES, job.deadline_ms, job.job_id)
            .exec();
    }

    async getActive(jobId: string): Promise<ActiveJob | null> {
        const raw = await this.#redis.get(ACTIVE(jobId));
        return raw ? (JSON.parse(raw) as ActiveJob) : null;
    }

    async removeActive(jobId: string): Promise<void> {
        await this.#redis.multi().del(ACTIVE(jobId)).zrem(DEADLINES, jobId).exec();
    }

    /** Active job ids whose delivery deadline is at or before `now`. */
    async dueDeadlines(now: number): Promise<string[]> {
        return this.#redis.zrangebyscore(DEADLINES, 0, now);
    }

    async getCursor(): Promise<string | null> {
        return this.#redis.get(CURSOR);
    }

    async setCursor(cursor: string): Promise<void> {
        await this.#redis.set(CURSOR, cursor);
    }

    /** One-shot lock so a job's refund and release can never both run. */
    async tryLockSettle(jobId: string): Promise<boolean> {
        const res = await this.#redis.set(SETTLE(jobId), '1', 'PX', 60_000, 'NX');
        return res === 'OK';
    }

    async unlockSettle(jobId: string): Promise<void> {
        await this.#redis.del(SETTLE(jobId));
    }

    async counts(): Promise<{ pending: number; active: number }> {
        const [pending, active] = await Promise.all([
            this.#countKeys('intake:pending:*'),
            this.#redis.zcard(DEADLINES),
        ]);
        return { pending, active };
    }

    async #countKeys(pattern: string): Promise<number> {
        let count = 0;
        let cursor = '0';
        do {
            const [next, keys] = await this.#redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
            count += keys.length;
            cursor = next;
        } while (cursor !== '0');
        return count;
    }

    async close(): Promise<void> {
        await this.#redis.quit();
    }
}
