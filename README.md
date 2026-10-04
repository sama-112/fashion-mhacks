# MHacks fashion stylist backend

The backend has a Gemini Stylist, a reviewable closet-video wardrobe, style pathways with feedback, and the partner's grounded Shopper. **The live Relay hello test passed on October 3, 2026:** a real message to `@fashion_mhacks` returned **Your stylist is connected.** in Relay. Both Supabase migrations are applied; profile storage, private video storage, and atomic replay/identity checks passed against the real project. The local Relay signing secret and Gemini key are configured privately. A real closet-video and pathway walkthrough is still pending. The currently running server uses connection mode.

## Confirmed contract and decisions

The user supplied [Relay's official docs](https://docs.relayapp.im/). The initial project had an empty `src/` folder and no starter. This implementation follows [Your own backend](https://docs.relayapp.im/integrations/your-own-backend): a Node.js receiver for signed webhooks, with the official CLI forwarding real messages to localhost during development. No web framework is needed for these two routes.

| Requirement | Confirmed behavior |
| --- | --- |
| Authentication | Server-side Agent Token; bearer authentication via the official `@relaymessenger/sdk`. Console sign-in is separate. |
| API origin | `https://api.relayapp.im`, with `/v1` supplied by SDK methods. Use the origin that issued the token. |
| Input | Signed event envelope, `api_version: v1`, `webhook_version: 2026-08-30`. Text comes from `message.received.data.parts`. |
| Identity | `data.sender_handle.id` is the user/contact ID, `data.chat.id` is the conversation ID, and `data.id` is the inbound message ID. Handles are display/address strings. |
| Output | `POST /v1/chats/{chatId}/messages`, with `message.parts: [{type: text, value: ...}]`, `reply_to.message_id`, and a stable `message.idempotency_key`. |
| Local testing | Official CLI `listen --forward-to http://localhost:3000/webhooks/relay` posts signed events to this route. |
| Production | A continuously running Node process with a public HTTPS receiver, outbound Relay/Supabase access, and a saved webhook subscription. Redirects and private target URLs are unsupported. |

Sources: [authentication](https://docs.relayapp.im/live/authentication), [event payload](https://docs.relayapp.im/events/message-received), [signatures](https://docs.relayapp.im/webhooks/verify-signatures), [subscriptions](https://docs.relayapp.im/webhooks/subscriptions), [delivery](https://docs.relayapp.im/webhooks/delivery).

The flow is: Relay message → signed webhook → verify and validate → commit to Supabase → HTTP 204 → inbox worker → Stylist → optional Shopper search → persist the exact reply → send through Relay. `hello` returns the fixed connection acknowledgement without an AI call. Other text uses Gemini with a validated JSON plan for outfit suggestions, clarifying questions, and optional product criteria. The configured text model defaults to Gemini 3.6 Flash, with Gemini 3.5 Flash as fallback. Each model request has a 20-second timeout; malformed plans also try the fallback. See [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output).

[Relay requires durable event acceptance](https://docs.relayapp.im/webhooks) before acknowledgement. That is why this milestone has one small Supabase inbox table. Its unique event ID absorbs duplicate deliveries. The worker saves the exact answer before sending it, uses an event-derived idempotency key, and resumes pending work after a restart. Each event gets at most five worker attempts, with exponential backoff and Relay's `Retry-After`; each SDK call has a ten-second timeout and at most two SDK retries. Permanent client errors stop automatic attempts. See [idempotency](https://docs.relayapp.im/live/idempotency) and [SDK retries](https://docs.relayapp.im/live/retries).

The backend answers text and closet videos in **human direct messages**. Group chats, messages from agents, outbound events, and other media-only input are stored and ignored. Full payloads remain in the inbox. The Stylist receives the last six completed exchanges from the same user and chat. Confirmed wardrobe items, wardrobe drafts, pathways, liked directions, and explicit pathway-feedback reasons are saved separately in a private profile scoped to that user and chat. Price preferences by clothing type, verified inventory, and checkout remain pending.

## Closet video and style pathways

In stylist mode, send one MP4, MOV or WebM closet video, up to 50 MiB and two minutes. The backend verifies the attachment belongs to the sender's message, refreshes its download link through Relay, and asks Gemini to identify visible clothes. Video processing is bounded; temporary Google Files uploads are deleted after analysis. Drafts and raw videos are stored privately in Supabase. A canceled draft does not become owned clothes; raw video retention/cleanup is not automated yet.

The reply lists a numbered draft. Correct it with `change 2: navy shirt`, `remove 2`, or `add black jeans`. Reply `save wardrobe` to confirm or `cancel` to discard the draft. Uncertain garments are marked for review. Clothes become part of the saved wardrobe only after explicit confirmation. New scans add reviewed clothes to the existing wardrobe; identical descriptions replace the previous entry. Each scan supports 40 items and the saved wardrobe supports 200. `show wardrobe` lists saved clothes; `edit wardrobe` reviews a wardrobe of up to 40 items.

Ask `show style pathways` for 2–3 distinct directions, including palettes, suggested staples, and references to actual saved clothes. Say `I like option 1` to retain a direction, or `I don't like option 2` to be asked why. A reason such as `too formal` produces alternatives and saves the user's feedback as tentative evidence. Liked directions are retained and supplied to ordinary outfit advice. Unrelated outfit and shopping questions return to the existing Stylist/Shopper flow.

Wardrobe/pathway changes and the exact response are committed in the same database transaction before sending to Relay. A repeated event returns the previously saved response without applying edits or feedback twice. This is implemented and tested locally, and the transaction was separately verified against Supabase. Live Gemini and a real closet-video walkthrough are still pending.

The Shopper contract belongs to the partner and is defined in `src/shopper/types.ts`. The Stylist passes category, keywords, sizes, colors, occasion, and USD budget criteria through that contract. Production Stylist mode uses the partner's Gemini Google Search grounding path for cited product-page discovery; plain styling advice makes no Shopper call. Search-reported prices and all availability remain explicitly unverified, failures are handled without exposing provider details, and the backend cannot place orders. The synthetic catalog remains available for deterministic demos and tests.

## Local checks without credentials

Use Node.js 24+ from the project directory:

```sh
npm ci
npm run check
npm run smoke
npm test
npm run demo -- hello
```

To run an explicit live product-discovery query with the local Gemini key:

```sh
npm run shopper:search -- '{"market":"US","category":"tops","keywords":["linen shirt"],"preferredBrands":[],"referenceBrands":[],"maxResults":3}'
```

This performs a Google-grounded search and returns cited product pages. Price snippets are source-reported, not independently verified, and availability remains unverified until checked with a retailer.

`demo` uses a fixed sample Gemini plan and the mock Shopper catalog. `hello` bypasses that plan; try `npm run demo -- "Find a linen shirt under 50 USD"` to see the sample handoff. `smoke` verifies the fixed hello acknowledgement and empty-input rejection. Tests use synthetic signed messages, in-memory storage, and intercepted SDK HTTP transports. They never contact Gemini, Relay, or Supabase. These checks cannot establish live integration success.

All 52 tests pass. Coverage includes signed HTTP acceptance, retries and deduplication, model fallback, exact Shopper criteria, grounded citation validation, mock labels, attachment ownership and download limits, video cleanup, wardrobe corrections and explicit confirmation, pathway revisions, persisted state, and scoped history. Missing credentials cause startup to exit with an actionable configuration error.

Both SQL migrations were applied to Supabase project `zhwsiwpwltceabmtqvqh`. The private table/bucket and `commit_stylist_turn` function were verified. `scripts/verify-stylist-storage.sql` exercises atomic commit, replay, stale-version and identity checks with synthetic rows, then rolls back its fixtures. Official CLI forwarding was verified by the successful live hello test. The Docker image has not been run. `skipLibCheck` avoids a conflict in Supabase's browser credential declarations under TypeScript 7; application code still uses strict checking.

## Account-side setup for the real hello test

1. Open [Relay Console](https://console.relayapp.im). Reuse your stylist agent if one exists, or choose **Create agent**. Set its name, an available handle, and the required subtitle (for example, `Personal fashion stylist`). Save its one-time Agent Token privately. Keep the handle/share link for the phone test. See [Console agents](https://docs.relayapp.im/console/agents). Inspect existing webhooks/runtimes before changing the delivery setup; preserve unrelated subscriptions.
2. In a new Supabase project, run both files in `supabase/migrations/` in filename order. They are already applied in this project's database. Get the project URL and server-only secret key from API settings. Tables enable RLS and revoke client access; the video bucket is private. See [Supabase keys](https://supabase.com/docs/guides/getting-started/api-keys) and [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
3. If `.env` does not exist, copy `.env.example` to it. Preserve an existing configured `.env`. Enter `RELAY_AGENT_TOKEN`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `GEMINI_API_KEY` locally. The first three are already configured in this checkout. The default Gemini text models are configured in the example; keep `RELAY_API_URL` at the production origin for a production token. `.env` is ignored by Git, has mode `0600`, and is excluded from the Docker build. Do not paste secrets into chat.
4. Run `npm run relay:connect`. It runs the official CLI, saves its local signing secret directly into the ignored `.env` with mode `0600`, and prints only safe status. Keep forwarding running. The original `npm run relay:listen` remains available for your own terminal; it prints a private secret and event content, so do not capture its output in chat. Do not register localhost as a production subscription. See [local forwarding](https://docs.relayapp.im/cli/reference/listen).
5. In a second terminal, run `CONVERSATION_MODE=connection npm start` for the fixed hello check without a Gemini key. After adding the key privately, restart with `npm start` and `CONVERSATION_MODE=stylist` in the environment (stylist is the default). Stylist mode also verifies the new profile table/private bucket. Startup verifies Relay and inbox read access before listening. `GET http://localhost:3000/health` checks process availability; it does not prove message delivery.
6. Open the agent's returned share link or handle in the Relay phone app and send `hello` in a direct chat. Confirm a `Relay event committed` log, then `Reply accepted by Relay`, and finally **Your stylist is connected.** in that same phone chat. The phone reply is the required acceptance evidence. Do not send the first message until both forwarding and the server are ready.

If the forwarder restarts with a different secret, update `.env` and restart the backend. If forwarding reports an existing delivery-path conflict, inspect the agent's Webhooks tab and the official docs before changing it.

## Hosting when you are ready

`Dockerfile` runs the same backend with Node 24 and production dependencies. Deploy it as **one always-on container instance** behind your host's HTTPS endpoint; configure the environment variables from `.env.example` in its private secret settings. Use `/health` as the host's health route. A serverless function alone will not keep this in-process inbox worker running.

Once the actual deployed URL exists, open the agent's **Webhooks** tab in Relay Console. Reuse a matching subscription if present; otherwise register `https://YOUR-ACTUAL-HOST/webhooks/relay` for `message.received`. Save its one-time signing secret as the deployed `RELAY_WEBHOOK_SECRET`. Local forwarding uses its own secret. The actual host/account/URL is still pending; no subscription has been created by this project. A deployment must pass the same phone test before it is called working.

Run one worker instance for now. Scaling to multiple replicas requires database claims/leases first. Events with `completed_at IS NULL` and `attempts >= 5` need attention. After fixing credentials or the send error, set that row's `attempts = 0` and `next_attempt_at = now()` in Supabase; preserve `event_id` and `reply_text` so recovery uses the original send key/body.

## Media and long-running work

Closet-video input is now implemented with a lower application limit of 50 MiB/two minutes. Attachment links are refreshed through Relay's authenticated SDK after checking the message's user/chat identity. Only a private download is passed to Gemini; private URLs and credentials are never logged. Image replies, outfit-image generation, and other media workflows remain pending. See [attachment limits](https://docs.relayapp.im/messages/attachment-types), [message parts](https://docs.relayapp.im/messages/parts), and [Gemini video input](https://ai.google.dev/gemini-api/docs/video-understanding).

Long work can finish after webhook acknowledgement by sending a later API message. Relay also has typing indicators and [task activity](https://docs.relayapp.im/chats/activity), with renewable leases. The webhook itself has a ten-second delivery timeout; it must not wait for a future Gemini/video/image call. No token-streaming chat integration has been implemented.

## Files that matter

- `src/integrations/relay.ts`: signature/envelope validation, identity mapping, and SDK sends.
- `src/server.ts`: `POST /webhooks/relay` and `GET /health`; preserves the raw request body, limits it to 256 KiB, and acknowledges only after the inbox write.
- `src/services/conversation.ts`: fixed hello acknowledgement, history loading, and Stylist orchestration.
- `src/services/stylist-conversation.ts`: video draft/review/save, saved wardrobe, pathway routing, and atomic reply/state persistence.
- `src/wardrobe/`: bounded Gemini video analysis and explicit wardrobe-review commands.
- `src/pathways/`: structured direction generation, selection, rejection questions, and feedback-based alternatives.
- `src/db/stylist-store.ts` and the second migration: private profiles/videos and replay-safe turn commits.
- `src/agents/stylist/`: Gemini structured planning, runtime validation, outfit formatting, and presentation of Shopper results.
- `src/shopper/types.ts` and `src/shopper/index.ts`: the partner's shared contracts and entry points; `gemini-research.ts` performs grounded discovery and `mock-catalog.ts` provides labeled synthetic products.
- `src/services/relay-worker.ts`: processes stored messages with bounded retries.
- `src/db/inbox.ts` and `supabase/migrations/202610030001_relay_event_inbox.sql`: durable acceptance, deduplication, and pending replies.
- `src/main.ts`, `src/config.ts`, `.env.example`: startup, shutdown, environment configuration, and access checks.
- `scripts/relay-listen.ts` and `scripts/local-env.ts`: official CLI forwarding with optional private signing-secret setup.
- `scripts/relay.test.ts`, `scripts/shopper.test.ts`, `scripts/stylist.test.ts`, `scripts/smoke.ts`, `scripts/demo.ts`: synthetic integration tests and direct service checks.
- `Dockerfile`, `.dockerignore`: container deployment preparation.

This folder is its own Git repository, with origin [sama-112/fashion-mhacks](https://github.com/sama-112/fashion-mhacks). The UI stays entirely in Relay. The partner owns `src/shopper/`. Item-level feedback and budgets by clothing type, weekly suggestions, outfit-image generation, approved checkout, and confirmed-purchase recording remain to be built. Weekly suggestions are a core product requirement, not an optional extra. The Stylist/wardrobe/pathway implementation is developed on `codex/stylist-agent` on top of the latest Shopper commit.
