export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in .env or the server environment.`);
  return value;
}

export function relayOrigin(): string {
  const value = process.env.RELAY_API_URL || "https://api.relayapp.im";
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/") {
    throw new Error("RELAY_API_URL must be an HTTPS origin without /v1.");
  }
  return url.origin;
}

export function serverPort(): number {
  const port = Number(process.env.PORT || "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

export function geminiModels(): { text: string; fallback: string } {
  return {
    text: process.env.GEMINI_TEXT_MODEL?.trim() || "gemini-3.6-flash",
    fallback: process.env.GEMINI_FALLBACK_MODEL?.trim() || "gemini-3.5-flash",
  };
}

export function conversationMode(): "connection" | "stylist" {
  const mode = process.env.CONVERSATION_MODE?.trim() || "stylist";
  if (mode !== "connection" && mode !== "stylist") throw new Error("CONVERSATION_MODE must be connection or stylist.");
  return mode;
}

export function geminiVisionModel(): string {
  return process.env.GEMINI_VISION_MODEL?.trim() || geminiModels().text;
}

export function geminiImageModel(): string {
  return process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-3.1-flash-image";
}
