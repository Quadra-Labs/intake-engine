import type { SuiJsonRpcClient, EventId, SuiEvent } from '@mysten/sui/jsonRpc';

import { isTransient } from './rpcRetry.js';
import type { Store } from './store.js';

/** Decoded `quadra::intake::JobPaid`. */
export interface JobPaidEvent {
    escrow_id: string;
    session_id: string;
    job_id: string;
    agent_wallet: string;
    cost: number;
    paid_at_ms: number;
}

export type JobPaidHandler = (event: JobPaidEvent) => Promise<void>;

/**
 * Polls the chain for `intake::JobPaid` events, persisting a cursor in Redis so
 * restarts neither miss nor replay. Polling (not the gRPC stream) is used on
 * purpose: this process also submits transactions, which the scheduler found can
 * kill a long-lived stream.
 */
export class JobPaidWatcher {
    #sui: SuiJsonRpcClient;
    #store: Store;
    #eventType: string;
    #pollMs: number;
    #handler: JobPaidHandler;
    #timer: ReturnType<typeof setInterval> | undefined;
    #running = false;
    #busy = false;
    /** Consecutive transient poll failures; used to log a degraded upstream once, not every tick. */
    #transientStreak = 0;

    constructor(
        sui: SuiJsonRpcClient,
        store: Store,
        quadraPackageId: string,
        pollMs: number,
        handler: JobPaidHandler,
    ) {
        this.#sui = sui;
        this.#store = store;
        this.#eventType = `${quadraPackageId}::intake::JobPaid`;
        this.#pollMs = pollMs;
        this.#handler = handler;
    }

    start(): void {
        if (this.#running) return;
        this.#running = true;
        this.#timer = setInterval(() => void this.#poll(), this.#pollMs);
        void this.#poll();
    }

    stop(): void {
        this.#running = false;
        if (this.#timer) clearInterval(this.#timer);
        this.#timer = undefined;
    }

    async #poll(): Promise<void> {
        if (this.#busy) return;
        this.#busy = true;
        try {
            let cursor = await this.#ensureCursor();
            for (;;) {
                const page = await this.#sui.queryEvents({
                    query: { MoveEventType: this.#eventType },
                    cursor,
                    order: 'ascending',
                    limit: 50,
                });
                for (const ev of page.data) await this.#handler(decode(ev));
                if (page.data.length > 0 && page.nextCursor) {
                    cursor = page.nextCursor;
                    await this.#store.setCursor(JSON.stringify(cursor));
                }
                if (!page.hasNextPage) break;
            }
            if (this.#transientStreak > 0) {
                console.log(
                    `[intake] event poll recovered after ${this.#transientStreak} transient failure(s)`,
                );
                this.#transientStreak = 0;
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : error;
            if (isTransient(error)) {
                // Self-healing upstream blip (public RPC 5xx / reset). The cursor is persisted and
                // the next tick retries, so log only the first of a streak to avoid flooding.
                if (this.#transientStreak === 0) {
                    console.warn(
                        `[intake] event poll degraded (transient upstream), suppressing repeats until recovery: ${msg}`,
                    );
                }
                this.#transientStreak++;
            } else {
                console.error('[intake] event poll failed:', msg);
            }
        } finally {
            this.#busy = false;
        }
    }

    /** Resume from the saved cursor, or seed from the latest event on first run
     * (so we never replay the chain's whole history). */
    async #ensureCursor(): Promise<EventId | null> {
        const stored = await this.#store.getCursor();
        if (stored) return JSON.parse(stored) as EventId;
        // Seed from the event BEFORE the latest (descending, take the 2nd). The cursor is
        // EXCLUSIVE, so seeding from the latest event would skip it — which silently drops the
        // first payment on a fresh package. Taking the 2nd-latest leaves the most recent event
        // to be processed; with fewer than 2 events, start from the beginning (null).
        const recent = await this.#sui.queryEvents({
            query: { MoveEventType: this.#eventType },
            order: 'descending',
            limit: 2,
        });
        const seed = recent.data[1]?.id ?? null;
        if (seed) await this.#store.setCursor(JSON.stringify(seed));
        return seed;
    }
}

function decode(ev: SuiEvent): JobPaidEvent {
    const p = ev.parsedJson as Record<string, string>;
    return {
        escrow_id: p.escrow_id ?? '',
        session_id: p.session_id ?? '',
        job_id: p.job_id ?? '',
        agent_wallet: p.agent_wallet ?? '',
        cost: Number(p.cost ?? 0),
        paid_at_ms: Number(p.paid_at_ms ?? 0),
    };
}
