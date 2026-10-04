import Relay from "@relaymessenger/sdk";
import { required, relayOrigin, serverPort } from "./config.ts";
import { createInbox } from "./db/inbox.ts";
import { RelayAdapter, safeRelayError } from "./integrations/relay.ts";
import { createRelayServer } from "./server.ts";
import { runWorker } from "./services/relay-worker.ts";

async function main() {
  const port = serverPort();
  const adapter = new RelayAdapter(new Relay({
    apiKey: required("RELAY_AGENT_TOKEN"),
    baseURL: relayOrigin(),
    webhookSecret: required("RELAY_WEBHOOK_SECRET"),
    timeout: 10000,
    maxRetries: 2,
  }));
  const inbox = createInbox(required("SUPABASE_URL"), required("SUPABASE_SECRET_KEY"));
  try {
    await adapter.checkAccess();
  } catch (error) {
    throw new Error(safeRelayError(error));
  }
  await inbox.checkAccess();
  const stop = new AbortController();
  const server = createRelayServer(adapter, inbox);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  console.log(`Relay receiver listening on port ${port}; POST /webhooks/relay.`);
  console.log("Credentials and inbox access verified. Waiting for a real Relay message.");
  const shutdown = () => {
    stop.abort();
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await runWorker(inbox, adapter, stop.signal);
}

main().catch(error => {
  // Only our known configuration errors are printed; never dump SDK requests or responses.
  const message = error instanceof Error &&
    /^(Set |PORT |RELAY_API_URL |Supabase inbox |Relay request failed)/.test(error.message)
    ? error.message : "Startup failed; check server configuration and port availability.";
  console.error(message);
  process.exitCode = 1;
});
