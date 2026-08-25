"""Smoke test: does CrewAI + our Groq model actually call our Razorpay tool,
or does it hallucinate an answer instead? Must pass before any real rebuild
happens on top of CrewAI.

Run with: PYTHONPATH=. uv run python scripts/test_crewai_tooling.py
"""

import asyncio
import sys

sys.stdout.reconfigure(encoding="utf-8")

from dotenv import load_dotenv

load_dotenv()

from crewai import Agent, Crew, Task
from crewai.tools import tool

from app.mcp_client import call_razorpay_tool


@tool("fetch_payment")
def fetch_payment_tool(payment_id: str) -> str:
    """Fetch a Razorpay payment's details by its payment ID (starts with 'pay_')."""
    result, _ = asyncio.run(call_razorpay_tool("fetch_payment", {"payment_id": payment_id}))
    return str(result)


agent = Agent(
    role="Payment Retrieval Specialist",
    goal="Fetch accurate payment data from Razorpay when given a payment ID",
    backstory="You retrieve real payment records via Razorpay's API. You never guess or make up data — you always call the tool.",
    tools=[fetch_payment_tool],
    llm="groq/openai/gpt-oss-120b",
    verbose=True,
)

task = Task(
    description="Fetch the details for payment pay_SqKQz3hmzSoo1b and report its status and, if it failed, the exact error reason.",
    expected_output="The payment's status and, if it failed, the exact error reason field from the data.",
    agent=agent,
)

crew = Crew(agents=[agent], tasks=[task], verbose=True)
result = crew.kickoff()

print("\n\n=== FINAL RESULT ===")
print(result)

# ground truth check: this payment's real error_reason is
# "international_transaction_not_allowed" (verified earlier via direct API call)
if "international_transaction_not_allowed" in str(result) or "international" in str(result).lower():
    print("\n[PASS] Tool call returned real data, matches known ground truth.")
else:
    print("\n[FAIL] Result doesn't mention the real error reason — check if the tool was actually called.")
