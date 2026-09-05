// MCP tool: capture_payment. Confirms an already-authorized payment.
// Gated (velocity + amount cap) like every money-moving tool, but no
// counterparty — capturing your own already-initiated payment isn't
// paying a new external party, so payee-sprawl doesn't apply here.

import { z } from "zod";

import { executeGuarded } from "../guardedTool.js";
import { captureRazorpayPayment } from "../razorpay.js";

export const capturePaymentInputSchema = z.object({
  agentId: z.string().describe("Identifier of the agent making this capture attempt"),
  paymentId: z.string().describe("The authorized payment to capture (starts with 'pay_')"),
  amount: z.number().positive().describe("Amount in the smallest currency unit (paise for INR) — must match the authorized amount"),
  currency: z.string().default("INR"),
});

export type CapturePaymentInput = z.infer<typeof capturePaymentInputSchema>;

export async function handleCapturePayment(input: CapturePaymentInput): Promise<unknown> {
  return executeGuarded({
    toolName: "capture_payment",
    agentId: input.agentId,
    amount: input.amount,
    args: input,
    execute: () => captureRazorpayPayment(input),
  });
}
