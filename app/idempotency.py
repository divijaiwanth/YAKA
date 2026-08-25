import json

from app.hashing import args_hash
from app.redis_client import get_redis

TTL_SECONDS = 600  # 10 min window to catch double-clicks/retries, not a long-term store
PENDING = "__pending__"


class DuplicateInProgress(Exception):
    """Same (tool, args) call is already being executed elsewhere right now."""


async def reserve_or_get_cached(tool: str, args: dict) -> dict | None:
    """Call before executing a write tool.

    Returns the cached result if this exact call already completed recently
    (caller should skip execution and return the cached result). Returns
    None if this is a new call (caller should proceed, then call
    store_result when done). Raises DuplicateInProgress if the same call is
    mid-flight right now (e.g. a double-click that arrived a second apart).
    """
    key = f"idem:{args_hash(tool, args)}"
    r = get_redis()

    claimed = await r.set(key, PENDING, nx=True, ex=TTL_SECONDS)
    if claimed:
        return None

    existing = await r.get(key)
    if existing == PENDING:
        raise DuplicateInProgress(f"{tool} with these args is already being processed")

    return json.loads(existing)


async def store_result(tool: str, args: dict, result: dict) -> None:
    key = f"idem:{args_hash(tool, args)}"
    await get_redis().set(key, json.dumps(result), ex=TTL_SECONDS)


async def clear_pending(tool: str, args: dict) -> None:
    """Call if execution fails, so a retry isn't blocked as a false duplicate."""
    key = f"idem:{args_hash(tool, args)}"
    await get_redis().delete(key)
