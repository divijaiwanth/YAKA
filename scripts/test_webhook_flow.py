"""Dev utility: prove the webhook receiver actually resolves a waiting task.

Doesn't need a real pending Razorpay payment — creates a task_state row
directly in 'waiting_external' status, then sends a correctly-signed
synthetic webhook payload at the running server, same as Razorpay's real
servers would (minus the network hop, since we have no public tunnel yet).

Run with the server already running: uv run python scripts/test_webhook_flow.py
"""

import hashlib
import hmac
import json
import os

import httpx
from dotenv import load_dotenv

load_dotenv()

from app.db import get_db
from app.tasks import create_task

FAKE_PAYMENT_ID = "pay_test_webhook_demo_001"


def main():
    task = create_task(
        agent="payment-failure-investigation",
        payload={"payment_id": FAKE_PAYMENT_ID},
    )
    task_id = task["task_id"]
    get_db().table("task_state").update({"status": "waiting_external"}).eq("task_id", task_id).execute()
    print(f"created task {task_id}, status=waiting_external")

    event = {
        "entity": "event",
        "event": "payment.captured",
        "payload": {
            "payment": {
                "entity": {
                    "id": FAKE_PAYMENT_ID,
                    "status": "captured",
                    "amount": 50000,
                }
            }
        },
    }
    raw_body = json.dumps(event).encode()
    secret = os.environ["RAZORPAY_WEBHOOK_SECRET"].encode()
    signature = hmac.new(secret, raw_body, hashlib.sha256).hexdigest()

    resp = httpx.post(
        "http://localhost:8000/api/webhooks/razorpay",
        content=raw_body,
        headers={"Content-Type": "application/json", "X-Razorpay-Signature": signature},
    )
    print(f"webhook response: {resp.status_code} {resp.json()}")

    final = get_db().table("task_state").select("*").eq("task_id", task_id).single().execute()
    print(f"final task state: {json.dumps(final.data, indent=2, default=str)}")


if __name__ == "__main__":
    main()
