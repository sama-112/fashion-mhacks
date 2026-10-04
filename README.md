# MHacks fashion stylist backend

The backend has a Gemini Stylist, a reviewable closet-video wardrobe, style pathways with feedback, and the partner's grounded Shopper. It also supports weekly product picks, item-rejection memory, spending limits by clothing type, and Gemini outfit-concept images sent as Relay attachments. **The live Relay hello test passed on October 3, 2026.** All three Supabase migrations are applied; profile/video/image storage, atomic replay, unique weekly scheduling, and opt-out cancellation were verified against the real project. Credentials are configured privately and the server runs in Stylist mode. Style pathways have replied live in Relay; a real closet-video walkthrough remains pending.

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

The backend answers text, closet videos, voice notes, personal reference photos, and clothing-purchase photos in **human direct messages**. Group chats, messages from agents, outbound events, and other media-only input are stored and ignored. Full payloads remain in the inbox. The Stylist receives the last six completed exchanges from the same user and chat. Confirmed wardrobe items, drafts, pathways, feedback, budgets, personal photo references, pending photo questions, and weekly settings persist in a private profile scoped to that user and chat. The service recommends clothes and retailer links and records user-reported purchases; buying clothes and checkout remain outside the project's scope.

## Closet video and style pathways

In stylist mode, send one MP4, MOV or WebM closet video, up to 50 MiB and two minutes. The backend verifies the attachment belongs to the sender's message, refreshes its download link through Relay, and asks Gemini to identify visible clothes. Video processing is bounded; temporary Google Files uploads are deleted after analysis. Drafts and raw videos are stored privately in Supabase. A canceled draft does not become owned clothes; raw video retention/cleanup is not automated yet.

The reply lists a numbered draft. Correct it with `change 2: navy shirt`, `remove 2`, or `add black jeans`. Reply `save wardrobe` to confirm or `cancel` to discard the draft. Uncertain garments are marked for review. Clothes become part of the saved wardrobe only after explicit confirmation. New scans add reviewed clothes to the existing wardrobe; identical descriptions replace the previous entry. Each scan supports 40 items and the saved wardrobe supports 200. `show wardrobe` lists saved clothes; `edit wardrobe` reviews a wardrobe of up to 40 items.

Ask `show style pathways` for 2–3 distinct directions, including palettes, suggested staples, and references to actual saved clothes. Say `I like option 1` to retain a direction, or `I don't like option 2` to be asked why. A reason such as `too formal` produces alternatives and saves the user's feedback as tentative evidence. Liked directions are retained and supplied to ordinary outfit advice. Unrelated outfit and shopping questions return to the existing Stylist/Shopper flow.

Wardrobe/pathway changes and the exact response are committed in the same database transaction before sending to Relay. A repeated event returns the previously saved response without applying edits or feedback twice. This is tested locally and against Supabase. A real closet-video walkthrough is still pending.

## Recording clothes you buy

Tell the agent `I bought a navy cotton shirt and black jeans`, or `I bought item 2` to refer to its latest numbered product suggestions. The agent extracts a clothing draft; it does not treat a wish or a request to buy something as ownership. Check the numbered list, correct it with the existing wardrobe commands, then say `save wardrobe`. That appends the reviewed clothes to your wardrobe for future styling and weekly picks. `cancel` discards the draft. An existing wardrobe draft must be saved or canceled before recording another purchase. Reporting a purchase does not change spending preferences or place an order.

You can say the same thing in a voice note up to two minutes and 10 MiB. The backend authenticates the audio attachment, refreshes its download URL, and asks Gemini to transcribe speech, then routes the transcript through the same text flow. Spoken `save wardrobe` and correction commands work too. Supported common formats include M4A/MP4 audio, MP3, WAV, AIFF, AAC, OGG, Opus, FLAC and WebM; other formats receive a safe retry/type-it message. Audio bytes are used transiently and are not copied to Supabase Storage by this feature. Transcription errors can be corrected in the draft. See [Gemini audio understanding](https://ai.google.dev/gemini-api/docs/audio).

Send a clothing photo with the caption `I bought this`. Gemini extracts visible clothes or clearly named clothing on a receipt into the same reviewable draft, omitting payment/address details and uncertain attributes. Purchase photos are not saved as the personal reference used for outfit previews. The feature does not retain a second copy of purchase-photo bytes. If a photo arrives without a clear purpose, the agent asks whether it is `my photo` or a `purchase`; it remembers the original attachment identity and authenticates that original message when processing your answer. No new migration is needed because drafts and pending-photo metadata use the existing private profile JSON.

The Shopper contract belongs to the partner and is defined in `src/shopper/types.ts`. The Stylist passes category, keywords, sizes, colors, occasion, and USD budget criteria through that contract. Production Stylist mode uses the partner's Gemini Google Search grounding path for cited product-page discovery; plain styling advice makes no Shopper call. Search-reported prices and all availability remain explicitly unverified, failures are handled without exposing provider details, and the backend cannot place orders. The synthetic catalog remains available for deterministic demos and tests.

## Weekly picks, feedback, budgets and outfit pictures

Say `weekly on` to receive a few clothing recommendations every seven days; enrollment is explicit and off by default. `weekly status` shows the next batch, `weekly picks now` previews a batch without moving the schedule, and `weekly off` pauses it and cancels queued batches. Picks use confirmed clothes, liked pathways, item-feedback evidence and spending limits. Rejected products and the last 50 suggested product IDs are excluded. If no new cited products match, the agent says so rather than inventing listings.

The backend checks due profiles every minute and atomically queues a unique synthetic inbox event while advancing the next due date. Its normal durable worker then generates and sends the batch without requiring an inbound message. A process restart retains queued work and its exact text/media. After downtime, one current batch catches up instead of sending a backlog. Active wardrobe drafts defer new scheduling until reviewed or canceled. Use one worker instance. Weekly delivery requires this process to stay running with outbound network access; always-on hosting remains to be configured.

Shopping results are numbered `Item 1`, `Item 2`, etc. Say `I don't like item 2` and the agent asks why. Reasons are recorded with the actual user text. A price objection prompts for a USD maximum for that item's clothing type; it does not invent a numeric cap or treat price as a style dislike. Reply `$40`, or set independent limits with `shirts under $40; jackets under $150`. `show budgets` lists them. Limits distinguish shirts, knitwear, pants, shorts, skirts, dresses, shoes, jackets and coats, with optional wider tops/bottoms/footwear/outerwear limits. Learned limits are applied before Shopper search, and reported over-budget results are filtered after it. Unpriced results explicitly require retailer price checking. Rejection reasons also inform future Gemini planning.

Send `start` for onboarding. Optionally send one clear, preferably full-body picture of yourself as a JPG, PNG or WebP up to 10 MiB, captioned `my photo`. Without a clear caption, answer the photo-purpose question with `my photo`. The backend verifies the photo belongs to your authenticated message, saves it privately for that user/chat, and remembers its reference across restarts. Sending a later personal photo replaces the active reference. No photo is required.

Ask for an outfit, then say `generate outfit image 1`. A fuller request such as `generate an outfit image of a blue shirt with neutral jeans and white sneakers` plans a new concept. With a saved photo, Gemini edits that reference to preview the same person wearing the outfit, with instructions to preserve their face, proportions, pose and background. Without a reference, it keeps the original flat-lay illustration. `use flat lay` or `skip photo` stops using the reference; previously stored files remain private until media cleanup. Captions label personal previews as approximate, with actual garment appearance and fit potentially differing. Owned and suggested pieces remain distinguished; these are not accurate measurements or guaranteed fit simulations.

Gemini uses the separate `GEMINI_IMAGE_MODEL` setting (default `gemini-3.1-flash-image`). Generated images and personal references live in separate paths in the existing private `outfit-images` bucket; no additional migration is needed. Reference bytes are sent to Gemini only for requested outfit previews. Generated images are uploaded through Relay's authenticated attachment allocation. Image bytes and attachment IDs are cached per event; caption, attachment IDs and profile commit together, so message retries reuse the same image. Provider errors produce a safe retry message. See [Gemini image editing](https://ai.google.dev/gemini-api/docs/generate-content/image-generation#image_editing).

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

All 83 tests pass. Coverage includes signed HTTP acceptance, retries and deduplication, model fallback, exact Shopper criteria, grounded citations, wardrobe review, pathways, scoped memory, item feedback, separate budgets, weekly scheduling controls, canceled delivery, cached image retries, authenticated photo/audio downloads, photo-based image requests, flat-lay fallback, and text/voice/photo purchase drafts with explicit confirmation. Missing credentials cause startup to exit with an actionable configuration error. Personal-photo previews and purchase-report workflows pass synthetic tests; real user photo/voice walkthroughs in Relay remain pending.

Real Gemini transcription and purchase extraction passed using a synthetic spoken report of a navy cotton shirt and black jeans. Real clothing-photo extraction also identified the shirt, pants and shoes in the previously generated synthetic outfit image. The provider rejected the wardrobe draft's nested array bounds, so purchase requests use a simpler provider schema while retaining strict local item-count, description-length and field validation. These API tests did not add synthetic purchases to a real user's wardrobe.

On October 4, 2026, a due weekly batch arrived proactively in the real Relay chat with three cited retailer product links and uncertainty labels. A real Gemini-generated outfit concept was uploaded, delivered and opened in Relay. Item rejection asked why; the price reply persisted evidence and prompted for a jacket limit. Separate test limits of $40 for shirts and $150 for jackets were confirmed in the live private profile, then the original shopping preferences were restored. Weekly suggestions remain enabled; these test limits are not the user's preferences. Delivery while this machine is off still requires always-on hosting.

All three SQL migrations were applied to Supabase project `zhwsiwpwltceabmtqvqh`. The private tables/buckets and commit functions were verified. `scripts/verify-stylist-storage.sql` and `scripts/verify-weekly-storage.sql` exercise transactions and scheduling with synthetic rows, then roll back fixtures. Official CLI forwarding was verified by the live hello and pathway replies. The Docker image has not been run. `skipLibCheck` avoids a conflict in Supabase's browser credential declarations under TypeScript 7; application code still uses strict checking.

## Account-side setup for the real hello test

1. Open [Relay Console](https://console.relayapp.im). Reuse your stylist agent if one exists, or choose **Create agent**. Set its name, an available handle, and the required subtitle (for example, `Personal fashion stylist`). Save its one-time Agent Token privately. Keep the handle/share link for the phone test. See [Console agents](https://docs.relayapp.im/console/agents). Inspect existing webhooks/runtimes before changing the delivery setup; preserve unrelated subscriptions.
2. In a new Supabase project, run all files in `supabase/migrations/` in filename order. They are already applied in this project's database. Get the project URL and server-only secret key from API settings. Tables enable RLS and revoke client access; media buckets are private. See [Supabase keys](https://supabase.com/docs/guides/getting-started/api-keys) and [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
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

Closet videos support 50 MiB/two minutes; photos and generated outfit images support 10 MiB; voice notes support 10 MiB/two minutes. Attachment links are refreshed through Relay's authenticated SDK after checking message identity. Private URLs and credentials are never logged. Clothing purchase photos support wardrobe drafts. Raw videos, reference photos, and generated image retention/cleanup is not automated. See [attachment limits](https://docs.relayapp.im/messages/attachment-types), [message parts](https://docs.relayapp.im/messages/parts), and [Gemini video input](https://ai.google.dev/gemini-api/docs/video-understanding).

Long work can finish after webhook acknowledgement by sending a later API message. Relay also has typing indicators and [task activity](https://docs.relayapp.im/chats/activity), with renewable leases. The webhook itself has a ten-second delivery timeout; it must not wait for a future Gemini/video/image call. No token-streaming chat integration has been implemented.

## Files that matter

- `src/integrations/relay.ts`: signature/envelope validation, identity mapping, and SDK sends.
- `src/server.ts`: `POST /webhooks/relay` and `GET /health`; preserves the raw request body, limits it to 256 KiB, and acknowledges only after the inbox write.
- `src/services/conversation.ts`: fixed hello acknowledgement, history loading, and Stylist orchestration.
- `src/services/stylist-conversation.ts`: video draft/review/save, saved wardrobe, pathway routing, and atomic reply/state persistence.
- `src/wardrobe/`: bounded Gemini video analysis and explicit wardrobe-review commands.
- `src/pathways/`: structured direction generation, selection, rejection questions, and feedback-based alternatives.
- `src/preferences/`: item rejection evidence, separate clothing-type budgets, and filtering of returned products.
- `src/weekly/` and the third migration: opt-in scheduling, unique proactive inbox events, and opt-out cancellation.
- `src/images/`: Gemini outfit-concept generation with private bytes and cached Relay attachments.
- `src/purchases/`: Gemini extraction of reported purchases from text/photos and voice-note transcription.
- `src/db/stylist-store.ts` and the second migration: private profiles/videos and replay-safe turn commits.
- `src/agents/stylist/`: Gemini structured planning, runtime validation, outfit formatting, and presentation of Shopper results.
- `src/shopper/types.ts` and `src/shopper/index.ts`: the partner's shared contracts and entry points; `gemini-research.ts` performs grounded discovery and `mock-catalog.ts` provides labeled synthetic products.
- `src/services/relay-worker.ts`: processes stored messages with bounded retries.
- `src/db/inbox.ts` and `supabase/migrations/202610030001_relay_event_inbox.sql`: durable acceptance, deduplication, and pending replies.
- `src/main.ts`, `src/config.ts`, `.env.example`: startup, shutdown, environment configuration, and access checks.
- `scripts/relay-listen.ts` and `scripts/local-env.ts`: official CLI forwarding with optional private signing-secret setup.
- `scripts/relay.test.ts`, `scripts/shopper.test.ts`, `scripts/stylist.test.ts`, `scripts/smoke.ts`, `scripts/demo.ts`: synthetic integration tests and direct service checks.
- `Dockerfile`, `.dockerignore`: container deployment preparation.

This folder is its own Git repository, with origin [sama-112/fashion-mhacks](https://github.com/sama-112/fashion-mhacks). The UI stays entirely in Relay. The partner owns `src/shopper/`. Purchasing and checkout have been removed from the project scope. Always-on hosting and media cleanup remain to be built. The weekly/feedback/image additions are developed on `codex/stylist-personalization`; no changes are required inside the partner's Shopper module.
