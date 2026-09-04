// Mandatory middleware — called INSIDE charge_payment's handler, before any
// Razorpay API call or idempotency check. This is NOT an MCP tool the LLM
// can choose to call or skip; it's a wall the tool call hits every time.

import { getTodaysPayeeIds, getTodaysSpend } from "./db.js";

export interface ChargeInput {
  agentId: string;
  payeeId: string;
  amount: number;
  mandateId: string;
  purpose: string;
}

export type GateDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: "VELOCITY_LIMIT" | "AMOUNT_CAP" | "PAYEE_SPRAWL";
      reason: string;
    };

function dailyCap(): number {
  return Number(process.env.DAILY_CAP ?? 5000);
}
function singleTxnCap(): number {
  return Number(process.env.SINGLE_TXN_CAP ?? 2000);
}
function maxPayees(): number {
  return Number(process.env.MAX_PAYEES ?? 3);
}

// Checks, in order (per spec):
//   1. VELOCITY_LIMIT — today's spend so far + input.amount > DAILY_CAP
//   2. AMOUNT_CAP     — input.amount > SINGLE_TXN_CAP
//   3. PAYEE_SPRAWL   — this would be a new distinct payee beyond MAX_PAYEES today
export function policyGate(input: ChargeInput): GateDecision {
  const cap = dailyCap();
  const todaysSpend = getTodaysSpend(input.agentId);
  if (todaysSpend + input.amount > cap) {
    return {
      allowed: false,
      code: "VELOCITY_LIMIT",
      reason: `Today's spend (${todaysSpend}) + this charge (${input.amount}) would exceed the daily cap of ${cap}`,
    };
  }

  const txnCap = singleTxnCap();
  if (input.amount > txnCap) {
    return {
      allowed: false,
      code: "AMOUNT_CAP",
      reason: `Amount ${input.amount} exceeds the single-transaction cap of ${txnCap}`,
    };
  }

  const maxP = maxPayees();
  const payeeIds = getTodaysPayeeIds(input.agentId);
  const isNewPayee = !payeeIds.includes(input.payeeId);
  if (isNewPayee && payeeIds.length >= maxP) {
    return {
      allowed: false,
      code: "PAYEE_SPRAWL",
      reason: `Agent has already paid ${payeeIds.length} distinct payees today (max ${maxP}); ${input.payeeId} would be a new one`,
    };
  }

  return { allowed: true };
}
