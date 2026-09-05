# Yaka — developer documentation

This is the "read this before you tell anyone about it" doc — a plain-language
walkthrough of what was actually built, why it's shaped this way, what's
genuinely proven vs. what's a known limitation, and the two real bugs that
got found and fixed along the way. The `README.md` in this folder is the
public-facing pitch; this file is the honest internal one.

## 1. What this actually is

An MCP (Model Context Protocol) server. That means: it's a program that
exposes a small set of "tools" that any MCP client (Claude Desktop,
Claude Code, or any other MCP-compatible LLM agent) can call. Five tools,
wrapping Razorpay's payment API:

- `create_mandate` — registers a recurring-payment mandate (eNACH or UPI
  Autopay) with Razorpay. Not gated — mandates don't move money.
- `charge_payment` — charges money against an existing mandate. Gated.
- `capture_payment` — confirms an already-authorized payment. Gated.
- `create_refund` — refunds a payment back to whoever paid it. Gated.
- `create_instant_settlement` — settles your balance to your own bank
  account. Gated.

The point of the project isn't "an LLM can now pay people" — plenty of
things can call a payment API. The point is: **an LLM agent using this
server physically cannot skip the safety checks on any of the four gated
operations**, no matter what it's told to do, because the checks aren't
something it could choose to skip in the first place — and they're the
*same* checks and the *same* shared spending tracking for all four, not
four separate ad-hoc implementations.

## 2. The core architecture decision, explained properly

A common (weak) pattern for "AI safety" in agent tooling looks like this:

```
Tools exposed: check_spending_limit, charge_payment
```

An LLM agent is *supposed* to call `check_spending_limit` before
`charge_payment`. But "supposed to" is a prompt-level convention, not an
enforced rule. A confused agent, a prompt injection, a badly-written
system prompt, or just an LLM cutting a corner under time pressure can
call `charge_payment` directly and skip the check entirely. The check
exists, but it's optional in practice.

This project does not expose a `check_spending_limit` tool at all. There
is no tool call that represents "the decision to check." The check runs
**inside** every gated tool's own handler, unconditionally, before a
single line of Razorpay-calling code executes. From the LLM's point of
view, calling a gated tool and having it get blocked isn't a check it
failed to run — it's just what that tool does sometimes. There is no
alternate code path that reaches Razorpay without going through the gate
first. See `src/guardedTool.ts::executeGuarded` — the gate call is the
literal first thing that happens, and every gated tool handler (in
`src/tools/`) calls it instead of touching Razorpay directly.

**Why the gate itself is plain deterministic code, not an LLM call**: a
check that can block real money movement needs to be auditable and
predictable — the same input always produces the same allow/block
decision, and that decision can be unit-tested in isolation
(`policyGate.ts` is a pure function). An LLM-based judgment call would
reintroduce exactly the unreliability this project exists to remove. The
LLM's job is deciding *what* to attempt; it has no say in whether the
attempt is *allowed*.

## 3. System diagram

```mermaid
flowchart TD
    Agent["LLM agent<br/>(Claude Desktop / Claude Code / any MCP client)"]
    MCP["MCP protocol boundary<br/>(stdio)"]

    subgraph Server["Yaka server process"]
        direction TB
        CM["create_mandate handler<br/>(not gated)"]

        subgraph GatedTools["4 gated tool handlers"]
            CP["charge_payment"]
            CAP["capture_payment"]
            REF["create_refund"]
            SET["create_instant_settlement"]
        end

        Guard["guardedTool.ts::executeGuarded()<br/>ONE shared pipeline for all four"]
        Gate{"policyGate()<br/>VELOCITY_LIMIT → AMOUNT_CAP → PAYEE_SPRAWL"}
        Idem{"tryReserve()<br/>atomic SQLite claim"}
        RZP["Razorpay test-mode API"]
        Log["insertAuditLog()"]
    end

    DB[("SQLite<br/>idempotency_store + audit_log<br/>shared across every gated tool")]

    Agent -->|"tool call"| MCP --> CM
    MCP --> GatedTools --> Guard

    Guard --> Gate
    Gate -->|"blocked"| Log
    Gate -->|"allowed"| Idem
    Idem -->|"lost race: already claimed"| Wait["await the winner's real result"]
    Wait --> Log
    Idem -->|"won race"| RZP --> Log

    CM -->|"always"| RZP2["Razorpay: create customer + mandate order"]
    RZP2 --> Log

    Log --> DB
    Log -->|"result"| MCP --> Agent
```

The generalization from a single hardcoded `charge_payment` check to this
shared pipeline is itself worth understanding, since it's a real
refactor, not just "add three more if-statements": `policyGate.ts` used
to take `{payeeId, amount, mandateId, purpose}` — a shape specific to one
tool. It now takes `{amount, counterparty?}` — the two facts *any*
money-moving call has, with `counterparty` optional because it only makes
sense for some operations (see §4's table). Similarly, the idempotency
hash used to be a hardcoded string template
(`` `${payeeId}:${amount}:${mandateId}:${purpose}` ``); it's now
`computeIntentHash(toolName, args)` in `src/intentHash.ts`, generic to any
tool's argument shape. Neither change was optional — without them, adding
a second gated tool would have meant copy-pasting the gate/idempotency
logic into a second file with tool-specific values hardcoded in, which is
exactly the kind of duplication that makes a "policy layer" claim false.

## 4. File-by-file walkthrough

**`src/index.ts`** — the MCP server entrypoint. Registers all five tools
with the SDK, wires each one's Zod input schema, starts a stdio
transport. This file has zero business logic — it's pure protocol
plumbing. One operational rule worth remembering: **never `console.log`
here** (or in anything it imports at startup) — stdout *is* the MCP
protocol channel; a stray log line would corrupt every message after it.
Use `console.error` for anything you want visible in a terminal.

**`src/guardedTool.ts`** — the actual policy layer. One function,
`executeGuarded()`, implementing the exact four-step contract every gated
tool needs:
1. `policyGate(...)` — if blocked, return the refusal and stop. Nothing
   below this line runs.
2. `tryReserve(hash)` — atomically claim this exact tool-call intent. See
   §6 for why this has to be atomic.
3. If we won the reservation: actually call Razorpay (via the `execute`
   callback the caller provides), store whatever comes back (success or
   error).
4. Log the attempt either way.

Every gated tool handler calls this instead of reimplementing any of it.

**`src/tools/chargePayment.ts`**, **`capturePayment.ts`**,
**`createRefund.ts`**, **`createInstantSettlement.ts`** — each one is
now thin: a Zod schema, and one call into `executeGuarded()` that
describes what "amount" and "counterparty" mean for that specific
Razorpay operation (see the table in `README.md` for which tools have a
counterparty) plus a one-line `execute` callback pointing at the actual
Razorpay-calling function in `src/razorpay.ts`. Adding a sixth gated tool
means writing one file this size, not reimplementing the gate.

**`src/tools/createMandate.ts`** — the one ungated tool: no policy checks
(mandates don't move money by themselves), just call Razorpay and log the
attempt directly (doesn't go through `executeGuarded`).

**`src/policyGate.ts`** — the three checks, in the exact order the spec
requires (velocity, then amount, then payee sprawl), generalized to work
off `{amount, counterparty?}` rather than one tool's specific argument
shape (see §3 for why this generalization was a real refactor, not
cosmetic). Pure function — given an input and the current state of
`audit_log`, deterministically returns allow/block. No side effects, easy
to reason about, easy to unit test.

**`src/intentHash.ts`** — one function, `computeIntentHash(toolName,
args)`: the idempotency key for any gated tool call, generic to that
tool's argument shape.

**`src/db.ts`** — the only file that touches SQLite. Two tables:
`idempotency_store` (the dedupe mechanism) and `audit_log` (the full
history, across every tool). Also computes "today's spend" and "today's
distinct counterparties" **across every gated tool combined** (a
parameterized `tool_name IN (...)` query, not one hardcoded tool name) —
see §6 for a subtlety in how that avoids double-counting deduped retries.

**`src/razorpay.ts`** — the only file that talks to the actual Razorpay
API. Deliberately "dumb" — it doesn't know about policy checks or
idempotency, just how to shape a correct request for each of the five
operations and how to pull a real error message out of Razorpay's error
objects (`extractRazorpayError`, used by `guardedTool.ts` too — see §7).

**`demo-attack.ts`** — not part of the server. A separate script that
plays the role of a misbehaving agent: spawns its own instance of the
server (exactly like a real MCP client would) and fires five scenarios at
it — the original four from the spec, plus a fifth proving the daily cap
is genuinely shared across different tools, not tracked per-tool.

## 5. What's actually proven vs. what isn't

**Proven, with real evidence, not just "should work":**
- The policy gate blocks before Razorpay is ever called (confirmed live,
  both via `demo-attack.ts` and via an actual Claude Desktop conversation
  where a ₹15,000 charge against a ₹5,000 daily cap was blocked with a
  clear reason and zero Razorpay calls made)
- **The gate is genuinely shared across tools, not per-tool** — a
  `capture_payment` call gets blocked by `VELOCITY_LIMIT` using spend a
  *different* tool (`charge_payment`) already accumulated the same day.
  This is the core claim of calling this a "policy layer" rather than a
  point fix, and it's demonstrated, not just architected.
- Idempotency holds under real concurrency, not just sequential retries —
  5 identical charges fired *simultaneously* result in exactly 1 real
  Razorpay attempt
- `create_mandate` with `method: "upi_autopay"` creates a real customer
  and a real mandate order in Razorpay's sandbox
- `capture_payment`, `create_refund`, and `create_instant_settlement` all
  make real, correctly-shaped calls to Razorpay and get back real,
  informative responses (verified individually, outside the demo script)
- The audit log accurately reflects every attempt, in the exact schema
  the spec asked for

**Not proven — and here's exactly why, which matters for how you talk
about this:**
- A genuinely *successful* charge against a mandate. Razorpay's real
  recurring-payment charge requires a `token_id` that only exists after
  a customer completes authorization in their bank/UPI app — a step that
  fundamentally cannot be scripted headlessly. This isn't a gap in the
  implementation; it's a property of how mandate-based payments actually
  work. The charge code path is real and correctly shaped (verified
  against Razorpay's own documented request format); it gets a real
  rejection from Razorpay in response, which is exactly what should
  happen without an authorized token.
- `create_mandate` with `method: "emandate"` — consistently fails with a
  generic `SERVER_ERROR` (HTTP 502, `source: "internal"`) even when using
  Razorpay's own documented example values verbatim, retried across
  multiple attempts. This has the same signature as a different issue
  found earlier in this Razorpay sandbox account (refunds were similarly
  blocked with a generic error) — almost certainly an account-level
  feature that isn't activated for this test account, not a bug in the
  code. **Lead your demo with `upi_autopay`, which works end to end.**
- `create_instant_settlement` — Razorpay rejects this outright in test
  mode, by design, stated explicitly in the error:
  `"Instant Settlements cannot be created in test mode"`. Not
  account-specific like the eMandate issue above — this is universal to
  every Razorpay sandbox. The policy-gate/idempotency/audit-log behavior
  around this tool is still fully verified; only the underlying
  settlement itself can't succeed outside a live account.
- `create_refund` — hits the exact same generic `"invalid request sent"`
  restriction on this sandbox account that was found and documented
  before this project's rename (see the git history / the original
  `razorpay-guardrail` era) — reproducible via a direct, unmediated call
  to Razorpay's API, so it's Razorpay's account configuration, not this
  code.

## 6. Bug #1: the idempotency race condition (and why it's worth mentioning in your pitch)

The first version of `chargePayment.ts` did this:
1. Look up whether this intent hash already has a cached result.
2. If not, call Razorpay (an `await` — async, takes real time).
3. Store the result.

This looks reasonable and is a common pattern. It's also broken under
concurrency. When `demo-attack.ts` fired 5 identical charges via
`Promise.all` (genuinely simultaneously, not one after another), all 5
executions reached step 1 and found nothing cached — because none of the
5 had reached step 3 yet. Result: all 5 called Razorpay for real. The
"only 1 real call" property the spec explicitly asks to demonstrate was
silently broken.

The fix: replace "look up, then later store" with a single atomic
operation — `INSERT INTO idempotency_store (...) VALUES (...) ON CONFLICT
DO NOTHING`, checking whether the insert actually happened
(`result.changes === 1`). Because `better-sqlite3` executes synchronously,
this one statement can't be interleaved with another call's `await` —
exactly one caller can ever "win" the reservation for a given hash.
Callers that lose the race wait for the winner's real result
(`awaitIdempotentResult`, a short poll loop) instead of getting an
ambiguous "try again" response.

This is worth stating explicitly if anyone asks about this project's
robustness: the naive version of idempotency looked correct in casual
testing (fire one request, see it work) and only broke under real
concurrent load — which is exactly the scenario `demo-attack.ts` was
designed to catch, and did.

## 7. Bug #2: mandate creation had the amount backwards

Razorpay's mandate/authorization order API is unintuitive on first read:
the order's own `amount` field is *not* the mandate's spending cap — that
lives entirely in `token.max_amount`. The order-level `amount` instead
represents what gets charged *right now*, during registration, which per
Razorpay's docs must be `0` for eMandate and a nominal ₹1 minimum for UPI
Autopay. The first version of `createRazorpayMandate` passed the mandate's
real cap as the order's top-level `amount`, which Razorpay correctly
rejected. Fixed by looking up Razorpay's actual documented example
request bodies rather than guessing from the field name.

A second, smaller bug surfaced while fixing the first one: the synthetic
customer contact/email was fully deterministic from `payeeId`, so calling
`create_mandate` twice for the same payee tried to create the same
customer twice. Razorpay's own Node SDK has a confirmed bug
([razorpay/razorpay-node#381](https://github.com/razorpay/razorpay-node/issues/381))
where its `fail_existing: 0` option (meant to return the existing
customer instead of erroring) doesn't reliably work. Rather than working
around a confirmed third-party SDK bug, the fix makes the synthetic
contact unique per call — sidesteps the collision entirely.

## 8. If you want to extend this

- **A new gated Razorpay operation**: write a file in `src/tools/` the
  size of `capturePayment.ts` (schema + one `executeGuarded()` call), add
  the actual Razorpay-calling function to `src/razorpay.ts`, register it
  in `src/index.ts`, and add its name to `GATED_TOOLS` in `policyGate.ts`
  if it should share the daily cap. That's the whole checklist — the
  pattern is proven across four different operations now, not just
  theorized for one.
- **A real authorization flow**: would need a checkout/redirect step for
  the customer to approve the mandate in their bank/UPI app, then a
  webhook to receive the resulting `token_id`. Out of scope for this
  hackathon slice on purpose (see spec: "no webhook handling beyond
  what's needed for the charge to complete in test mode").
- **More policy checks**: add a case to `policyGate.ts` — it's a pure
  function, easy to extend, easy to unit test in isolation.
- **A real approval/human-in-the-loop flow**: explicitly out of scope per
  the original spec, but architecturally it would slot in as a fourth
  gate check that returns a "pending approval" state instead of
  allow/block, with a separate tool or channel to actually approve.
- **The bigger picture**: this server is one node (the MCP policy gateway)
  in a larger planned multi-agent ledger architecture — see the
  "Roadmap" section in `README.md` for the full diagram. Concretely, that
  means: `audit_log`/`idempotency_store` are local SQLite scoped to this
  one server today; the planned version is a shared Postgres ledger a
  master/orchestrator and multiple worker agents all write to, with an
  evaluator agent that can loop a worker back for more evidence instead
  of just allow/block, and a real SIEM/alerting integration for genuine
  anomalies (distinct from a routine policy-gate block, which is expected,
  normal behavior, not an incident).
- **Voice briefing mode**: a planned feature, not yet started — a spoken,
  regional-language summary of payments in flight and upcoming, generated
  from the ledger. Shape it as a separate read-only consumer of
  `audit_log`/the future shared ledger (never a write path), e.g. an LLM
  turns a query over recent/pending rows into a short natural-language
  script, then a TTS engine with regional-language voices speaks it. Keep
  it downstream of the safety layer, not part of it — it should never be
  able to trigger or approve anything, only report.

## 9. Operational notes

See `README.md` for the actual setup/run commands. One thing worth
knowing that isn't obvious: **Claude Desktop runs the compiled `dist/`
output, not the TypeScript source** — `npm run build` after any source
change, then fully restart Claude Desktop (quit, not just close the
window), or it keeps running the old code.
