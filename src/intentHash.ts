// Idempotency key for ANY gated tool call — hash of the tool name plus a
// canonical (sorted-key) form of its args. Previously this was hardcoded
// per-tool (charge_payment hashed payeeId:amount:mandateId:purpose
// directly); generalizing it is what lets every gated tool share the same
// dedupe mechanism instead of reinventing it.

import { createHash } from "node:crypto";

export function computeIntentHash(toolName: string, args: Record<string, unknown>): string {
  const canonical = JSON.stringify(args, Object.keys(args).sort());
  return createHash("sha256").update(`${toolName}:${canonical}`).digest("hex");
}
