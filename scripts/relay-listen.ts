import { spawn } from "node:child_process";
import { required, relayOrigin, serverPort } from "../src/config.ts";
import { createForwardingOutput, saveLocalSetting } from "./local-env.ts";

// --configure saves the CLI signing secret privately and prints only safe status.
// Default interactive mode prints the secret; use it only in the user's terminal.
try {
  const configure = process.argv.includes("--configure");
  const child = spawn("npx", [
    "--yes", "relaymessenger", "listen", "--forward-to",
    `http://localhost:${serverPort()}/webhooks/relay`,
  ], {
    stdio: configure ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, RELAY_AGENT_TOKEN: required("RELAY_AGENT_TOKEN"), RELAY_API_URL: relayOrigin() },
  });
  if (configure) {
    const output = () => createForwardingOutput(secret => saveLocalSetting("RELAY_WEBHOOK_SECRET", secret), console.log);
    child.stdout?.setEncoding("utf8").on("data", output());
    child.stderr?.setEncoding("utf8").on("data", output());
  }
  process.once("SIGINT", () => child.kill("SIGINT"));
  process.once("SIGTERM", () => child.kill("SIGTERM"));
  child.once("error", () => {
    console.error("Could not start Relay CLI; confirm Node.js and npx are installed.");
    process.exitCode = 1;
  });
  child.once("exit", code => {
    if (configure && code) console.error("Relay forwarding stopped. Check the agent's delivery settings and authentication in Relay Console.");
    process.exitCode = code ?? 1;
  });
} catch {
  console.error("Set RELAY_AGENT_TOKEN and a valid RELAY_API_URL in .env before forwarding.");
  process.exitCode = 1;
}
