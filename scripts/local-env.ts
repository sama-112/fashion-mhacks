import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export function saveLocalSetting(name: "RELAY_WEBHOOK_SECRET" | "CONVERSATION_MODE", value: string, path = ".env"): void {
  if (!/^[A-Za-z0-9_+/=-]+$/.test(value)) throw new Error("Invalid local setting.");
  const contents = readFileSync(path, "utf8");
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  const updated = pattern.test(contents) ? contents.replace(pattern, line) : `${contents.trimEnd()}\n${line}\n`;
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, updated, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/** Consume whole lines; never echo arbitrary CLI output (it can contain secrets or messages). */
export function createForwardingOutput(onSecret: (secret: string) => void, onStatus: (text: string) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 65536) buffer = "";
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\x1b\[[0-9;]*m/g, "");
      buffer = buffer.slice(newline + 1);
      const secret = /^Local signing secret\s+(whsec_[A-Za-z0-9+/]+=*)\s/.exec(line);
      if (secret) { onSecret(secret[1]!); onStatus("Local Relay signing secret saved privately to .env. Keep this listener running."); }
      else if (/^forwarded [a-z_.]+ [0-9a-f-]{36}$/i.test(line)) onStatus(line);
      else if (/^Forwarding events to /i.test(line)) onStatus("Starting Relay local forwarding.");
    }
  };
}
