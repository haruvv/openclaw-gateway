---
name: revenue-agent
description: Run RevenueAgentPlatform for a target URL. Use for SEO/business evaluation, proposal generation, and optional outreach/payment-link actions.
---

# Revenue Agent

Run the RevenueAgentPlatform pipeline as one business action.

## When to use

- The user asks to evaluate a website for sales or SEO opportunities.
- The user asks to generate a proposal for a target website.
- The user explicitly approves outreach, Telegram notification, or Stripe Payment Link creation.

## Safety

- Default to no side effects.
- Do not set `sendEmail`, `sendTelegram`, or `createPaymentLink` to true unless the user clearly approves that action.
- Treat `sendEmail` and `createPaymentLink` as L3 actions.
- Treat `sendTelegram` as L2 unless it includes a customer-facing message or payment link.
- Never print `REVENUE_AGENT_INTEGRATION_TOKEN`.

## Required Environment

- `REVENUE_AGENT_BASE_URL`: Base URL for RevenueAgentPlatform, for example `http://localhost:3000`.
- `REVENUE_AGENT_INTEGRATION_TOKEN`: Shared bearer token expected by RevenueAgentPlatform.
- `CLOUDFLARE_ACCESS_CLIENT_ID`: Cloudflare Access Service Token client ID for production RevenueAgentPlatform.
- `CLOUDFLARE_ACCESS_CLIENT_SECRET`: Cloudflare Access Service Token client secret for production RevenueAgentPlatform.

## Invocation

Call RevenueAgentPlatform with the user's target URL:

```bash
set -a
[ -f "$HOME/.openclaw/.env" ] && . "$HOME/.openclaw/.env"
set +a

curl -sS "$REVENUE_AGENT_BASE_URL/api/revenue-agent/run" \
  -H "CF-Access-Client-Id: $CLOUDFLARE_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CLOUDFLARE_ACCESS_CLIENT_SECRET" \
  -H "Authorization: Bearer $REVENUE_AGENT_INTEGRATION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "<target-url>",
    "sendEmail": false,
    "sendTelegram": false,
    "createPaymentLink": false
  }'
```

Only set side-effect flags to `true` after the user has explicitly approved that action.

## Response handling

- Summarize `status`, `outputs.seoScore`, `outputs.proposalPath`, and each step status.
- If `outputs.paymentLinkUrl` exists, show it only after confirming the user intended to create a Stripe link.
- If a step failed, report the sanitized `error` from that step.
- Do not ask the user to inspect raw JSON unless debugging is needed.

## Suggested summary format

```text
RevenueAgentPlatform 実行結果:
- status: <status>
- target: <targetUrl>
- SEO score: <outputs.seoScore>
- proposal: <outputs.proposalPath>
- steps: crawl_and_score=<status>, generate_proposal=<status>, sendgrid_email=<status>, telegram_notification=<status>, stripe_payment_link=<status>
```
