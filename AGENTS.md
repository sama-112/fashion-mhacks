# Project context

- Build a personal fashion stylist for the Relay platform demonstrated at MHacks. Relay is the entire user interface; do not build a separate frontend.
- The live Relay hello milestone passed on October 3, 2026. Preserve `hello` → `Your stylist is connected.`. Current authorized scope adds closet-video extraction/review/confirmation and style pathways that learn from explicit feedback. The local Gemini key is configured; a real closet-video walkthrough is still pending.
- The partner owns `src/shopper/` and its tests. Reuse its `ShopperCriteria`, `StylistShoppingRequest`, `ProductCatalog`, and `ProductResearcher` contracts from `src/shopper/types.ts`; do not define competing external handoff types. Stylist planning and result presentation live in `src/agents/stylist/`. Production uses grounded results, while deterministic demos/tests may use mock results; preserve every uncertainty label and disclaimer.
- The user confirmed Relay's official docs at https://docs.relayapp.im/. Use its custom-backend path: signed Standard Webhooks, official `@relaymessenger/sdk`, production origin `https://api.relayapp.im` without `/v1`, and envelope version `2026-08-30`. Do not substitute another Relay product or connect a coding-agent runtime in place of this backend.
- Use TypeScript and Node.js. Keep platform details in `src/integrations/relay.ts`; keep conversation behavior independently testable in `src/services/conversation.ts`.
- Verify exact raw bytes and signature timestamp before accepting an event. Commit under unique `event_id` in Supabase before HTTP 204. A separate worker sends replies with a stable idempotency key and persisted answer. Use one worker instance for this milestone; multiple replicas require database claims/leases first.
- Reply only to inbound human direct text or closet-video messages. Preserve full event payloads and user/chat/message IDs. Ignore agent, outbound, group and other media-only input. Download a video only after checking its membership in the authenticated sender's message, then refreshing its attachment URL.
- Architecture is one backend with Stylist and Shopper, ordinary tools, and shared Supabase Postgres/Storage. Use Gemini through Google's official SDK. Text uses `GEMINI_TEXT_MODEL`/`GEMINI_FALLBACK_MODEL`; video uses separate `GEMINI_VISION_MODEL`. Outfit-image generation remains pending.
- Runtime-validate plans before using tools. Use scoped, earlier, completed inbox history. A video scan is a draft, not owned clothes: only explicit `save wardrobe` confirmation updates the wardrobe. Keep raw videos private. Commit profile changes and the exact reply together through `commit_stylist_turn`; never apply edits twice on retries.
- Pathway likes/rejection reasons persist as tentative preferences. Ask why before interpreting a bare rejection. Item-feedback budgets by clothing type and weekly scheduled suggestions remain pending and are core product requirements.
- Never fabricate products, stock, prices, checkout success, or integration verification. Record confirmed facts and blockers in README.md.
- Keep secrets in local environment files or provider dashboards, never chat or commits.
- Preserve existing work. This folder is its own Git repository, with origin `https://github.com/sama-112/fashion-mhacks.git`. Keep Git operations scoped to this project.

# Working commands

- Node.js 24+; `npm ci` installs the locked SDKs and development tools.
- `npm start` loads .env, verifies Relay/Supabase access, and runs the receiver/worker in stylist mode. `CONVERSATION_MODE=connection npm start` runs the fixed hello test without Gemini.
- `npm run relay:connect` runs official signed forwarding and writes the secret privately to `.env`, printing only safe status. Use this for agent-run setup. The original `npm run relay:listen` prints a private signing secret/event content, so run that version only in the user's terminal. First use may download the official CLI.
- `npm run check` checks TypeScript without emitting files.
- `npm run demo -- hello` demonstrates the connection acknowledgement. Another input uses a fixed sample Gemini plan and mock catalog, without API calls.
- `npm run smoke` verifies hello and empty-input handling. It does not verify Gemini or Relay.
- `npm test` runs all synthetic tests, including Relay durability, model validation, the typed Stylist-to-Shopper handoff, grounded Shopper citations, wardrobe review, pathways, and scoped memory; it needs a temporary localhost port. A passing suite does not prove live Gemini, Relay, or Supabase behavior.
- `npm run shopper:search -- '<JSON request>'` uses Gemini Google Search grounding from the local `.env` key to discover cited product pages. It does not verify stock or place orders.
