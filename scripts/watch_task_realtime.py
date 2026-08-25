"""Dev utility: stand-in for what the frontend will eventually do — subscribe
to task_state changes via Supabase Realtime and print them as they arrive
live. Proves the "system comes back and tells you" mechanism actually works,
independent of any UI.

Run with: uv run python scripts/watch_task_realtime.py
Leave it running, then trigger an update from another terminal (e.g. re-run
scripts/test_webhook_flow.py) and watch it print here within ~a second.
"""

import asyncio
import os
import sys

from dotenv import load_dotenv

sys.stdout.reconfigure(encoding="utf-8")
load_dotenv()

from supabase import acreate_client


async def main():
    client = await acreate_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])

    def on_update(payload):
        record = payload["data"]["record"]
        print(f"\n>>> LIVE UPDATE: task {record['task_id']} -> status={record['status']}")
        print(f"    payload: {record['payload']}\n")

    channel = client.channel("task_state_watch")
    channel.on_postgres_changes("UPDATE", callback=on_update, table="task_state", schema="public")
    await channel.subscribe()

    print("Subscribed to task_state changes. Waiting... (running for 30s)")
    await asyncio.sleep(30)


if __name__ == "__main__":
    asyncio.run(main())
