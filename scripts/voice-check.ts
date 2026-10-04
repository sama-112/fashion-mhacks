import Relay from "@relaymessenger/sdk";
import { getSignedUrl } from "@relaymessenger/elevenlabs";
import { required, relayOrigin, voiceConfig } from "../src/config.ts";
import { elevenLabsRequest, voiceAgentConfiguration } from "../src/voice/elevenlabs.ts";

try {
  const relay = new Relay({ apiKey: required("RELAY_AGENT_TOKEN"), baseURL: relayOrigin(), timeout: 10000, maxRetries: 0 });
  if (!(await relay.me.retrieve()).calls_enabled) throw new Error("Relay server does not have calls enabled.");
  console.log("Relay calling capability: ready.");
  await elevenLabsRequest("/v1/convai/agents?page_size=1", required("ELEVENLABS_API_KEY"));
  console.log("ElevenLabs API key: accepted.");
  const { VideoDecoder } = await import("node-webcodecs");
  if (!(await VideoDecoder.isConfigSupported({ codec: "avc1.42E01E", hardwareAcceleration: "prefer-software" })).supported) throw new Error("Camera decoder unavailable; install the documented node-webcodecs dependencies.");
  console.log("Camera decoder: ready.");
  const config = voiceConfig();
  if (!config) {
    console.log("Calls are disabled. Provide an authorized public HTTPS origin and run npm run voice:setup before the live test.");
    process.exitCode = 1;
  } else {
    const agent = await elevenLabsRequest(`/v1/convai/agents/${config.agentId}`, config.apiKey);
    const actual = agent.conversation_config as { agent?: { prompt?: { llm?: string; custom_llm?: { url?: string }; tools?: Array<{ name?: string; type?: string; expects_response?: boolean }> } } } | undefined;
    await getSignedUrl({ apiKey: config.apiKey, agentId: config.agentId });
    if (config.mode === "websocket") {
      if (actual?.agent?.prompt?.llm === "custom-llm" || !actual?.agent?.prompt?.tools?.some(tool => tool.name === "fashion_stylist" && tool.type === "client" && tool.expects_response)) {
        throw new Error("Voice callback configuration differs; rerun voice:setup -- --websocket.");
      }
      console.log("Private ElevenLabs agent and WebSocket Stylist tool: ready. No public voice tunnel is required.");
      const response = await fetch(`http://127.0.0.1:${process.env.PORT || "3000"}/health`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("Voice callback backend is unavailable.");
      console.log("Local backend: ready. Call @fashion_mhacks to verify audible replies.");
      process.exit(0);
    }
    const expected = voiceAgentConfiguration(required("VOICE_PUBLIC_URL"));
    if (actual?.agent?.prompt?.custom_llm?.url !== expected.conversation_config.agent.prompt.custom_llm.url) throw new Error("Voice callback configuration differs; rerun voice:setup for the current origin.");
    console.log("Private ElevenLabs agent access and callback configuration: ready.");
    const response = await fetch(`${expected.conversation_config.agent.prompt.custom_llm.url}/chat/completions`, { method: "POST", signal: AbortSignal.timeout(10000), headers: { "Content-Type": "application/json" }, body: "{}" });
    if (response.status !== 401) throw new Error("Voice callback is unavailable or does not reject unauthenticated requests.");
    console.log("Public callback authentication: ready. Call @fashion_mhacks in Relay to verify live speech and camera behavior.");
  }
} catch (error) {
  const text = error instanceof Error && /^(Set |ElevenLabs configuration|Relay server|Camera decoder|Voice callback)/.test(error.message) ? error.message : "Voice readiness check failed; inspect local settings and backend connectivity.";
  console.error(text); process.exitCode = 1;
}
