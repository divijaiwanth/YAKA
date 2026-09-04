// Thin wrapper around the Razorpay Node SDK, test-mode credentials only.
// Nothing here knows about policy checks or idempotency — that's the
// caller's job. This file only knows how to talk to Razorpay.
//
// IMPORTANT real-world constraint: a genuinely chargeable eNACH/UPI Autopay
// mandate requires the *customer* to authorize it in their bank/UPI app —
// that step cannot be scripted headlessly. createRazorpayMandate makes a
// real, correctly-shaped call to create the mandate ORDER (which succeeds
// in test mode on its own). chargeRazorpayMandate makes a real,
// correctly-shaped call to Razorpay's actual recurring-payment endpoint,
// but without a truly-authorized token it will most likely be rejected by
// Razorpay — that rejection is returned as real data, not silently faked
// into a fake success.

import Razorpay from "razorpay";

// The Razorpay SDK rejects with a plain { statusCode, error: { code,
// description, ... } } object, not an Error instance — String(err) on that
// just gives "[object Object]". Pull the real message out.
export function extractRazorpayError(err: unknown): string {
  if (err && typeof err === "object" && "error" in err) {
    const inner = (err as { error?: { code?: string; description?: string } }).error;
    if (inner?.description) return `${inner.code ?? "RAZORPAY_ERROR"}: ${inner.description}`;
  }
  if (err instanceof Error) return err.message;
  return JSON.stringify(err);
}

let client: Razorpay | null = null;

function getClient(): Razorpay {
  if (!client) {
    client = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID!,
      key_secret: process.env.RAZORPAY_KEY_SECRET!,
    });
  }
  return client;
}

export interface CreateMandateArgs {
  payeeId: string;
  amount: number;
  method: "emandate" | "upi_autopay";
  purpose: string;
}

export interface CreateMandateResult {
  mandateId: string;
  status: string;
  raw: unknown;
}

export interface ChargeMandateArgs {
  mandateId: string;
  amount: number;
}

export interface ChargeMandateResult {
  paymentId: string | null;
  status: string;
  raw: unknown;
}

function hashString(s: string): number {
  let hash = 0;
  for (const c of s) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return hash;
}

// Synthetic contact/email for a payeeId — our tool inputs don't carry real
// customer contact details, this keeps the demo self-contained. Includes a
// per-call random component (not purely deterministic from payeeId) so
// repeated create_mandate calls never collide with an existing Razorpay
// customer: the Node SDK's `fail_existing: 0` (meant to return the existing
// customer instead of erroring) is a confirmed SDK bug — it still throws
// "Customer already exists for the merchant" — and there's no supported
// way to look an existing customer up by contact/email through this SDK.
// Simplest robust fix: never collide in the first place.
function syntheticContact(payeeId: string) {
  const unique = `${hashString(payeeId)}${Date.now().toString().slice(-6)}`;
  const contact = `9${unique.padStart(9, "0").slice(0, 9)}`;
  return { email: `${payeeId}+${unique}@guardrail.test`, contact, name: `Payee ${payeeId}` };
}

// A mandate/authorization order is a REGISTRATION, not a charge — Razorpay
// requires the order's own `amount` to be 0. The mandate's actual spending
// cap lives entirely in `token.max_amount`. (Confirmed against Razorpay's
// docs: https://razorpay.com/docs/api/payments/recurring-payments/emandate/create-authorization-transaction/
// — getting this backwards is exactly what caused the "amount should be 0"
// rejection from Razorpay when this was first wired up.)
export async function createRazorpayMandate(args: CreateMandateArgs): Promise<CreateMandateResult> {
  const rzp = getClient();
  const { email, contact, name } = syntheticContact(args.payeeId);

  const customer = await rzp.customers.create({
    name,
    email,
    contact,
    fail_existing: 0,
  });

  const expireAt = Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60;
  const notes = {
    payeeId: args.payeeId,
    purpose: args.purpose,
    customerId: customer.id,
    customerEmail: email,
    customerContact: String(contact),
  };

  const token =
    args.method === "upi_autopay"
      ? { max_amount: args.amount, expire_at: expireAt, frequency: "as_presented" }
      : {
          // eMandate registration needs bank details to pre-fill on
          // checkout — synthetic test-mode values, same reasoning as
          // syntheticContact() above (no real bank details in our inputs).
          auth_type: "netbanking" as const,
          max_amount: args.amount,
          expire_at: expireAt,
          bank_account: {
            beneficiary_name: name,
            account_number: `${Math.abs(hashString(args.payeeId))}`.padEnd(11, "0").slice(0, 11),
            ifsc_code: "HDFC0000053", // well-known Razorpay test-mode IFSC
          },
        };

  const order = await rzp.orders.create({
    // eMandate registration orders must be amount: 0 (confirmed via
    // Razorpay docs). UPI Autopay registration rejects 0 — "the minimum
    // mandate amount across all categories is ₹1" — so it needs a nominal
    // authorization amount instead. Both are real, documented per-method
    // requirements, not the same rule.
    amount: args.method === "upi_autopay" ? 100 : 0,
    currency: "INR",
    method: args.method === "upi_autopay" ? "upi" : "emandate",
    customer_id: customer.id,
    token,
    notes,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  return { mandateId: order.id, status: order.status, raw: order };
}

export async function chargeRazorpayMandate(args: ChargeMandateArgs): Promise<ChargeMandateResult> {
  const rzp = getClient();

  const mandateOrder = await rzp.orders.fetch(args.mandateId);
  const notes = (mandateOrder.notes ?? {}) as Record<string, string>;

  const chargeOrder = await rzp.orders.create({
    amount: args.amount,
    currency: "INR",
    notes: { chargeFor: args.mandateId },
  });

  const result = await rzp.payments.createRecurringPayment({
    amount: args.amount,
    currency: "INR",
    order_id: chargeOrder.id,
    email: notes.customerEmail,
    contact: notes.customerContact,
    customer_id: notes.customerId,
    // No real authorized token exists without the customer completing
    // bank/UPI app authorization — see file header. Best-effort reference,
    // Razorpay is expected to reject this in most sandbox setups.
    token: args.mandateId,
    notes: { mandateId: args.mandateId },
    recurring: true,
  });

  return {
    paymentId: result.razorpay_payment_id ?? null,
    status: "submitted",
    raw: result,
  };
}
