import { randomBytes } from "node:crypto";
import { required } from "../src/config.ts";
import { elevenLabsRequest, voiceAgentConfiguration, websocketVoiceAgentConfiguration } from "../src/voice/elevenlabs.ts";
import { saveVoiceSettings } from "./voice-settings.ts";

try {
  const apiKey = required("ELEVENLABS_API_KEY");
  const argument = process.argv[2];
  const websocket = argument === "--websocket" || (!argument && process.env.VOICE_TRANSPORT === "websocket");
  const publicUrl = websocket ? null : argument || required("VOICE_PUBLIC_URL");
  const configuration = websocket ? websocketVoiceAgentConfiguration(process.env.ELEVENLABS_VOICE_ID?.trim())
    : voiceAgentConfiguration(publicUrl!, process.env.ELEVENLABS_VOICE_ID?.trim());
  const secret = process.env.ELEVENLABS_BACKEND_SECRET?.trim() || randomBytes(32).toString("hex");
  if (secret.length < 32) throw new Error("Set ELEVENLABS_BACKEND_SECRET to at least 32 characters.");
  // Save the local signing secret before creating remote resources, so retries can reuse it.
  saveVoiceSettings({ ELEVENLABS_BACKEND_SECRET: secret, ...(publicUrl ? { VOICE_PUBLIC_URL: new URL(publicUrl).origin } : {}) });
  let agentId = process.env.ELEVENLABS_AGENT_ID?.trim();
  if (agentId && !/^[A-Za-z0-9_-]{8,100}$/.test(agentId)) throw new Error("Set a valid ELEVENLABS_AGENT_ID.");
  if (agentId) {
    await elevenLabsRequest(`/v1/convai/agents/${agentId}`, apiKey, { method: "PATCH", body: JSON.stringify(configuration) });
    console.log("Existing ElevenLabs voice agent configured.");
  } else {
    // Recover an earlier setup whose response/local write was interrupted; don't create duplicates.
    const existing = await elevenLabsRequest("/v1/convai/agents?page_size=100", apiKey);
    const agents = Array.isArray(existing.agents) ? existing.agents as Array<{ agent_id?: string; name?: string }> : [];
    const matches = agents.filter(agent => agent.name === configuration.name);
    if (matches.length > 1) throw new Error("Set ELEVENLABS_AGENT_ID to select the existing Fashion MHacks voice agent.");
    if (matches[0]?.agent_id) {
      agentId = matches[0].agent_id;
      await elevenLabsRequest(`/v1/convai/agents/${agentId}`, apiKey, { method: "PATCH", body: JSON.stringify(configuration) });
    } else {
      const created = await elevenLabsRequest("/v1/convai/agents/create", apiKey, { method: "POST", body: JSON.stringify(configuration) });
      agentId = typeof created.agent_id === "string" ? created.agent_id : undefined;
    }
    if (!agentId || !/^[A-Za-z0-9_-]{8,100}$/.test(agentId)) throw new Error("ElevenLabs configuration response was invalid.");
    saveVoiceSettings({ ELEVENLABS_AGENT_ID: agentId });
    console.log("ElevenLabs voice agent ready; its ID was saved privately in .env.");
  }
  saveVoiceSettings({ VOICE_CALLS_ENABLED: "true", VOICE_TRANSPORT: websocket ? "websocket" : "http" });
  console.log(websocket ? "WebSocket voice tools enabled locally. Restart npm start and keep Relay forwarding running; no public voice tunnel is needed."
    : "Relay HTTP voice calls enabled locally. Restart npm start, keep Relay forwarding and the public tunnel running.");
} catch (error) {
  const message = error instanceof Error && /^(Set |ElevenLabs configuration)/.test(error.message)
    ? error.message : "Voice setup failed; check ElevenLabs permissions and the public backend URL.";
  console.error(message); process.exitCode = 1;
}
