// MCP tool: charge_payment. Executes a charge against an existing mandate.
//
// Required order of operations (not optional, not reorderable):
//   1. policyGate(input) — before touching Razorpay or the idempotency store.
//      On failure: return { allowed: false, code, reason } and STOP. No
//      Razorpay call, no idempotency lookup, but still logged to audit_log.
//   2. Compute intentHash = sha256(`${payeeId}:${amount}:${mandateId}:${purpose}`).
//      Check idempotency_store. If found, return the stored result WITHOUT
//      calling Razorpay again. Still logged to audit_log.
//   3. No existing record: call Razorpay's charge API, store the result
//      (success OR error — a failed Razorpay call still counts as "this
//      intent has been attempted", so a retry of the exact same intent
//      doesn't hammer Razorpay again either) keyed by intentHash.
//   4. Log every attempt (blocked, deduped, or executed) to audit_log.

import { createHash } from "node:crypto";
import { z } from "zod";

import { awaitIdempotentResult, insertAuditLog, storeIdempotentResult, tryReserve } from "../db.js";
import { policyGate } from "../policyGate.js";
import { chargeRazorpayMandate, extractRazorpayError } from "../razorpay.js";

export const chargePaymentInputSchema = z.object({
  agentId: z.string().describe("Identifier of the agent making this charge attempt"),
  payeeId: z.string().describe("Identifier of the payee being charged"),
  amount: z.number().positive().describe("Amount in the smallest currency unit (paise for INR)"),
  mandateId: z.string().describe("The mandate to charge against (from create_mandate)"),
  purpose: z.string().describe("Human-readable reason for this charge"),
});

export type ChargePaymentInput = z.infer<typeof chargePaymentInputSchema>;

function intentHash(input: ChargePaymentInput): string {
  return createHash("sha256")
    .update(`${input.payeeId}:${input.amount}:${input.mandateId}:${input.purpose}`)
    .digest("hex");
}

export async function handleChargePayment(input: ChargePaymentInput): Promise<unknown> {
  // 1. mandatory gate — this is a wall, not a tool the LLM can skip
  const gate = policyGate(input);
  if (!gate.allowed) {
    const refusal = { allowed: false, code: gate.code, reason: gate.reason };
    insertAuditLog({
      agentId: input.agentId,
      toolName: "charge_payment",
      inputJson: JSON.stringify(input),
      gateDecision: "blocked",
      gateReason: `${gate.code}: ${gate.reason}`,
      resultJson: JSON.stringify(refusal),
    });
    return refusal;
  }

  // 2. idempotency check — atomic reservation, not check-then-act. A plain
  //    "look up, then later store" would race: with 5 identical calls
  //    fired concurrently, all 5 could see "nothing cached yet" before any
  //    of them finishes the (async) Razorpay call and stores a result.
  //    tryReserve is a single synchronous INSERT ... ON CONFLICT DO
  //    NOTHING, which is what actually closes that race.
  const hash = intentHash(input);
  const wonReservation = tryReserve(hash);

  let resultJson: string;
  let deduped: boolean;

  if (wonReservation) {
    deduped = false;
    // 3. no existing record — actually call Razorpay
    let result: Record<string, unknown>;
    try {
      const charge = await chargeRazorpayMandate({ mandateId: input.mandateId, amount: input.amount });
      result = { allowed: true, charge };
    } catch (err) {
      result = { allowed: true, charge: null, error: extractRazorpayError(err) };
    }
    resultJson = JSON.stringify(result);
    storeIdempotentResult(hash, resultJson); // overwrites the pending reservation with the real result
  } else {
    deduped = true;
    // Someone else already claimed this exact intent — either already
    // finished (common case: a plain retry) or mid-flight right now
    // (the concurrent-burst case); either way, wait for the real result
    // instead of calling Razorpay again.
    resultJson = await awaitIdempotentResult(hash);
  }

  // 4. log every attempt (blocked, deduped, or executed)
  insertAuditLog({
    agentId: input.agentId,
    toolName: "charge_payment",
    inputJson: JSON.stringify(input),
    gateDecision: "allowed",
    gateReason: deduped ? "deduped: identical intent already processed, Razorpay not called again" : null,
    resultJson,
  });

  return { ...JSON.parse(resultJson), deduped };
}
