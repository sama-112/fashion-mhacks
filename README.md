# MHacks fashion stylist backend

Milestone 1 code is implemented and locally tested. **Live acceptance is pending:** a real `hello` must reach this backend and `Your stylist is connected.` must appear in the same Relay chat. Relay and Supabase account access have not been configured or tested.

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

The flow is: Relay message → signed webhook → verify and validate → commit to Supabase → HTTP 204 → inbox worker → independent conversation service → send the fixed reply through Relay.

[Relay requires durable event acceptance](https://docs.relayapp.im/webhooks) before acknowledgement. That is why this milestone has one small Supabase inbox table. Its unique event ID absorbs duplicate deliveries. The worker saves the exact answer before sending it, uses an event-derived idempotency key, and resumes pending work after a restart. Each event gets at most five worker attempts, with exponential backoff and Relay's `Retry-After`; each SDK call has a ten-second timeout and at most two SDK retries. Permanent client errors stop automatic attempts. See [idempotency](https://docs.relayapp.im/live/idempotency) and [SDK retries](https://docs.relayapp.im/live/retries).

This milestone answers nonempty text in **human direct messages**. Group chats, messages from agents, outbound events, and media-only input are stored and ignored. Full payloads, including ordered media parts, remain in the inbox. No AI or fashion logic runs yet.

## Local checks without credentials

Use Node.js 24+ from the project directory:

```sh
npm ci
npm run check
npm run smoke
npm test
npm run demo -- hello
```

`demo` and `smoke` call the service directly. The tests use synthetic signed messages, in-memory storage, and an intercepted SDK HTTP transport. They never contact Relay or Supabase. These checks cannot establish live integration success.

Verified on October 3, 2026 using Node.js `v24.21.0` and npm `11.19.0`: TypeScript checking, the service smoke check, and nine adapter/worker/HTTP tests passed. Tests cover signatures and timestamps, commit before acknowledgement, storage failure returning 503, identity mapping, outgoing request format, duplicates, ignored messages, uncertain-send retries, permanent errors, rate limiting, and retry exhaustion. Missing credentials cause startup to exit with an actionable configuration error.

The SQL migration has **not** been applied to a real Supabase project; the Docker image and CLI forwarding have **not** been run. `skipLibCheck` avoids a conflict in Supabase's browser credential declarations under TypeScript 7; application code still uses strict checking.

## Account-side setup for the real hello test

1. Open [Relay Console](https://console.relayapp.im). Reuse your stylist agent if one exists, or choose **Create agent**. Set its name, an available handle, and the required subtitle (for example, `Personal fashion stylist`). Save its one-time Agent Token privately. Keep the handle/share link for the phone test. See [Console agents](https://docs.relayapp.im/console/agents). Inspect existing webhooks/runtimes before changing the delivery setup; preserve unrelated subscriptions.
2. In your Supabase project's **SQL Editor**, run `supabase/migrations/202610030001_relay_event_inbox.sql` once. Get the project URL and a server-only secret key from its API settings. The table enables RLS and revokes client access; only the backend service role gets read/insert/update access. See [Supabase keys](https://supabase.com/docs/guides/getting-started/api-keys) and [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
3. Run `cp .env.example .env`. Enter `RELAY_AGENT_TOKEN`, `SUPABASE_URL`, and `SUPABASE_SECRET_KEY` in that file locally. Keep `RELAY_API_URL` at the production origin for a production token. `.env` is ignored by Git and excluded from the Docker build. Do not paste secrets into chat.
4. In your own terminal, run `npm run relay:listen`. It loads the token from `.env` and runs the documented official CLI command. Save the signing secret printed by that command as `RELAY_WEBHOOK_SECRET` in `.env`. Keep the forwarding terminal open. This step uses the CLI's local delivery path; do not register a localhost URL as a production subscription. See [local forwarding](https://docs.relayapp.im/cli/reference/listen).
5. In a second terminal, run `npm start`. Startup reads one Relay chat to verify the token (an empty chat list is valid), checks that the inbox table is readable, then prints `Relay receiver listening...`. `GET http://localhost:3000/health` checks process availability; it does not prove message delivery.
6. Open the agent's returned share link or handle in the Relay phone app and send `hello` in a direct chat. Confirm a `Relay event committed` log, then `Reply accepted by Relay`, and finally **Your stylist is connected.** in that same phone chat. The phone reply is the required acceptance evidence. Do not send the first message until both forwarding and the server are ready.

If the forwarder restarts with a different secret, update `.env` and restart the backend. If forwarding reports an existing delivery-path conflict, inspect the agent's Webhooks tab and the official docs before changing it.

## Hosting when you are ready

`Dockerfile` runs the same backend with Node 24 and production dependencies. Deploy it as **one always-on container instance** behind your host's HTTPS endpoint; configure the environment variables from `.env.example` in its private secret settings. Use `/health` as the host's health route. A serverless function alone will not keep this in-process inbox worker running.

Once the actual deployed URL exists, open the agent's **Webhooks** tab in Relay Console. Reuse a matching subscription if present; otherwise register `https://YOUR-ACTUAL-HOST/webhooks/relay` for `message.received`. Save its one-time signing secret as the deployed `RELAY_WEBHOOK_SECRET`. Local forwarding uses its own secret. The actual host/account/URL is still pending; no subscription has been created by this project. A deployment must pass the same phone test before it is called working.

Run one worker instance for now. Scaling to multiple replicas requires database claims/leases first. Events with `completed_at IS NULL` and `attempts >= 5` need attention. After fixing credentials or the send error, set that row's `attempts = 0` and `next_attempt_at = now()` in Supabase; preserve `event_id` and `reply_text` so recovery uses the original send key/body.

## Media and long-running work — later milestones

Relay supports uploaded files, including images and videos, up to 100 MiB, and public HTTPS media imports up to 10 MiB. Image replies use media parts. Download links expire and must be refreshed when needed. See [attachment limits](https://docs.relayapp.im/messages/attachment-types) and [message parts](https://docs.relayapp.im/messages/parts). These features are documented, but not implemented or tested here.

Long work can finish after webhook acknowledgement by sending a later API message. Relay also has typing indicators and [task activity](https://docs.relayapp.im/chats/activity), with renewable leases. The webhook itself has a ten-second delivery timeout; it must not wait for a future Gemini/video/image call. No token-streaming chat integration has been implemented.

## Files that matter

- `src/integrations/relay.ts`: signature/envelope validation, identity mapping, and SDK sends.
- `src/server.ts`: `POST /webhooks/relay` and `GET /health`; preserves the raw request body, limits it to 256 KiB, and acknowledges only after the inbox write.
- `src/services/conversation.ts`: independent fixed-reply behavior; future Gemini integration belongs behind this boundary.
- `src/services/relay-worker.ts`: processes stored messages with bounded retries.
- `src/db/inbox.ts` and `supabase/migrations/202610030001_relay_event_inbox.sql`: durable acceptance, deduplication, and pending replies.
- `src/main.ts`, `src/config.ts`, `.env.example`: startup, shutdown, environment configuration, and access checks.
- `scripts/relay-listen.ts`: official CLI forwarding wrapper for the user's terminal.
- `scripts/relay.test.ts`, `scripts/smoke.ts`, `scripts/demo.ts`: synthetic integration tests and direct service checks.
- `Dockerfile`, `.dockerignore`: container deployment preparation.

This folder is its own Git repository, with origin [sama-112/fashion-mhacks](https://github.com/sama-112/fashion-mhacks). Keep Git operations scoped to this project. The UI stays entirely in Relay. Gemini, wardrobe/profile memory, Supabase media storage, shopping, image generation, checkout, and scheduled searches remain deferred.
