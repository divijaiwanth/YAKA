// MCP tool: charge_payment. Executes a charge against an existing mandate.
// Routes through the shared guarded-execution pipeline (policy gate ->
// idempotency -> Razorpay -> audit log) in guardedTool.ts — this file only
// describes what "amount" and "counterparty" mean for a mandate charge and
// provides the actual Razorpay call.

import { z } from "zod";

import { executeGuarded } from "../guardedTool.js";
import { chargeRazorpayMandate } from "../razorpay.js";

export const chargePaymentInputSchema = z.object({
  agentId: z.string().describe("Identifier of the agent making this charge attempt"),
  payeeId: z.string().describe("Identifier of the payee being charged"),
  amount: z.number().positive().describe("Amount in the smallest currency unit (paise for INR)"),
  mandateId: z.string().describe("The mandate to charge against (from create_mandate)"),
  purpose: z.string().describe("Human-readable reason for this charge"),
});

export type ChargePaymentInput = z.infer<typeof chargePaymentInputSchema>;

export async function handleChargePayment(input: ChargePaymentInput): Promise<unknown> {
  return executeGuarded({
    toolName: "charge_payment",
    agentId: input.agentId,
    amount: input.amount,
    counterparty: input.payeeId, // paying a mandate's payee — a real external party, so payee-sprawl applies
    args: { ...input, counterparty: input.payeeId },
    execute: () => chargeRazorpayMandate({ mandateId: input.mandateId, amount: input.amount }),
  });
}
