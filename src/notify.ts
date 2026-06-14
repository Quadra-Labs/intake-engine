/**
 * Socket.IO notifications to agents.
 *
 * When a job an agent proposed is paid on-chain, the engine pushes a `job_paid`
 * event to that agent over Socket.IO. Agents authenticate the socket with the
 * SAME Sui-signature scheme as the REST API (reusing `AuthManager`): they sign
 * the personal message `` `${ts}.${SOCKET_AUTH_MESSAGE}` `` and pass `{ ts, sig }`
 * in the connection `auth`. On success the socket joins a room named by its
 * wallet, and the engine emits only to that room — so an agent only ever sees
 * its own jobs.
 */
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';

import type { AuthManager } from './auth.js';

/** Pushed to an agent when a job it proposed has been paid (and is releasable). */
export interface JobPaidNotice {
    session_id: string;
    job_id: string;
    escrow_id: string;
    cost: number;
    paid_at_ms: number;
    /** When the engine will refund if the job is not delivered. */
    deadline_ms: number;
}

/** How the engine pushes notifications; decoupled from the transport. */
export interface AgentNotifier {
    jobPaid(agentWallet: string, notice: JobPaidNotice): void;
}

/** The fixed message body an agent signs to open a socket (domain separator). */
export const SOCKET_AUTH_MESSAGE = 'quadra-intake/socket';

/** A notifier backed by a live Socket.IO server, plus `close()` for shutdown. */
export interface SocketNotifier extends AgentNotifier {
    io: Server;
    close(): Promise<void>;
}

/**
 * Attach a Socket.IO server to `httpServer` that authenticates agents with
 * `auth` and lets the engine push `job_paid` events to per-agent rooms.
 */
export function createNotifier(httpServer: HttpServer, auth: AuthManager): SocketNotifier {
    const io = new Server(httpServer, { serveClient: false });

    // Authenticate every connection with the agent's Sui signature, the same way
    // the REST API does — just over a fixed message instead of a request body.
    io.use((socket, next) => {
        const handshake = socket.handshake.auth as { ts?: number | string; sig?: string };
        const ts = Number(handshake?.ts);
        const sig = handshake?.sig;
        if (!sig || !Number.isFinite(ts)) {
            next(new Error('missing ts/sig'));
            return;
        }
        auth.verify(SOCKET_AUTH_MESSAGE, ts, sig)
            .then((wallet) => {
                socket.data.agentWallet = wallet;
                void socket.join(wallet);
                next();
            })
            .catch((err: unknown) => next(err instanceof Error ? err : new Error('unauthorized')));
    });

    io.on('connection', (socket: Socket) => {
        const wallet = socket.data.agentWallet as string;
        socket.emit('ready', { agent_wallet: wallet });
        console.log(`[intake] agent connected via socket: ${wallet}`);
        socket.on('disconnect', () => console.log(`[intake] agent disconnected: ${wallet}`));
    });

    return {
        io,
        jobPaid(agentWallet: string, notice: JobPaidNotice): void {
            io.to(agentWallet).emit('job_paid', notice);
        },
        async close(): Promise<void> {
            await new Promise<void>((resolve, reject) =>
                io.close((err) => (err ? reject(err) : resolve())),
            );
        },
    };
}
