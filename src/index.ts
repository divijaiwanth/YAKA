// MCP server entrypoint. Exposes exactly two tools — create_mandate and
// charge_payment — over stdio transport. All safety logic (policy gate,
// idempotency, audit log) lives inside the tool handlers in ./tools/, not
// here; this file only wires the MCP protocol plumbing.
//
// IMPORTANT: never console.log() in this file (or anything it imports at
// module load time) — stdout is the MCP protocol channel. Use
// console.error() for anything you want to see in a terminal.

import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { chargePaymentInputSchema, handleChargePayment } from "./tools/chargePayment.js";
import { createMandateInputSchema, handleCreateMandate } from "./tools/createMandate.js";

const server = new McpServer({ name: "yaka", version: "0.1.0" });

server.registerTool(
  "create_mandate",
  {
    description: "Create an eNACH or UPI Autopay mandate via Razorpay (test mode).",
    inputSchema: createMandateInputSchema,
  },
  async (input) => {
    const result = await handleCreateMandate(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "charge_payment",
  {
    description:
      "Execute a charge against an existing mandate. Policy limits (daily cap, single-transaction cap, distinct-payee cap) and idempotency are enforced INSIDE this tool before Razorpay is ever called — they cannot be bypassed by choosing not to call a separate 'check' tool.",
    inputSchema: chargePaymentInputSchema,
  },
  async (input) => {
    const result = await handleChargePayment(input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Yaka MCP server running on stdio");
}

main().catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
