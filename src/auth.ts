import type { Request, RequestHandler } from 'express';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import type { DataLayer } from 'quadra-data';

/** An authenticated request carries the recovered agent wallet + raw body. */
export interface AuthedRequest extends Request {
    agentWallet?: string;
    rawBody?: string;
}

/** Thrown when a request fails authentication. */
export class AuthError extends Error {}

/**
 * Verifies agent-signed messages and that the signer is a registered agent.
 *
 * The agent signs the personal message `` `${ts}.${rawBody}` `` with its Sui
 * Ed25519 key and sends `x-quadra-ts` + `x-quadra-sig` (base64). The timestamp
 * must be fresh (replay guard), the signature must recover a Sui address, and
 * that address must exist in the `agents` registry (Walrus).
 */
export class AuthManager {
    #dl: DataLayer;
    #windowMs: number;

    constructor(dl: DataLayer, windowMs: number) {
        this.#dl = dl;
        this.#windowMs = windowMs;
    }

    async verify(rawBody: string, ts: number, signatureB64: string): Promise<string> {
        if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > this.#windowMs) {
            throw new AuthError('stale or missing timestamp');
        }
        const message = new TextEncoder().encode(`${ts}.${rawBody}`);
        let wallet: string;
        try {
            const publicKey = await verifyPersonalMessageSignature(message, signatureB64);
            wallet = publicKey.toSuiAddress();
        } catch {
            throw new AuthError('bad signature');
        }
        const agent = await this.#dl.agents.get(wallet);
        if (!agent) throw new AuthError('agent not registered');
        return wallet;
    }
}

/** Express middleware: authenticate, then attach `req.agentWallet`. */
export function authMiddleware(auth: AuthManager): RequestHandler {
    return (req, res, next) => {
        const authed = req as AuthedRequest;
        const ts = Number(req.header('x-quadra-ts'));
        const sig = req.header('x-quadra-sig');
        if (!sig) {
            res.status(401).json({ error: 'missing signature' });
            return;
        }
        auth.verify(authed.rawBody ?? '', ts, sig)
            .then((wallet) => {
                authed.agentWallet = wallet;
                next();
            })
            .catch((err) => {
                res.status(401).json({
                    error: err instanceof Error ? err.message : 'unauthorized',
                });
            });
    };
}
