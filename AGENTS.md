# Project context

- Build a personal fashion stylist for the Relay platform demonstrated at MHacks. Relay is the entire user interface; do not build a separate frontend.
- Current scope is milestone 1: a real Relay text message must reach the backend and receive a Gemini-generated stylist reply in Relay. The local scaffold alone does not complete the milestone.
- The user confirmed Relay's official docs at https://docs.relayapp.im/. Use its custom-backend path: signed Standard Webhooks, official `@relaymessenger/sdk`, production origin `https://api.relayapp.im` without `/v1`, and envelope version `2026-08-30`. Do not substitute another Relay product or connect a coding-agent runtime in place of this backend.
- Use TypeScript and Node.js. Keep platform details in `src/integrations/relay.ts`; keep conversation behavior independently testable in `src/services/conversation.ts`.
- Verify exact raw bytes and signature timestamp before accepting an event. Commit under unique `event_id` in Supabase before HTTP 204. A separate worker sends replies with a stable idempotency key and persisted answer. Use one worker instance for this milestone; multiple replicas require database claims/leases first.
- Reply only to inbound human direct messages. Preserve full event payloads and user/chat/message IDs. Do not react to agent, outbound, group, or media-only messages in milestone 1.
- Future architecture is one backend with a stylist agent and shopping agent, ordinary tools, and shared Supabase Postgres/Storage. Use Gemini through Google's official SDK. Current text replies use `GEMINI_TEXT_MODEL` with `GEMINI_FALLBACK_MODEL`; image/vision handling and image generation remain future work.
- Never fabricate products, stock, prices, checkout success, or integration verification. Record confirmed facts and blockers in README.md.
- Keep secrets in local environment files or provider dashboards, never chat or commits.
- Preserve existing work. This folder is its own Git repository, with origin `https://github.com/sama-112/fashion-mhacks.git`. Keep Git operations scoped to this project.

# Working commands

- Node.js 24+; `npm ci` installs the locked SDKs and development tools.
- `npm start` loads .env, verifies Relay/Supabase read access, and runs the receiver and worker.
- `npm run relay:listen` runs the official CLI's signed local forwarding using .env. Run it in the user's terminal because it prints a private local signing secret. This command may download the CLI on first use.
- `npm run check` checks TypeScript without emitting files.
- `npm run demo -- hello` demonstrates the response path with a mock model, without Gemini or Relay calls.
- `npm run smoke` verifies the conversation service with a mock model. It does not verify Gemini or Relay.
- `npm test` tests signed HTTP fixtures, identity mapping, deduplication, send format, Gemini model fallback, and bounded retries with synthetic credentials and storage; it needs a temporary localhost port. A passing test suite does not prove live Gemini, Relay, or Supabase behavior.
