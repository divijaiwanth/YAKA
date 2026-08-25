import hashlib
import hmac
import json
import os

from app.tasks import find_task_by_payment_id, update_task
from app.tool_log import log_success


def verify_signature(raw_body: bytes, signature: str) -> bool:
    secret = os.environ["RAZORPAY_WEBHOOK_SECRET"].encode()
    expected = hmac.new(secret, raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def _extract_payment_id(payload: dict) -> str | None:
    if "payment" in payload:
        return payload["payment"]["entity"]["id"]
    if "refund" in payload:
        return payload["refund"]["entity"]["payment_id"]
    return None


async def handle_razorpay_webhook(raw_body: bytes, signature: str) -> dict:
    if not verify_signature(raw_body, signature):
        raise ValueError("invalid webhook signature")

    event = json.loads(raw_body)
    event_type = event.get("event", "unknown")
    payload = event.get("payload", {})

    payment_id = _extract_payment_id(payload)
    if not payment_id:
        return {"status": "ignored", "reason": "couldn't resolve a payment_id from this event"}

    task = find_task_by_payment_id(payment_id, status="waiting_external")
    if task is None:
        return {"status": "ignored", "reason": f"no task currently waiting on payment {payment_id}"}

    entity = (payload.get("payment") or payload.get("refund"))["entity"]
    update_task(
        task["task_id"],
        status="resolved",
        payload_patch={"webhook_event": event_type, "last_status": entity.get("status")},
    )

    log_success(
        agent="webhook-receiver",
        tool=f"webhook:{event_type}",
        args={"payment_id": payment_id},
        result=event,
        task_id=task["task_id"],
    )

    return {"status": "resolved", "task_id": task["task_id"]}
