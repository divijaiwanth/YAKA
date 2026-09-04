// Local SQLite persistence — idempotency_store (dedupe charge attempts) and
// audit_log (every attempt, blocked or not, whether the gate stopped it).
// No external DB needed; one file, wiped between demo runs via `npm run reset`.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface AuditLogEntry {
  agentId: string;
  toolName: string;
  inputJson: string;
  gateDecision: "allowed" | "blocked";
  gateReason: string | null;
  resultJson: string | null;
}

// Raw shape as returned by SQLite — actual column names (snake_case),
// distinct from AuditLogEntry (the camelCase shape used to insert one).
export interface AuditLogRow {
  id: number;
  timestamp: string;
  agent_id: string;
  tool_name: string;
  input_json: string;
  gate_decision: "allowed" | "blocked";
  gate_reason: string | null;
  result_json: string | null;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = process.env.DB_PATH ?? "./data/guardrail.db";
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_store (
      intent_hash TEXT PRIMARY KEY,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_json TEXT NOT NULL,
      gate_decision TEXT NOT NULL,
      gate_reason TEXT,
      result_json TEXT
    );
  `);

  return db;
}

// Sentinel stored while the real Razorpay call is in flight, so concurrent
// duplicate calls (e.g. an agent firing the same charge 5x rapidly) can
// tell "already completed" apart from "someone else is mid-call right now".
const PENDING = "__pending__";

export function getIdempotentResult(intentHash: string): string | null {
  const row = getDb()
    .prepare("SELECT result_json FROM idempotency_store WHERE intent_hash = ?")
    .get(intentHash) as { result_json: string } | undefined;
  if (!row || row.result_json === PENDING) return null;
  return row.result_json;
}

// Atomically claims intentHash for this call. Returns true if THIS call won
// the race and should proceed to actually call Razorpay; false if another
// call already claimed it (either mid-flight or already completed).
//
// This has to be a single INSERT ... ON CONFLICT DO NOTHING, not a
// SELECT-then-INSERT — better-sqlite3 calls are synchronous/atomic
// individually, but the Razorpay call in between them is async, and Node's
// event loop can interleave several concurrent handleChargePayment() calls
// in that gap. A single atomic statement is what actually closes the race.
export function tryReserve(intentHash: string): boolean {
  const result = getDb()
    .prepare(`INSERT INTO idempotency_store (intent_hash, result_json) VALUES (?, ?) ON CONFLICT(intent_hash) DO NOTHING`)
    .run(intentHash, PENDING);
  return result.changes === 1;
}

export function storeIdempotentResult(intentHash: string, resultJson: string): void {
  getDb()
    .prepare(
      `INSERT INTO idempotency_store (intent_hash, result_json) VALUES (?, ?)
       ON CONFLICT(intent_hash) DO UPDATE SET result_json = excluded.result_json`
    )
    .run(intentHash, resultJson);
}

// For a call that lost the reservation race: wait for the winner to finish
// and return its real result, rather than returning an ambiguous
// "in progress" response. Bounded so a genuinely stuck call can't hang
// this one forever.
export async function awaitIdempotentResult(intentHash: string, timeoutMs = 15000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = getIdempotentResult(intentHash);
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for a concurrent duplicate charge (${intentHash}) to resolve`);
}

export function insertAuditLog(entry: AuditLogEntry): void {
  getDb()
    .prepare(
      `INSERT INTO audit_log (agent_id, tool_name, input_json, gate_decision, gate_reason, result_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(entry.agentId, entry.toolName, entry.inputJson, entry.gateDecision, entry.gateReason, entry.resultJson);
}

export function getAuditLog(): AuditLogRow[] {
  return getDb().prepare("SELECT * FROM audit_log ORDER BY id ASC").all() as AuditLogRow[];
}

// Both spend and payee tracking read from DISTINCT input_json rows for
// today's *allowed* charge_payment attempts — since an exact repeat of the
// same (payeeId, amount, mandateId, purpose) produces an identical
// input_json string, this naturally collapses idempotent retries so they
// don't inflate the daily spend or payee count. No extra bookkeeping needed.
function todaysAllowedChargeInputs(agentId: string): Record<string, unknown>[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT input_json FROM audit_log
       WHERE agent_id = ? AND tool_name = 'charge_payment'
         AND gate_decision = 'allowed' AND date(timestamp) = date('now')`
    )
    .all(agentId) as { input_json: string }[];
  return rows.map((r) => JSON.parse(r.input_json));
}

export function getTodaysSpend(agentId: string): number {
  return todaysAllowedChargeInputs(agentId).reduce((sum, i) => sum + (Number(i.amount) || 0), 0);
}

export function getTodaysPayeeIds(agentId: string): string[] {
  return [...new Set(todaysAllowedChargeInputs(agentId).map((i) => String(i.payeeId)))];
}

// Demo utility: wipes both tables so the policy gate acts like a fresh day.
export function resetAll(): void {
  getDb().exec("DELETE FROM idempotency_store; DELETE FROM audit_log;");
}
