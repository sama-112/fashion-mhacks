import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { required, serverPort, voiceConfig } from "../src/config.ts";
import { elevenLabsRequest, voiceAgentConfiguration } from "../src/voice/elevenlabs.ts";
import { saveVoiceSettings } from "./voice-settings.ts";
import { createTunnelOutput, createTunnelSync } from "./voice-tunnel-output.ts";

// This explicitly selected command uses the localhost.run service approved for this local demo.
// It does not launch from npm start or expose a backend automatically in production.
try {
  const config = voiceConfig();
  if (!config) throw new Error("Run voice:setup for an authorized public origin before voice:tunnel.");
  if (config.mode === "websocket") throw new Error("WebSocket voice does not require a tunnel.");
  required("VOICE_PUBLIC_URL");
  let stopping = false;
  let ssh: ReturnType<typeof spawn> | null = null;
  let reconnect: NodeJS.Timeout | undefined;
  const sync = createTunnelSync(async origin => {
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10000),
    });
    await response.body?.cancel();
    if (response.status !== 401) throw new Error("Callback is unavailable.");
    await elevenLabsRequest(`/v1/convai/agents/${config.agentId}`, config.apiKey, {
      method: "PATCH", body: JSON.stringify(voiceAgentConfiguration(origin, process.env.ELEVENLABS_VOICE_ID?.trim())),
    });
    saveVoiceSettings({ VOICE_PUBLIC_URL: origin });
    console.log("Voice tunnel ready; ElevenLabs callback synchronized privately.");
  }, () => console.warn("Voice callback synchronization failed; retrying. Keep the backend running."));
  const retry = setInterval(() => { if (!stopping) void sync.retry(); }, 10000);
  const start = () => {
    if (stopping) return;
    console.log("Connecting the approved voice tunnel.");
    ssh = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
      "-o", `UserKnownHostsFile=${join(tmpdir(), "fashion-voice-known-hosts")}`,
      "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-o", "ExitOnForwardFailure=yes",
      "-o", "ConnectTimeout=10", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-i", "/dev/null",
      "-R", `80:127.0.0.1:${serverPort()}`, "nokey@localhost.run"], { stdio: ["ignore", "pipe", "pipe"] });
    const output = () => createTunnelOutput(origin => { if (!stopping) void sync.request(origin); });
    ssh.stdout?.setEncoding("utf8").on("data", output());
    ssh.stderr?.setEncoding("utf8").on("data", output());
    // Suppress raw SSH/provider output (QR codes, addresses and session identifiers).
    ssh.once("error", () => console.warn("Voice tunnel could not start; check SSH and network connectivity."));
    ssh.once("close", () => {
      ssh = null;
      if (!stopping) {
        console.warn("Voice tunnel disconnected; reconnecting shortly.");
        reconnect = setTimeout(start, 5000);
      }
    });
  };
  const stop = () => {
    stopping = true; clearInterval(retry); clearTimeout(reconnect); ssh?.kill("SIGTERM");
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  start();
} catch {
  console.error("Voice tunnel needs existing voice settings. Run voice:setup first and keep npm start running.");
  process.exitCode = 1;
}
