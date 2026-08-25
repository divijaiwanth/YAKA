import json
import os
import time

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def call_razorpay_tool(tool_name: str, args: dict) -> tuple[dict, int]:
    """Spawn the Razorpay MCP server, call one tool, return (result, latency_ms).

    Spawns a fresh container per call for now — simplest thing that works.
    If per-call container startup latency turns out to matter once agents
    are chaining multiple calls, switch to a long-lived session instead.
    """
    params = StdioServerParameters(
        command="docker",
        args=[
            "run",
            "-i",
            "--rm",
            "-e",
            f"RAZORPAY_KEY_ID={os.environ['RAZORPAY_KEY_ID']}",
            "-e",
            f"RAZORPAY_KEY_SECRET={os.environ['RAZORPAY_KEY_SECRET']}",
            "razorpay/mcp",
        ],
    )

    start = time.monotonic()
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(tool_name, args)
    latency_ms = int((time.monotonic() - start) * 1000)

    text = result.content[0].text if result.content else "{}"
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = {"raw": text}

    if result.is_error:
        raise RuntimeError(f"MCP tool '{tool_name}' failed: {parsed}")

    return parsed, latency_ms
