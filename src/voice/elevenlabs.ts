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
          // ElevenLabs treats this as an OpenAI-compatible base URL and appends /chat/completions.
          custom_llm: { url: `${url.origin}/v1`, model_id: "fashion-stylist", api_type: "chat_completions",
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

export function websocketVoiceAgentConfiguration(voiceId?: string) {
  const existing = voiceAgentConfiguration("https://unused.example", voiceId);
  return { ...existing, conversation_config: { ...existing.conversation_config,
    agent: { ...existing.conversation_config.agent,
      first_message: "Your stylist is connected. What would you like help with?",
      dynamic_variables: { dynamic_variable_placeholders: {} },
      prompt: {
        llm: "gemini-2.5-flash", custom_llm: null, tool_ids: [],
        prompt: "You are the spoken interface to the Fashion MHacks stylist. For EVERY user utterance except a request to end the call, call fashion_stylist once before answering, including greetings, wardrobe changes, clothes visible on camera, shopping, images, preferences and follow-ups. The tool processes the actual transcript and supplies the full answer from the user's private Gemini Stylist and Shopper. Read its answer faithfully, without inventing, changing or adding fashion advice, products, budgets, ownership, confirmations or successful actions. For hello, say exactly: Your stylist is connected. If the tool fails, say you could not get a reply and ask the user to try again. Never buy clothes. Use end_call only when the user explicitly asks to hang up or says goodbye.",
        tools: [{ type: "client", name: "fashion_stylist", description: "Required for every user request. Processes the actual most recent spoken transcript using the saved Gemini Stylist, wardrobe and Shopper. No parameters: the verified transcript and caller identity are supplied by the backend.",
          parameters: { type: "object", properties: {}, required: [] }, expects_response: true,
          response_timeout_secs: 120, pre_tool_speech: "force", interruption_mode: "allow" }],
        built_in_tools: existing.conversation_config.agent.prompt.built_in_tools,
        backup_llm_config: { preference: "disabled" },
      },
    },
    conversation: { ...existing.conversation_config.conversation,
      client_events: ["audio", "interruption", "user_transcript", "agent_response", "client_tool_call", "agent_response_complete"] },
  } };
}
