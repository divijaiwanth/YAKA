// MCP tool: create_mandate. Creates an eNACH or UPI Autopay mandate via
// Razorpay's test API. No velocity/amount/payee checks here — mandates
// don't move money by themselves, only charge_payment does. Every attempt
// still gets logged to audit_log.

import { z } from "zod";

import { insertAuditLog } from "../db.js";
import { createRazorpayMandate, extractRazorpayError } from "../razorpay.js";

export const createMandateInputSchema = z.object({
  agentId: z.string().describe("Identifier of the agent creating this mandate"),
  payeeId: z.string().describe("Identifier of the payee this mandate is for"),
  amount: z.number().positive().describe("Max amount (smallest currency unit) this mandate can be charged"),
  method: z.enum(["emandate", "upi_autopay"]),
  purpose: z.string().describe("Human-readable reason for this mandate"),
});

export type CreateMandateInput = z.infer<typeof createMandateInputSchema>;

export async function handleCreateMandate(input: CreateMandateInput): Promise<unknown> {
  let result: Record<string, unknown>;
  let gateReason: string | null = null;

  try {
    result = { ...(await createRazorpayMandate(input)) };
  } catch (err) {
    result = { error: extractRazorpayError(err) };
    gateReason = "razorpay_error";
  }

  insertAuditLog({
    agentId: input.agentId,
    toolName: "create_mandate",
    inputJson: JSON.stringify(input),
    gateDecision: "allowed", // no velocity/cap checks for mandate creation, per spec
    gateReason,
    resultJson: JSON.stringify(result),
  });

  return result;
}
