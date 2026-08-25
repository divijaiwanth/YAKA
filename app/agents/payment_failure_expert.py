import os

from groq import AsyncGroq

from app.mcp_client import call_razorpay_tool
from app.tasks import create_task, update_task
from app.tool_log import log_error, log_success

MODEL = "openai/gpt-oss-120b"
AGENT_NAME = "payment-failure-investigation"

# Razorpay payment statuses that won't change on their own — nothing to wait
# on. Anything else (e.g. "created", "authorized") might still resolve later,
# which is what the webhook + Realtime resume flow is for.
TERMINAL_STATUSES = {"captured", "failed", "refunded"}

SYSTEM_PROMPT = """You are a payment support expert explaining Razorpay
payment data to a merchant. You'll be given the raw JSON for one payment.

Explain, in 2-4 plain-language sentences:
- what happened to this payment (succeeded, failed, refunded, etc.)
- if it failed: the actual reason, in plain language, not just the raw
  error code
- one concrete next step the merchant could take, if relevant

Don't invent information that isn't in the JSON. If the payment succeeded,
just say so clearly, don't manufacture a "failure" explanation.
"""


async def investigate_payment_failure(payment_id: str, thread_id: str | None = None) -> dict:
    task = create_task(
        agent=AGENT_NAME,
        payload={"payment_id": payment_id},
        thread_id=thread_id,
    )
    task_id = task["task_id"]

    tool_name = "fetch_payment"
    args = {"payment_id": payment_id}

    try:
        payment, latency_ms = await call_razorpay_tool(tool_name, args)
    except Exception as exc:
        log_error(agent=AGENT_NAME, tool=tool_name, args=args, error=str(exc), task_id=task_id)
        update_task(task_id, status="failed", payload_patch={"error": str(exc)})
        return {
            "reply": f"I couldn't find a payment with ID {payment_id} — double check the ID and try again.",
            "task_id": task_id,
            "thread_id": task["thread_id"],
        }

    log_success(agent=AGENT_NAME, tool=tool_name, args=args, latency_ms=latency_ms, result=payment, task_id=task_id)

    client = AsyncGroq(api_key=os.environ["GROQ_API_KEY"])
    response = await client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Payment data:\n{payment}"},
        ],
        temperature=0,
    )
    reply = response.choices[0].message.content

    is_final = payment.get("status") in TERMINAL_STATUSES
    update_task(
        task_id,
        status="resolved" if is_final else "waiting_external",
        payload_patch={"last_status": payment.get("status"), "reply": reply},
    )

    if not is_final:
        reply += (
            f"\n\nThis payment is still \"{payment.get('status')}\" — not final yet. "
            "I'll let you know as soon as it resolves."
        )

    return {"reply": reply, "task_id": task_id, "thread_id": task["thread_id"]}
