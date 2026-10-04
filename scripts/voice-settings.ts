import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type VoiceSetting = "ELEVENLABS_AGENT_ID" | "ELEVENLABS_BACKEND_SECRET" | "VOICE_PUBLIC_URL" | "VOICE_CALLS_ENABLED";
export function saveVoiceSettings(settings: Partial<Record<VoiceSetting, string>>, path = ".env") {
  let contents = readFileSync(path, "utf8");
  for (const [name, value] of Object.entries(settings)) {
    if (!["ELEVENLABS_AGENT_ID", "ELEVENLABS_BACKEND_SECRET", "VOICE_PUBLIC_URL", "VOICE_CALLS_ENABLED"].includes(name)
      || !/^[A-Za-z0-9_:/.-]+$/.test(value)) throw new Error("Invalid voice setting.");
    const line = `${name}=${value}`;
    const pattern = new RegExp(`^${name}=.*$`, "m");
    contents = pattern.test(contents) ? contents.replace(pattern, line) : `${contents.trimEnd()}\n${line}\n`;
  }
  const temporary = `${path}.voice-${process.pid}`;
  writeFileSync(temporary, contents, { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, path);
}
