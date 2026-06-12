import { Transaction } from '@mysten/sui/transactions';
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

export interface PaymentsOptions {
    sui: SuiJsonRpcClient;
    keypair: Ed25519Keypair;
    quadraPackageId: string;
    intakeCapId: string;
    intakeConfigId: string;
}

/** Builds and submits the cap-gated `release_payment` / `refund_not_delivered`. */
export class Payments {
    #o: PaymentsOptions;

    constructor(options: PaymentsOptions) {
        this.#o = options;
    }

    /** `release_payment(cap, config, escrow)` — pays the agent (cost − fee). */
    async release(escrowId: string): Promise<string> {
        const tx = new Transaction();
        tx.moveCall({
            target: `${this.#o.quadraPackageId}::intake::release_payment`,
            arguments: [
                tx.object(this.#o.intakeCapId),
                tx.object(this.#o.intakeConfigId),
                tx.object(escrowId),
            ],
        });
        return this.#exec(tx);
    }

    /** `refund_not_delivered(cap, escrow, clock)` — refunds the user (after the wait). */
    async refundNotDelivered(escrowId: string): Promise<string> {
        const tx = new Transaction();
        tx.moveCall({
            target: `${this.#o.quadraPackageId}::intake::refund_not_delivered`,
            arguments: [tx.object(this.#o.intakeCapId), tx.object(escrowId), tx.object.clock()],
        });
        return this.#exec(tx);
    }

    async #exec(tx: Transaction): Promise<string> {
        const res = await this.#o.sui.signAndExecuteTransaction({
            signer: this.#o.keypair,
            transaction: tx,
            options: { showEffects: true },
        });
        if (res.effects?.status.status !== 'success') {
            throw new Error(`tx ${res.digest} failed: ${res.effects?.status.error ?? 'unknown'}`);
        }
        return res.digest;
    }
}
