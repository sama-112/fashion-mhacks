// Only accept an origin from localhost.run's tunnel announcement, never arbitrary output URLs.
export function tunnelOrigin(line: string): string | null {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
  const match = /^([a-z0-9-]+\.(?:lhr\.life|localhost\.run)) tunneled with tls termination, (https:\/\/[^\s]+)$/.exec(clean);
  if (!match) return null;
  try {
    const url = new URL(match[2]!);
    return url.hostname === match[1] && url.origin === match[2] ? url.origin : null;
  } catch { return null; }
}

export function createTunnelOutput(receive: (origin: string) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const origin = tunnelOrigin(line);
      if (origin) receive(origin);
    }
    if (buffer.length > 8192) buffer = "";
  };
}

// Rotations arriving during a provider update are applied in order, with only the latest pending origin retained.
export function createTunnelSync(apply: (origin: string) => Promise<void>, failed: () => void) {
  let desired: string | null = null;
  let applied: string | null = null;
  let running: Promise<void> | null = null;
  const sync = (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      while (desired && desired !== applied) {
        const origin = desired;
        try { await apply(origin); applied = origin; }
        catch { failed(); break; }
      }
    })().finally(() => { running = null; });
    return running;
  };
  return { request(origin: string) { desired = origin; return sync(); }, retry: sync };
}
