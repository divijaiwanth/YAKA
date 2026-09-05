// The policy layer's actual enforcement pipeline. Every gated tool's
// handler calls this instead of touching Razorpay, the idempotency store,
// or the audit log directly — so adding a new gated operation means
// writing the Razorpay call and describing it (name, amount,
// counterparty), not re-implementing the safety plumbing.
//
// Order (not optional, not reorderable):
//   1. policyGate() — before anything else. Blocked -> log + return, stop.
//   2. Atomic idempotency reservation.
//   3. Won the reservation: call Razorpay for real, store the result.
//      Lost it: wait for the winner's real result instead of calling
//      Razorpay again.
//   4. Log the attempt either way.

import { insertAuditLog, storeIdempotentResult, tryReserve, awaitIdempotentResult } from "./db.js";
import { computeIntentHash } from "./intentHash.js";
import { policyGate } from "./policyGate.js";
import { extractRazorpayError } from "./razorpay.js";

export interface GuardedToolInput {
  toolName: string;
  agentId: string;
  amount: number;
  counterparty?: string;
  args: Record<string, unknown>;
  execute: () => Promise<unknown>;
}

export async function executeGuarded(input: GuardedToolInput): Promise<unknown> {
  const { toolName, agentId, amount, counterparty, args, execute } = input;

  // 1. mandatory gate — this is a wall, not a tool the LLM can skip
  const gate = policyGate({ agentId, amount, counterparty });
  if (!gate.allowed) {
    const refusal = { allowed: false, code: gate.code, reason: gate.reason };
    insertAuditLog({
      agentId,
      toolName,
      inputJson: JSON.stringify(args),
      gateDecision: "blocked",
      gateReason: `${gate.code}: ${gate.reason}`,
      resultJson: JSON.stringify(refusal),
    });
    return refusal;
  }

  // 2. idempotency check — atomic reservation, not check-then-act. See
  // db.ts's tryReserve for why this has to be a single atomic statement.
  const hash = computeIntentHash(toolName, args);
  const wonReservation = tryReserve(hash);

  let resultJson: string;
  let deduped: boolean;

  if (wonReservation) {
    deduped = false;
    // 3. no existing record — actually call Razorpay
    let result: Record<string, unknown>;
    try {
      result = { allowed: true, gate: "PASSED — all Yaka policy checks approved this", result: await execute() };
    } catch (err) {
      // Be explicit about WHERE this failed. Yaka's job (the policy
      // decision) succeeded; the downstream payment provider rejected the
      // call for its own reasons. Without spelling that out, a calling
      // agent tends to report this as "the guardrail failed" or blame the
      // mandate setup, which is wrong and misleading.
      result = {
        allowed: true,
        gate: "PASSED — all Yaka policy checks approved this",
        failedAt: "razorpay",
        result: null,
        razorpayError: extractRazorpayError(err),
        note:
          "Yaka's policy layer APPROVED this call and passed it to Razorpay. " +
          "The error above came from Razorpay's API, not from the guardrail — " +
          "on this sandbox account, Recurring Payments / refunds / instant " +
          "settlements are not provisioned, so live execution fails there. " +
          "The policy decision itself succeeded.",
      };
    }
    resultJson = JSON.stringify(result);
    storeIdempotentResult(hash, resultJson); // overwrites the pending reservation with the real result
  } else {
    deduped = true;
    resultJson = await awaitIdempotentResult(hash);
  }

  // 4. log every attempt (blocked, deduped, or executed)
  insertAuditLog({
    agentId,
    toolName,
    inputJson: JSON.stringify(args),
    gateDecision: "allowed",
    gateReason: deduped ? "deduped: identical intent already processed, Razorpay not called again" : null,
    resultJson,
  });

  return { ...JSON.parse(resultJson), deduped };
}
