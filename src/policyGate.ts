// Mandatory middleware — called INSIDE every gated tool's handler, before
// any Razorpay API call or idempotency check. This is NOT an MCP tool the
// LLM can choose to call or skip; it's a wall every gated tool call hits.
//
// Generalized across every gated tool, not just charge_payment: the gate
// only needs two universal facts about any money-moving call — how much,
// and (where applicable) who the money is going to. `counterparty` is
// optional because it only makes sense for some operations: paying a
// mandate's payee has one, but capturing your own already-authorized
// payment, refunding money back to whoever already paid you, or settling
// your own balance to your own bank account do not — there's no new
// external party to sprawl-check for those.

import { getTodaysCounterparties, getTodaysSpend } from "./db.js";

// Every tool that participates in the shared daily cap / payee-sprawl
// tracking. Adding a new gated tool means adding its name here — see
// guardedTool.ts for the pipeline every one of these routes through.
export const GATED_TOOLS = ["charge_payment", "capture_payment", "create_refund", "create_instant_settlement"] as const;

export interface GateInput {
  agentId: string;
  amount: number;
  counterparty?: string;
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
//   1. VELOCITY_LIMIT — today's spend across EVERY gated tool + this
//      amount > DAILY_CAP
//   2. AMOUNT_CAP     — this amount alone > SINGLE_TXN_CAP
//   3. PAYEE_SPRAWL   — only when a counterparty is given: this would be a
//      new distinct counterparty beyond MAX_PAYEES paid today (across
//      every gated tool)
export function policyGate(input: GateInput): GateDecision {
  const cap = dailyCap();
  const todaysSpend = getTodaysSpend(input.agentId, GATED_TOOLS);
  if (todaysSpend + input.amount > cap) {
    return {
      allowed: false,
      code: "VELOCITY_LIMIT",
      reason: `Today's spend across all payment tools (${todaysSpend}) + this amount (${input.amount}) would exceed the daily cap of ${cap}`,
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

  if (input.counterparty) {
    const maxP = maxPayees();
    const counterparties = getTodaysCounterparties(input.agentId, GATED_TOOLS);
    const isNew = !counterparties.includes(input.counterparty);
    if (isNew && counterparties.length >= maxP) {
      return {
        allowed: false,
        code: "PAYEE_SPRAWL",
        reason: `Agent has already paid ${counterparties.length} distinct counterparties today (max ${maxP}); ${input.counterparty} would be a new one`,
      };
    }
  }

  return { allowed: true };
}
