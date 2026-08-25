from app.db import get_db
from app.hashing import args_hash as _args_hash


def log_success(*, agent: str, tool: str, args: dict, result: dict, latency_ms: int | None = None, task_id: str | None = None):
    get_db().table("tool_call_log").insert(
        {
            "task_id": task_id,
            "agent": agent,
            "tool": tool,
            "args": args,
            "args_hash": _args_hash(tool, args),
            "status": "success",
            "latency_ms": latency_ms,
            "result": result,
        }
    ).execute()


def log_error(*, agent: str, tool: str, args: dict, error: str, task_id: str | None = None):
    get_db().table("tool_call_log").insert(
        {
            "task_id": task_id,
            "agent": agent,
            "tool": tool,
            "args": args,
            "args_hash": _args_hash(tool, args),
            "status": "error",
            "result": {"error": error},
        }
    ).execute()


def log_blocked_idempotent(*, agent: str, tool: str, args: dict, cached_result: dict, task_id: str | None = None):
    get_db().table("tool_call_log").insert(
        {
            "task_id": task_id,
            "agent": agent,
            "tool": tool,
            "args": args,
            "args_hash": _args_hash(tool, args),
            "status": "blocked_idempotent",
            "result": cached_result,
        }
    ).execute()
