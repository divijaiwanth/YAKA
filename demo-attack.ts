// Standalone script simulating a misbehaving agent talking to
// razorpay-guardrail over the real MCP protocol (spawns its own instance
// of the server as a subprocess, same as a real MCP client — e.g. Claude
// Desktop — would):
//
//   a) fires the identical charge 5x rapidly — should dedupe via
//      idempotency, only 1 real Razorpay call happens
//   b) attempts a charge that exceeds DAILY_CAP — blocked, VELOCITY_LIMIT
//   c) attempts charges to more than MAX_PAYEES distinct payees — blocked
//      with PAYEE_SPRAWL on the one that crosses the limit
//   d) prints the audit log at the end so the blocking is visible and
//      explainable
//
// Run with: npm run demo-attack

import "dotenv/config";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { getAuditLog, resetAll } from "./src/db.js";

const AGENT_ID = "attacker-agent";

interface ToolTextResult {
  content: Array<{ type: string; text?: string }>;
}

function parseToolResult(res: ToolTextResult): unknown {
  const text = res.content.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

async function main(): Promise<void> {
  console.log("=== razorpay-guardrail demo-attack ===\n");

  resetAll();
  console.log("(reset today's spend/payee tracking for a clean run)\n");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts"],
    // Stdio transport does NOT fully inherit the parent's env by default
    // (security restriction) — without this, the spawned server wouldn't
    // see RAZORPAY_KEY_ID/SECRET or the DAILY_CAP/SINGLE_TXN_CAP/MAX_PAYEES
    // thresholds loaded from .env into THIS process's env above.
    env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
  });
  const client = new Client({ name: "demo-attack", version: "0.1.0" });
  await client.connect(transport);

  const dailyCap = Number(process.env.DAILY_CAP ?? 5000);
  const singleTxnCap = Number(process.env.SINGLE_TXN_CAP ?? 2000);
  const maxPayees = Number(process.env.MAX_PAYEES ?? 3);

  const charge = async (args: Record<string, unknown>) =>
    parseToolResult((await client.callTool({ name: "charge_payment", arguments: args })) as ToolTextResult);

  // --- a) identical charge fired 5x rapidly ---
  console.log("--- (a) firing the SAME charge 5x rapidly (should dedupe) ---");
  const dupeArgs = {
    agentId: AGENT_ID,
    payeeId: "payee-alpha",
    amount: Math.min(500, singleTxnCap),
    mandateId: "mandate_demo_dedupe",
    purpose: "dedupe-test",
  };
  const dupeResults = await Promise.all([1, 2, 3, 4, 5].map(() => charge(dupeArgs)));
  dupeResults.forEach((r, i) => console.log(`  call ${i + 1}:`, JSON.stringify(r)));
  console.log(
    "  -> check the audit log below: only ONE row for this intent should show a real Razorpay attempt,\n" +
      "     the other four should be marked as deduped.\n"
  );

  // --- b) exceed DAILY_CAP ---
  console.log(`--- (b) attempting a charge that exceeds DAILY_CAP (${dailyCap}) ---`);
  const overCapResult = await charge({
    agentId: AGENT_ID,
    payeeId: "payee-beta",
    amount: dailyCap + 1,
    mandateId: "mandate_demo_overcap",
    purpose: "velocity-test",
  });
  console.log("  result:", JSON.stringify(overCapResult), "\n");

  // --- c) exceed MAX_PAYEES distinct payees ---
  console.log(`--- (c) attempting charges to more than MAX_PAYEES (${maxPayees}) distinct payees ---`);
  // payee-alpha was already paid in (a). Pay (maxPayees - 1) more NEW
  // payees to reach the cap, then one more to trigger PAYEE_SPRAWL.
  for (let i = 0; i < maxPayees - 1; i++) {
    const payeeId = `payee-sprawl-${i}`;
    const r = await charge({
      agentId: AGENT_ID,
      payeeId,
      amount: 10,
      mandateId: `mandate_demo_sprawl_${i}`,
      purpose: "payee-sprawl-fill",
    });
    console.log(`  charge to new payee ${payeeId}:`, JSON.stringify(r));
  }
  const sprawlBreaker = await charge({
    agentId: AGENT_ID,
    payeeId: "payee-sprawl-breaker",
    amount: 10,
    mandateId: "mandate_demo_sprawl_breaker",
    purpose: "payee-sprawl-breaker",
  });
  console.log("  charge to ONE MORE new payee (should be blocked):", JSON.stringify(sprawlBreaker), "\n");

  // --- d) print the audit log ---
  const log = getAuditLog();
  console.log(`--- (d) audit log (${log.length} entries) ---`);
  for (const row of log) {
    console.log(
      `  [${row.timestamp}] ${row.tool_name} agent=${row.agent_id} decision=${row.gate_decision}` +
        (row.gate_reason ? ` reason="${row.gate_reason}"` : "")
    );
  }

  await client.close();
}

main().catch((err) => {
  console.error("demo-attack failed:", err);
  process.exit(1);
});
