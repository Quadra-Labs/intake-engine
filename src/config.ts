import { fileURLToPath } from 'node:url';

import { Agent, setGlobalDispatcher } from 'undici';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { DataLayer, GatewayClient } from 'quadra-data';

// Public Sui/Walrus endpoints prefer IPv4 with a generous connect timeout.
setGlobalDispatcher(new Agent({ connect: { timeout: 60_000, family: 4 } }));

// The intake engine shares the data layer's .env (network, pointers, keys, and
// QUADRA_PACKAGE_ID). Override the path with DATA_ENV_PATH.
try {
    const envPath =
        process.env.DATA_ENV_PATH ?? fileURLToPath(new URL('../../data/.env', import.meta.url));
    process.loadEnvFile(envPath);
} catch {
    // env may already be provided by the parent process (e.g. a spawned child)
}

export interface IntakeConfig {
    /** The wallet that owns `IntakeCap`; signs `release_payment` / `refund_not_delivered`. */
    keypair: Ed25519Keypair;
    quadraPackageId: string;
    intakeCapId: string;
    intakeConfigId: string;
    /** Shared secret presented to the validator engine's `POST /validate`. */
    internalToken: string;
    /** Base URL of the validator engine (the scheduler's server). */
    validatorUrl: string;
    redisUrl: string;
    port: number;
    /** Pending session TTL while waiting for payment (default 15 min). */
    pendingTtlMs: number;
    /** Delivery deadline for an active job; matches the contract's wait (default 30 min). */
    jobTtlMs: number;
    /** Event-poll + deadline-scan interval (default 3 s). */
    pollMs: number;
    /** Allowed clock skew on a signed agent message (default 60 s). */
    authWindowMs: number;
    /** Extra wait past the deadline before refunding, so the on-chain clock has passed. */
    refundBufferMs: number;
    /** Data gateway base URL the engine writes through. */
    gatewayUrl: string;
    /** Intake's role token for the gateway (`ROLE_TOKEN_INTAKE`). */
    roleToken: string;
}

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var ${name}`);
    return value;
}

function num(name: string, fallback: number): number {
    const value = process.env[name];
    if (value === undefined || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${value}"`);
    return n;
}

export function loadIntakeConfig(): IntakeConfig {
    return {
        keypair: Ed25519Keypair.fromSecretKey(required('INTAKE_SECRET_KEY')),
        quadraPackageId: required('QUADRA_PACKAGE_ID'),
        intakeCapId: required('INTAKE_CAP_ID'),
        intakeConfigId: required('INTAKE_CONFIG_ID'),
        internalToken: required('INTAKE_INTERNAL_TOKEN'),
        validatorUrl: process.env.INTAKE_VALIDATOR_URL ?? 'http://localhost:4000',
        redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
        port: num('INTAKE_PORT', 5000),
        pendingTtlMs: num('INTAKE_PENDING_TTL_MS', 15 * 60 * 1000),
        jobTtlMs: num('INTAKE_JOB_TTL_MS', 30 * 60 * 1000),
        pollMs: num('INTAKE_POLL_MS', 3000),
        authWindowMs: num('INTAKE_AUTH_WINDOW_MS', 60_000),
        refundBufferMs: num('INTAKE_REFUND_BUFFER_MS', 10_000),
        gatewayUrl: process.env.DATA_GATEWAY_URL ?? 'http://localhost:8787',
        roleToken: required('ROLE_TOKEN_INTAKE'),
    };
}

/** Read-only data layer (no master key); intake reads, then writes via the gateway. */
export function createDataLayer(): DataLayer {
    return DataLayer.forReads();
}

/** The gateway client intake writes through (carries its role token). */
export function createGateway(config: IntakeConfig): GatewayClient {
    return new GatewayClient({ url: config.gatewayUrl, roleToken: config.roleToken });
}
