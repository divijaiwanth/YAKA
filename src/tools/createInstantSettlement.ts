// MCP tool: create_instant_settlement. Settles your own available balance
// to your own bank account. Gated like every money-moving tool, but no
// counterparty — you're moving money to your own account, not paying a
// new external party, so payee-sprawl doesn't apply here.

import { z } from "zod";

import { executeGuarded } from "../guardedTool.js";
import { createRazorpayInstantSettlement } from "../razorpay.js";

export const createInstantSettlementInputSchema = z.object({
  agentId: z.string().describe("Identifier of the agent making this settlement attempt"),
  amount: z.number().positive().describe("Amount in the smallest currency unit (paise for INR)"),
});

export type CreateInstantSettlementInput = z.infer<typeof createInstantSettlementInputSchema>;

export async function handleCreateInstantSettlement(input: CreateInstantSettlementInput): Promise<unknown> {
  return executeGuarded({
    toolName: "create_instant_settlement",
    agentId: input.agentId,
    amount: input.amount,
    args: input,
    execute: () => createRazorpayInstantSettlement(input),
  });
}
