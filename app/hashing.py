import hashlib
import json


def args_hash(tool: str, args: dict) -> str:
    return hashlib.sha256(
        json.dumps({"tool": tool, "args": args}, sort_keys=True).encode()
    ).hexdigest()
