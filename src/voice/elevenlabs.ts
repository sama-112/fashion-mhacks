export function voiceAgentConfiguration(publicUrl: string, voiceId?: string) {
  const url = new URL(publicUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Set VOICE_PUBLIC_URL to the public HTTPS origin of this backend.");
  }
  return {
    name: "Fashion MHacks voice",
    conversation_config: {
      agent: {
        first_message: "Hi, it's your stylist. You can ask for clothes, tell me what you own, or turn on your camera and say add this shirt. What would you like help with?",
        language: "en",
        dynamic_variables: { dynamic_variable_placeholders: { secret__fashion_call_token: "not-a-valid-call-token" } },
        prompt: {
          llm: "custom-llm",
          prompt: "You are the voice of the Fashion MHacks stylist. The custom backend supplies wardrobe advice, saved preferences and cited Shopper results. Never invent product facts or claim to purchase clothes.",
          custom_llm: { url: `${url.origin}/v1/chat/completions`, model_id: "fashion-stylist", api_type: "chat_completions",
            request_headers: { "X-Fashion-Call-Token": { variable_name: "secret__fashion_call_token" } } },
          backup_llm_config: { preference: "disabled" },
          built_in_tools: { end_call: { type: "system", name: "end_call", params: { system_tool_type: "end_call" } } },
        },
      },
      asr: { user_input_audio_format: "pcm_16000" },
      tts: { agent_output_audio_format: "pcm_16000", ...(voiceId ? { voice_id: voiceId } : {}) },
      conversation: { max_duration_seconds: 600, client_events: ["audio", "interruption", "user_transcript", "agent_response"] },
      turn: { speculative_turn: false, silence_end_call_timeout: 120 },
    },
    platform_settings: { auth: { enable_auth: true }, privacy: { record_voice: false, retention_days: 7 } },
  };
}

export async function elevenLabsRequest(path: string, apiKey: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const response = await fetcher(`https://api.elevenlabs.io${path}`, {
    ...init, headers: { "xi-api-key": apiKey, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`ElevenLabs configuration request failed (HTTP ${response.status}).`);
  const result = await response.json();
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("ElevenLabs configuration response was invalid.");
  return result as Record<string, unknown>;
}
