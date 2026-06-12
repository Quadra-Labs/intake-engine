/**
 * Component checks runnable without testnet: agent auth (signature + freshness +
 * registration) always; the Redis store if a Redis is reachable. The full
 * on-chain release/refund is verified on testnet (see the plan).
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Redis } from 'ioredis';
import type { DataLayer, GatewayClient } from 'quadra-data';

import { AuthManager } from '../src/auth.js';
import { IntakeEngine, parseLifetimeMs } from '../src/engine.js';
import { Store } from '../src/store.js';
import type { IntakeConfig } from '../src/config.js';

async function testAuth(): Promise<void> {
    const kp = new Ed25519Keypair();
    const addr = kp.toSuiAddress();
    // Minimal DataLayer stub: only `agents.get` is used by AuthManager.
    const dl = {
        agents: { get: async (w: string) => (w === addr ? { wallet: w } : undefined) },
    } as unknown as DataLayer;
    const auth = new AuthManager(dl, 60_000);

    const body = JSON.stringify({ template_id: 't1', lifetime: '5m', cost: 1000 });
    const ts = Date.now();
    const { signature } = await kp.signPersonalMessage(new TextEncoder().encode(`${ts}.${body}`));

    assert.equal(await auth.verify(body, ts, signature), addr, 'recovered wallet matches signer');
    await assert.rejects(auth.verify(body, ts - 600_000, signature), /stale/, 'stale ts rejected');

    const stranger = new Ed25519Keypair();
    const ts2 = Date.now();
    const sig2 = (await stranger.signPersonalMessage(new TextEncoder().encode(`${ts2}.${body}`)))
        .signature;
    await assert.rejects(auth.verify(body, ts2, sig2), /not registered/, 'unregistered rejected');
    console.log('  auth: OK');
}

async function redisReachable(url: string): Promise<boolean> {
    const probe = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
    });
    try {
        await probe.connect();
        await probe.ping();
        await probe.quit();
        return true;
    } catch {
        probe.disconnect();
        return false;
    }
}

async function testStore(): Promise<void> {
    const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    if (!(await redisReachable(url))) {
        console.log(`  store: SKIPPED (no Redis at ${url})`);
        return;
    }
    const store = new Store(url, 60_000);
    const sid = `sess_${Date.now()}`;
    const jid = `job_${Date.now()}`;

    await store.putPending({
        session_id: sid,
        job_id: jid,
        agent_wallet: '0xa',
        template: {
            id: 't1',
            category: 'finance',
            description: '',
            output: {},
            evaluator_id: 'btc-price-guess',
        },
        lifetime: '5m',
        cost: 1000,
        created_at: Date.now(),
    });
    assert.equal((await store.takePending(sid))?.job_id, jid, 'pending round-trips');
    assert.equal(await store.takePending(sid), null, 'pending removed after take');

    const past = Date.now() - 1000;
    await store.putActive({
        job_id: jid,
        session_id: sid,
        agent_wallet: '0xa',
        escrow_id: '0xe',
        cost: 1000,
        paid_at_ms: past,
        deadline_ms: past,
        releasable: true,
    });
    assert.ok((await store.dueDeadlines(Date.now())).includes(jid), 'due deadline listed');
    assert.equal((await store.getActive(jid))?.escrow_id, '0xe', 'active round-trips');

    assert.equal(await store.tryLockSettle(jid), true, 'first settle lock acquired');
    assert.equal(await store.tryLockSettle(jid), false, 'second settle lock blocked');
    await store.unlockSettle(jid);

    await store.removeActive(jid);
    assert.equal(await store.getActive(jid), null, 'active removed');
    assert.ok(!(await store.dueDeadlines(Date.now())).includes(jid), 'deadline cleared');
    await store.close();
    console.log('  store: OK');
}

/** Stub validator: answers /validate with a canned verdict, recording calls. */
function stubValidator(
    port: number,
    verdict: { valid: boolean; reason?: string },
    calls: string[],
): Promise<Server> {
    return new Promise((resolve) => {
        const server = createServer((req, res) => {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                calls.push(JSON.parse(body).job_id);
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify(verdict));
            });
        });
        server.listen(port, () => resolve(server));
    });
}

/** Deliver-flow gating without chain access: unknown jobs, foreign agents, and
 * validator rejections must all return without releasing (which needs the chain). */
async function testDeliver(): Promise<void> {
    const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    if (!(await redisReachable(url))) {
        console.log(`  deliver: SKIPPED (no Redis at ${url})`);
        return;
    }
    assert.equal(parseLifetimeMs('5m'), 300_000, 'parses lifetime');

    const port = 5099;
    const calls: string[] = [];
    const validator = await stubValidator(port, { valid: false, reason: 'missing field' }, calls);
    const config = {
        keypair: Ed25519Keypair.generate(),
        quadraPackageId: '0x2',
        intakeCapId: '0x2',
        intakeConfigId: '0x2',
        internalToken: 'tok',
        validatorUrl: `http://localhost:${port}`,
        redisUrl: url,
        port: 0,
        pendingTtlMs: 60_000,
        jobTtlMs: 60_000,
        pollMs: 60_000,
        authWindowMs: 60_000,
        refundBufferMs: 0,
        gatewayUrl: `http://localhost:${port}`,
        roleToken: 'tok',
    } satisfies IntakeConfig;
    const dl = { config: { network: 'testnet' } } as unknown as DataLayer;
    const engine = new IntakeEngine(dl, {} as unknown as GatewayClient, config);
    const store = new Store(url, 60_000);

    const jid = `job_deliver_${Date.now()}`;
    await store.putActive({
        job_id: jid,
        session_id: 's',
        agent_wallet: '0xa',
        escrow_id: '0xe',
        cost: 1000,
        paid_at_ms: Date.now(),
        deadline_ms: Date.now() + 60_000,
        releasable: true,
        lifetime: '5m',
    });

    const unknown = await engine.deliver('job_never_existed', '0xa');
    assert.equal(unknown.released, false, 'unknown job is not released');

    const wrongAgent = await engine.deliver(jid, '0xb');
    assert.equal(wrongAgent.released, false, 'foreign agent cannot deliver');
    assert.equal(calls.length, 0, 'validator not consulted before ownership checks');

    const rejected = await engine.deliver(jid, '0xa');
    assert.equal(rejected.released, false, 'invalid result is not released');
    assert.equal(rejected.reason, 'missing field', 'rejection reason passed through');
    assert.deepEqual(calls, [jid], 'validator consulted exactly once');
    assert.ok(await store.getActive(jid), 'job stays active for the deadline to refund');

    await store.removeActive(jid);
    await store.close();
    await engine.stop();
    validator.close();
    console.log('  deliver: OK');
}

async function main(): Promise<void> {
    console.log('[intake] e2e checks');
    await testAuth();
    await testStore();
    await testDeliver();
    console.log('[intake] all checks passed');
}

main().catch((error) => {
    console.error('[intake] e2e failed:', error);
    process.exit(1);
});
