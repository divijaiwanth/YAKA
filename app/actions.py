"""Write actions the system is allowed to take on Razorpay — the only tools
that can ever move money. Every one of these MUST go through
/api/actions/propose then /api/actions/confirm; nothing here is ever called
directly from the chat flow. See docs/razorpay_mcp_tools.md for the full
tool inventory and why this whitelist is scoped this narrowly for the MVP.
"""

from app.idempotency import DuplicateInProgress, clear_pending, reserve_or_get_cached, store_result
from app.mcp_client import call_razorpay_tool
from app.tool_log import log_blocked_idempotent, log_error, log_success

AGENT_NAME = "human-confirmed-action"

WRITE_TOOLS = {
    "create_refund": {
        "required_args": ["payment_id", "amount"],
        "describe": lambda a: f"Refund payment {a['payment_id']} for {a['amount']} paise",
    },
    "capture_payment": {
        "required_args": ["payment_id", "amount", "currency"],
        "describe": lambda a: f"Capture payment {a['payment_id']} for {a['amount']} {a.get('currency', '')}",
    },
    "update_payment": {
        "required_args": ["payment_id", "notes"],
        "describe": lambda a: f"Update notes on payment {a['payment_id']}",
    },
}


def describe_action(tool: str, args: dict) -> str:
    if tool not in WRITE_TOOLS:
        raise ValueError(f"'{tool}' is not an allowed write action")

    spec = WRITE_TOOLS[tool]
    missing = [a for a in spec["required_args"] if a not in args]
    if missing:
        raise ValueError(f"missing required args for {tool}: {missing}")

    return spec["describe"](args)


async def execute_action(tool: str, args: dict) -> dict:
    """The ONLY path in the codebase allowed to actually run a write tool.
    Always call describe_action first to validate; this assumes that's done.
    """
    cached = await reserve_or_get_cached(tool, args)
    if cached is not None:
        log_blocked_idempotent(agent=AGENT_NAME, tool=tool, args=args, cached_result=cached)
        return cached

    try:
        result, latency_ms = await call_razorpay_tool(tool, args)
    except DuplicateInProgress:
        raise
    except Exception as exc:
        await clear_pending(tool, args)  # let a retry actually retry, don't cache the failure
        log_error(agent=AGENT_NAME, tool=tool, args=args, error=str(exc))
        raise

    await store_result(tool, args, result)
    log_success(agent=AGENT_NAME, tool=tool, args=args, latency_ms=latency_ms, result=result)
    return result
