# Yaka — MVP architecture (v2, scoped to buildathon week)

Single flow only: payment-failure investigation. Everything routes through the
Orchestrator — no agent talks to a tool or the DB directly.

```mermaid
flowchart TD
    Client["Client<br/>(React chat UI)"]

    subgraph SYNC["Synchronous request flow"]
        direction TB
        API["FastAPI<br/>(Supabase Auth session, cached after first check)"]
        Dispatcher["Dispatcher Agent (Groq)<br/>classifies intent"]
        Expert["Expert Agent<br/>payment-failure investigation<br/>(the ONE flow for MVP)"]
        Idem{"State-changing<br/>tool call?"}
        RedisCheck["Redis idempotency check<br/>hash(task_id + tool + args)"]
        Confirm["Human confirmation<br/>required before execute"]
        MCP["Razorpay MCP server<br/>(Docker, stdio transport)"]
        Evaluator["Evaluator Agent<br/>loop guard + drift/security check"]
    end

    subgraph ASYNC["Async / long-running flow"]
        direction TB
        Webhook["Razorpay webhook receiver<br/>(FastAPI route)"]
        Realtime["Supabase Realtime<br/>(Postgres change subscription)"]
        Resume["Agent resumes SAME chat thread<br/>with a status update"]
    end

    DB[("Postgres / Supabase<br/>task_state, tool_call_log")]

    Client -->|"query"| API --> Dispatcher --> Expert
    Expert --> Idem
    Idem -->|"read-only"| RedisCheck
    Idem -->|"yes"| Confirm --> RedisCheck
    RedisCheck --> MCP
    MCP -->|"result"| Evaluator
    Evaluator -->|"pass"| Client
    Evaluator -.->|"fail: loop/drift/security"| Client

    Expert -.->|"log every tool call"| DB
    MCP -.->|"log every tool call"| DB
    Evaluator -.->|"log verdict"| DB

    MCP -.->|"webhook fires on resolve"| Webhook
    Webhook --> DB
    DB --> Realtime --> Resume --> Client
```

## What changed from the v1 sketch, and why

- **One expert agent, not three generic Worker Agents.** MVP scope is a single
  flow (payment-failure investigation). Multiple workers, a company-tools MCP
  hub, and non-company basic tools are a real pattern — just not this week.
- **No agent calls a tool directly.** Every path to the Razorpay MCP server
  goes through the idempotency check (and, for state-changing calls, human
  confirmation) first. In the v1 sketch, Worker Agents and RAG pipelines had
  direct lines to tools and the DB, which meant governance was optional
  instead of guaranteed.
- **Idempotency (Redis) is drawn explicitly**, in front of every tool call —
  it was missing entirely from v1.
- **Human confirmation is a real node on the state-changing path**, not
  implied. Non-negotiable from the project scope: no autonomous financial
  actions.
- **One memory system for now: Postgres.** `task_state` /
  `tool_call_log` is the single source of truth for transaction/task state.
  The v1 sketch had three overlapping memory boxes (Recall Memory, Persistent
  memory segregator, Mem0) — Mem0 is real but it's a last-priority UX layer
  for conversational preferences, never the source of truth, and it's cut
  first if time runs short. It's not in this diagram at all yet.
- **Auth is Supabase, not a custom API Gateway AuthN/AuthZ layer.** Session
  gets cached after the first check so we're not making a network call to
  Supabase on every tool call.
- **No SIEM/alerting platform.** Real pattern, out of scope for zero-cost/1-week.
- **The async flow is drawn as a first-class citizen**, not omitted. Webhook
  → Postgres → Supabase Realtime → resume-the-same-thread is arguably Yaka's
  actual differentiator, so it's on the diagram, not an afterthought.
- **Evaluator sits between the tool result and the response**, not off to the
  side as a peer of the Worker Agents pointing at a separate Conflict
  Condition box. For MVP, "fail" just means the response doesn't go out
  clean — no SIEM escalation needed yet.
