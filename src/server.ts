/**
 * Quadra Intake Engine — Express server.
 *
 * Authenticates agents (Sui signatures), takes job submissions, watches for the
 * on-chain payment, and releases or refunds. Delivery claims are checked with
 * the validator engine before payment is released.
 */
import express from 'express';
import { createServer } from 'node:http';

import { loadIntakeConfig, createDataLayer, createGateway } from './config.js';
import { AuthManager, authMiddleware, type AuthedRequest } from './auth.js';
import { createNotifier } from './notify.js';
import { IntakeEngine } from './engine.js';

async function main(): Promise<void> {
    const config = loadIntakeConfig();
    const dl = createDataLayer();
    const gateway = createGateway(config);
    const auth = new AuthManager(dl, config.authWindowMs);

    const app = express();
    // Capture the raw body so signatures verify against the exact bytes sent.
    app.use(
        express.json({
            verify: (req, _res, buf) => {
                (req as unknown as AuthedRequest).rawBody = buf.toString('utf8');
            },
        }),
    );

    // Socket.IO shares this HTTP server and pushes job-paid notices to agents,
    // authenticated with the same agent-signature scheme as the REST API.
    const httpServer = createServer(app);
    const notifier = createNotifier(httpServer, auth);

    const engine = new IntakeEngine(dl, gateway, config, notifier);
    engine.start();

    const requireAgent = authMiddleware(auth);

    // Agent opens a job (authenticated). Returns the session the user pays.
    app.post('/jobs', requireAgent, (req, res) => {
        const { agentWallet, body } = req as AuthedRequest;
        engine
            .submit(agentWallet!, {
                template_id: body.template_id,
                lifetime: body.lifetime,
                cost: Number(body.cost),
                asset: body.asset,
            })
            .then((session) => res.json(session))
            .catch((err) =>
                res.status(400).json({ error: err instanceof Error ? err.message : 'bad request' }),
            );
    });

    // Agent claims it delivered a job (authenticated). The engine asks the
    // validator; a valid result releases payment and schedules scoring, an
    // invalid one is left for the deadline to refund. Validator outages are a
    // 502 so the agent can retry.
    app.post('/deliver', requireAgent, (req, res) => {
        const { agentWallet, body } = req as AuthedRequest;
        engine
            .deliver(String(body.job_id), agentWallet!)
            .then((outcome) => res.json(outcome))
            .catch((err) =>
                res.status(502).json({ error: err instanceof Error ? err.message : 'error' }),
            );
    });

    app.get('/health', (_req, res) => {
        engine
            .status()
            .then((s) => res.json({ ok: true, network: dl.config.network, ...s }))
            .catch(() => res.status(500).json({ ok: false }));
    });
    app.get('/status', (_req, res) => {
        engine
            .status()
            .then((s) => res.json(s))
            .catch((err) =>
                res.status(500).json({ error: err instanceof Error ? err.message : 'error' }),
            );
    });

    httpServer.listen(config.port, () => {
        console.log(`[intake] listening on http://localhost:${config.port} (HTTP + Socket.IO)`);
    });
}

main().catch((error) => {
    console.error('[intake] failed to start:', error);
    process.exit(1);
});
