from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

load_dotenv()

from app.actions import describe_action, execute_action
from app.agents.dispatcher import classify_intent
from app.agents.payment_failure_expert import investigate_payment_failure
from app.idempotency import DuplicateInProgress
from app.mcp_client import call_razorpay_tool
from app.tool_log import log_error, log_success
from app.webhooks import handle_razorpay_webhook

app = FastAPI(title="Yaka")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/payments")
async def list_payments():
    """Dev slice: prove backend -> Razorpay MCP -> Postgres logging works
    end to end, with no agent/dispatcher/idempotency logic yet."""
    tool_name = "fetch_all_payments"
    args = {}

    try:
        result, latency_ms = await call_razorpay_tool(tool_name, args)
    except Exception as exc:
        log_error(agent="dev-slice", tool=tool_name, args=args, error=str(exc))
        raise HTTPException(status_code=502, detail=str(exc))

    log_success(agent="dev-slice", tool=tool_name, args=args, latency_ms=latency_ms, result=result)
    return result


class ChatRequest(BaseModel):
    message: str
    thread_id: str | None = None


@app.post("/api/chat")
async def chat(req: ChatRequest):
    intent = await classify_intent(req.message)

    if intent["route"] != "payment_failure_investigation":
        return {"reply": "I can currently only help investigate why a specific payment failed. Try asking something like: \"why did payment pay_XXXXXXXX fail?\""}

    if not intent["payment_id"]:
        return {"reply": "I can look into that — what's the payment ID? It should start with 'pay_'."}

    return await investigate_payment_failure(intent["payment_id"], thread_id=req.thread_id)


class ActionRequest(BaseModel):
    tool: str
    args: dict


@app.post("/api/actions/propose")
def propose_action(req: ActionRequest):
    """Describes what a write action would do. Never touches Razorpay."""
    try:
        description = describe_action(req.tool, req.args)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return {"tool": req.tool, "args": req.args, "description": description}


@app.post("/api/actions/confirm")
async def confirm_action(req: ActionRequest):
    """The only route in the system allowed to execute a write action.
    Goes through the idempotency check before touching Razorpay."""
    try:
        describe_action(req.tool, req.args)  # re-validate, don't trust the client's earlier propose call
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    try:
        result = await execute_action(req.tool, req.args)
    except DuplicateInProgress as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    return {"result": result}


@app.post("/api/webhooks/razorpay")
async def razorpay_webhook(request: Request):
    raw_body = await request.body()
    signature = request.headers.get("X-Razorpay-Signature", "")

    try:
        return await handle_razorpay_webhook(raw_body, signature)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
