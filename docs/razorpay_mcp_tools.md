# Razorpay MCP server — tool inventory

Captured 2026-08-24 by running `scripts/inspect_mcp_tools.py` against the
`razorpay/mcp` Docker image (stdio transport) with sandbox test keys.
41 tools total. Re-run the script if the image is updated.

## Read-only (25) — safe to call without idempotency/confirmation gates

- fetch_all_instant_settlements
- fetch_all_orders
- fetch_all_payment_links
- fetch_all_payments
- fetch_all_payouts
- fetch_all_qr_codes
- fetch_all_refunds
- fetch_all_settlements
- fetch_instant_settlement_with_id(settlement_id)
- fetch_multiple_refunds_for_payment(payment_id)
- fetch_order(order_id)
- fetch_order_payments(order_id)
- fetch_payment(payment_id) — **primary tool for the investigation flow**
- fetch_payment_card_details(payment_id)
- fetch_payment_link(payment_link_id)
- fetch_payments_for_qr_code(qr_code_id)
- fetch_payout_with_id(payout_id)
- fetch_qr_code(qr_code_id)
- fetch_qr_codes_by_customer_id(customer_id)
- fetch_qr_codes_by_payment_id(payment_id)
- fetch_refund(refund_id)
- fetch_settlement_recon_details(year, month)
- fetch_settlement_with_id(settlement_id)
- fetch_specific_refund_for_payment(payment_id, refund_id)
- fetch_tokens(contact)

## Write / state-changing (16) — MUST go through idempotency check +
## human confirmation before executing

- capture_payment(payment_id, amount, currency)
- close_qr_code(qr_code_id)
- create_instant_settlement(amount)
- create_order(amount, currency, ...)
- create_payment_link(amount, currency)
- create_qr_code(type, usage)
- create_refund(payment_id, amount) — **the likely "fix" action for the
  payment-failure-investigation flow**
- initiate_payment(amount, order_id)
- payment_link_notify(payment_link_id, medium)
- payment_link_upi_create(amount, currency)
- resend_otp(payment_id)
- submit_otp(otp_string, payment_id)
- update_order(order_id, notes)
- update_payment(payment_id, notes)
- update_payment_link(payment_link_id)
- update_refund(refund_id, notes)

## What this settles

This is a **full read+write** MCP server, not read-only. It can move money
in the sandbox (refunds, captures, instant settlements). This confirms the
idempotency (Redis) and human-confirmation gate in `docs/architecture.md`
are load-bearing from the first agent we build, not optional hardening
added later.

## MVP scope (payment-failure-investigation)

Read side: `fetch_payment`, `fetch_all_payments`, `fetch_order`,
`fetch_order_payments`, `fetch_payment_card_details`.
Write side (behind confirmation): `create_refund`, `capture_payment`.
Everything else is out of scope for this flow.
