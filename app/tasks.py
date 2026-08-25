import os
import uuid

from app.db import get_db


def create_task(*, agent: str, payload: dict, thread_id: str | None = None) -> dict:
    """Create a task_state row. Returns the inserted row (has task_id, thread_id).

    user_id is hardcoded to DEV_USER_ID for now — there's no real auth yet.
    Replace with the authenticated user's id once Supabase Auth is wired in.
    """
    row = {
        "user_id": os.environ["DEV_USER_ID"],
        "thread_id": thread_id or str(uuid.uuid4()),
        "agent": agent,
        "status": "in_progress",
        "payload": payload,
    }
    result = get_db().table("task_state").insert(row).execute()
    return result.data[0]


def update_task(task_id: str, *, status: str | None = None, payload_patch: dict | None = None) -> dict:
    """Update a task's status and/or merge new keys into its payload."""
    db = get_db()

    update = {}
    if status is not None:
        update["status"] = status

    if payload_patch is not None:
        current = db.table("task_state").select("payload").eq("task_id", task_id).single().execute()
        merged = {**current.data["payload"], **payload_patch}
        update["payload"] = merged

    result = db.table("task_state").update(update).eq("task_id", task_id).execute()
    return result.data[0]


def find_task_by_payment_id(payment_id: str, status: str = "in_progress") -> dict | None:
    """Used by the webhook receiver to find which task a Razorpay event belongs to."""
    result = (
        get_db()
        .table("task_state")
        .select("*")
        .eq("status", status)
        .contains("payload", {"payment_id": payment_id})
        .execute()
    )
    return result.data[0] if result.data else None
