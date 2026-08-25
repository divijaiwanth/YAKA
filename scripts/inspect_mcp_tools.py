"""Dev utility: spawn the Razorpay MCP server and list its real tools.

Run with: uv run python scripts/inspect_mcp_tools.py
"""

import asyncio
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

from dotenv import load_dotenv
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

load_dotenv()


async def main():
    key_id = os.environ["RAZORPAY_KEY_ID"]
    key_secret = os.environ["RAZORPAY_KEY_SECRET"]

    params = StdioServerParameters(
        command="docker",
        args=[
            "run",
            "-i",
            "--rm",
            "-e",
            f"RAZORPAY_KEY_ID={key_id}",
            "-e",
            f"RAZORPAY_KEY_SECRET={key_secret}",
            "razorpay/mcp",
        ],
    )

    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.list_tools()

            print(f"\n{len(result.tools)} tools exposed:\n")
            for tool in result.tools:
                required = tool.input_schema.get("required", [])
                print(f"- {tool.name}")
                print(f"    {tool.description}")
                print(f"    required args: {required}")
                print()


if __name__ == "__main__":
    asyncio.run(main())
