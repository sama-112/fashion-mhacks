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
    const expected = voiceAgentConfiguration(required("VOICE_PUBLIC_URL"));
    const agent = await elevenLabsRequest(`/v1/convai/agents/${config.agentId}`, config.apiKey);
    const actual = agent.conversation_config as { agent?: { prompt?: { custom_llm?: { url?: string } } } } | undefined;
    if (actual?.agent?.prompt?.custom_llm?.url !== expected.conversation_config.agent.prompt.custom_llm.url) throw new Error("Voice callback configuration differs; rerun voice:setup for the current origin.");
    await getSignedUrl({ apiKey: config.apiKey, agentId: config.agentId });
    console.log("Private ElevenLabs agent access and callback configuration: ready.");
    const response = await fetch(expected.conversation_config.agent.prompt.custom_llm.url, { method: "POST", signal: AbortSignal.timeout(10000), headers: { "Content-Type": "application/json" }, body: "{}" });
    if (response.status !== 401) throw new Error("Voice callback is unavailable or does not reject unauthenticated requests.");
    console.log("Public callback authentication: ready. Call @fashion_mhacks in Relay to verify live speech and camera behavior.");
  }
} catch (error) {
  const text = error instanceof Error && /^(Set |ElevenLabs configuration|Relay server|Camera decoder|Voice callback)/.test(error.message) ? error.message : "Voice readiness check failed; inspect local settings and backend connectivity.";
  console.error(text); process.exitCode = 1;
}
