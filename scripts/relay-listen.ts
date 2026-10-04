import { spawn } from "node:child_process";
import { required, relayOrigin, serverPort } from "../src/config.ts";

// Run in the user's terminal: Relay's CLI prints a local signing secret there.
// The agent token is passed through the environment, never command arguments.
try {
  const child = spawn("npx", [
    "--yes", "relaymessenger", "listen", "--forward-to",
    `http://localhost:${serverPort()}/webhooks/relay`,
  ], {
    stdio: "inherit",
    env: { ...process.env, RELAY_AGENT_TOKEN: required("RELAY_AGENT_TOKEN"), RELAY_API_URL: relayOrigin() },
  });
  process.once("SIGINT", () => child.kill("SIGINT"));
  process.once("SIGTERM", () => child.kill("SIGTERM"));
  child.once("error", () => {
    console.error("Could not start Relay CLI; confirm Node.js and npx are installed.");
    process.exitCode = 1;
  });
  child.once("exit", code => { process.exitCode = code ?? 1; });
} catch {
  console.error("Set RELAY_AGENT_TOKEN and a valid RELAY_API_URL in .env before forwarding.");
  process.exitCode = 1;
}
