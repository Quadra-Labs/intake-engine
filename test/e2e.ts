/**
 * Component checks runnable without testnet: agent auth (signature + freshness +
 * registration) always; the Redis store if a Redis is reachable. The full
 * on-chain release/refund is verified on testnet (see the plan).
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Redis } from 'ioredis';
import { io as ioClient } from 'socket.io-client';
import type { DataLayer, GatewayClient } from 'quadra-data';

import { AuthManager } from '../src/auth.js';
import { IntakeEngine, parseLifetimeMs } from '../src/engine.js';
import { Store } from '../src/store.js';
import { createNotifier, SOCKET_AUTH_MESSAGE, type JobPaidNotice } from '../src/notify.js';
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
            evaluator_id: 'price-range-guess',
            start_data_template: { start_price: 'number' },
            minimum_lifetime: 60_000,
            allowed_assets: ['BTC'],
        },
        lifetime: '5m',
        asset: 'BTC',
        cost: 1000,
        created_at: Date.now(),
        scoreless: false,
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
        scoreless: false,
        asset: 'BTC',
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
    // jobResultsIndex.get is consulted only for scoreless deliveries; return undefined
    // (nothing stored) to exercise the "result not stored" gate without a chain release.
    const dl = {
        config: { network: 'testnet' },
        jobResultsIndex: { get: async (_id: string) => undefined },
    } as unknown as DataLayer;
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
        scoreless: false,
        lifetime: '5m',
        asset: 'BTC',
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

    // Scoreless delivery: the validator is NOT consulted; without a stored result
    // it is gated (and would release once the result is stored — needs the chain).
    const sjid = `job_scoreless_${Date.now()}`;
    await store.putActive({
        job_id: sjid,
        session_id: 's2',
        agent_wallet: '0xa',
        escrow_id: '0xe2',
        cost: 1000,
        paid_at_ms: Date.now(),
        deadline_ms: Date.now() + 60_000,
        releasable: true,
        scoreless: true,
    });
    const noResult = await engine.deliver(sjid, '0xa');
    assert.equal(noResult.released, false, 'scoreless without a stored result is not released');
    assert.equal(noResult.reason, 'result not stored', 'scoreless gate reports missing result');
    assert.deepEqual(calls, [jid], 'validator not consulted for a scoreless job');
    await store.removeActive(sjid);

    await store.removeActive(jid);
    await store.close();
    await engine.stop();
    validator.close();
    console.log('  deliver: OK');
}

/** Socket.IO notifications: a signed, registered agent receives a job_paid pushed
 * to its room; an unregistered agent is rejected at the handshake. No chain/Redis. */
async function testSocket(): Promise<void> {
    const kp = new Ed25519Keypair();
    const addr = kp.toSuiAddress();
    const dl = {
        agents: { get: async (w: string) => (w === addr ? { wallet: w } : undefined) },
    } as unknown as DataLayer;
    const auth = new AuthManager(dl, 60_000);

    const httpServer = createServer();
    const notifier = createNotifier(httpServer, auth);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;

    const sign = async (keypair: Ed25519Keypair): Promise<{ ts: number; sig: string }> => {
        const ts = Date.now();
        const { signature } = await keypair.signPersonalMessage(
            new TextEncoder().encode(`${ts}.${SOCKET_AUTH_MESSAGE}`),
        );
        return { ts, sig: signature };
    };

    // Registered agent connects, then receives the job_paid pushed to its room.
    const notice: JobPaidNotice = {
        session_id: 's1',
        job_id: 'j1',
        escrow_id: '0xe',
        cost: 1000,
        paid_at_ms: 1,
        deadline_ms: 2,
    };
    const client = ioClient(url, {
        auth: await sign(kp),
        transports: ['websocket'],
        reconnection: false,
    });
    const got = await new Promise<unknown>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 5000);
        client.on('ready', () => notifier.jobPaid(addr, notice));
        client.on('job_paid', (j) => {
            clearTimeout(timer);
            resolve(j);
        });
        client.on('connect_error', (e) => {
            clearTimeout(timer);
            resolve(`error:${e.message}`);
        });
    });
    assert.deepEqual(got, notice, 'registered agent receives its job_paid');
    client.disconnect();

    // An unregistered agent is rejected at the handshake.
    const stranger = ioClient(url, {
        auth: await sign(new Ed25519Keypair()),
        transports: ['websocket'],
        reconnection: false,
    });
    const denied = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 5000);
        stranger.on('connect', () => {
            clearTimeout(timer);
            resolve('connected');
        });
        stranger.on('connect_error', (e) => {
            clearTimeout(timer);
            resolve(e.message);
        });
    });
    assert.match(denied, /not registered/, 'unregistered agent is rejected');
    stranger.disconnect();

    await notifier.close();
    console.log('  socket: OK');
}

async function main(): Promise<void> {
    console.log('[intake] e2e checks');
    await testAuth();
    await testStore();
    await testDeliver();
    await testSocket();
    console.log('[intake] all checks passed');
}

main().catch((error) => {
    console.error('[intake] e2e failed:', error);
    process.exit(1);
});
