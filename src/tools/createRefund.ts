// MCP tool: create_refund. Refunds money back to whoever already paid it.
// Gated like every money-moving tool, but no counterparty — a refund
// returns money to the original payer, it doesn't pay a new external
// party, so payee-sprawl doesn't apply here.

import { z } from "zod";

import { executeGuarded } from "../guardedTool.js";
import { createRazorpayRefund } from "../razorpay.js";

export const createRefundInputSchema = z.object({
  agentId: z.string().describe("Identifier of the agent making this refund attempt"),
  paymentId: z.string().describe("The payment to refund (starts with 'pay_')"),
  amount: z.number().positive().describe("Amount in the smallest currency unit (paise for INR)"),
});

export type CreateRefundInput = z.infer<typeof createRefundInputSchema>;

export async function handleCreateRefund(input: CreateRefundInput): Promise<unknown> {
  return executeGuarded({
    toolName: "create_refund",
    agentId: input.agentId,
    amount: input.amount,
    args: input,
    execute: () => createRazorpayRefund(input),
  });
}
