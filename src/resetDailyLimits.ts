// Demo utility: clears both tables so the policy gate acts like a fresh
// day, without restarting the MCP server or waiting for midnight.
// Run with: npm run reset

import "dotenv/config";

import { resetAll } from "./db.js";

function main(): void {
  resetAll();
  console.log("Reset: idempotency_store and audit_log cleared.");
}

main();
