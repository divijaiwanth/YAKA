// MCP server entrypoint. Exposes the gated payment tools — every one of
// them routes through the shared policy layer (guardedTool.ts: policy gate
// -> idempotency -> Razorpay -> audit log), plus the one ungated tool
// (create_mandate, which doesn't move money by itself). All safety logic
// lives in ./guardedTool.ts and ./policyGate.ts, not here; this file only
// wires the MCP protocol plumbing.
//
// IMPORTANT: never console.log() in this file (or anything it imports at
// module load time) — stdout is the MCP protocol channel. Use
// console.error() for anything you want to see in a terminal.

import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { log } from "./log.js";

import { capturePaymentInputSchema, handleCapturePayment } from "./tools/capturePayment.js";
import { chargePaymentInputSchema, handleChargePayment } from "./tools/chargePayment.js";
import { createInstantSettlementInputSchema, handleCreateInstantSettlement } from "./tools/createInstantSettlement.js";
import { createMandateInputSchema, handleCreateMandate } from "./tools/createMandate.js";
import { createRefundInputSchema, handleCreateRefund } from "./tools/createRefund.js";

const server = new McpServer({ name: "yaka", version: "0.1.0" });

const GATE_NOTICE =
  "Policy limits (daily cap across ALL payment tools, single-transaction cap, distinct-payee cap) and idempotency are enforced INSIDE this tool before Razorpay is ever called — they cannot be bypassed by choosing not to call a separate 'check' tool.";

// Every handler below is expected to already catch its own Razorpay/network
// errors (see guardedTool.ts) and return a normal JSON result either way.
// This wrapper exists for the case that isn't supposed to happen — a bug,
// an unexpected exception anywhere in the chain — so it shows up as a real,
// readable error to the calling agent (and in stderr, for us) instead of an
// opaque client-side "failed to call tool, no further details" message.
function safeHandler<T>(toolName: string, handler: (input: T) => Promise<unknown>) {
  return async (input: T) => {
    log(`tool_call_start ${toolName}`, input);
    try {
      const result = await handler(input);
      const text = JSON.stringify(result, null, 2);
      log(`tool_call_ok ${toolName}`, { bytes: text.length });
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.stack ?? err.message : String(err);
      log(`tool_call_error ${toolName}`, message);
      console.error(`[${toolName}] unexpected error:`, message);
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unexpected error in ${toolName}: ${message}` }],
      };
    }
  };
}

server.registerTool(
  "create_mandate",
  {
    description: "Create an eNACH or UPI Autopay mandate via Razorpay (test mode).",
    inputSchema: createMandateInputSchema,
  },
  safeHandler("create_mandate", handleCreateMandate)
);

server.registerTool(
  "charge_payment",
  {
    description: `Execute a charge against an existing mandate. ${GATE_NOTICE}`,
    inputSchema: chargePaymentInputSchema,
  },
  safeHandler("charge_payment", handleChargePayment)
);

server.registerTool(
  "capture_payment",
  {
    description: `Capture a previously authorized payment. ${GATE_NOTICE}`,
    inputSchema: capturePaymentInputSchema,
  },
  safeHandler("capture_payment", handleCapturePayment)
);

server.registerTool(
  "create_refund",
  {
    description: `Refund a payment back to whoever paid it. ${GATE_NOTICE}`,
    inputSchema: createRefundInputSchema,
  },
  safeHandler("create_refund", handleCreateRefund)
);

server.registerTool(
  "create_instant_settlement",
  {
    description: `Settle your available balance to your own bank account. ${GATE_NOTICE}`,
    inputSchema: createInstantSettlementInputSchema,
  },
  safeHandler("create_instant_settlement", handleCreateInstantSettlement)
);

process.on("uncaughtException", (err) => {
  log("uncaughtException", err);
  console.error("uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  log("unhandledRejection", reason);
  console.error("unhandledRejection:", reason);
});

async function main(): Promise<void> {
  log("server_start", { node: process.version, cwd: process.cwd(), pid: process.pid });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("server_connected");
  console.error("Yaka MCP server running on stdio");
}

main().catch((err) => {
  log("server_start_failed", err);
  console.error("Server error:", err);
  process.exit(1);
});
