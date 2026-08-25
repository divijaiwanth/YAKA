import json
import os

from groq import AsyncGroq

MODEL = "openai/gpt-oss-120b"

SYSTEM_PROMPT = """You route user messages for Yaka, a payment support assistant.
Right now there is exactly one capability: investigating why a specific
Razorpay payment failed.

Reply with ONLY a JSON object, no other text:
{"route": "payment_failure_investigation" | "unsupported", "payment_id": "pay_xxx" or null}

- route = "payment_failure_investigation" if the user is asking about a
  payment failing, being declined, an error, or wants to know what happened
  with a payment/transaction.
- payment_id = the Razorpay payment ID if one appears in the message
  (starts with "pay_"), otherwise null.
- route = "unsupported" for anything else.
"""


async def classify_intent(message: str) -> dict:
    client = AsyncGroq(api_key=os.environ["GROQ_API_KEY"])

    response = await client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": message},
        ],
        response_format={"type": "json_object"},
        temperature=0,
    )

    return json.loads(response.choices[0].message.content)
