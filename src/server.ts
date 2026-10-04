import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { EventInbox } from "./db/inbox.ts";
import type { RelayAdapter } from "./integrations/relay.ts";

const MAX_BODY_BYTES = 256 * 1024;
class BodyTooLarge extends Error {}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        reject(new BodyTooLarge());
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
    request.on("aborted", () => reject(new Error("Request aborted.")));
  });
}

export function createRelayServer(adapter: RelayAdapter, inbox: EventInbox, options: {
  voice?: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
} = {}) {
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok", milestone: 1 }));
      return;
    }
    if (request.url === "/v1/chat/completions" && options.voice) {
      await options.voice(request, response);
      return;
    }
    if (request.url !== "/webhooks/relay") {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    let rawBody: Buffer;
    try {
      rawBody = await readBody(request);
    } catch (error) {
      response.writeHead(error instanceof BodyTooLarge ? 413 : 400).end();
      return;
    }
    let event;
    try {
      event = adapter.verify(rawBody, {
        "webhook-id": request.headers["webhook-id"]?.toString(),
        "webhook-timestamp": request.headers["webhook-timestamp"]?.toString(),
        "webhook-signature": request.headers["webhook-signature"]?.toString(),
      });
    } catch {
      response.writeHead(401).end("Webhook rejected");
      return;
    }
    try {
      await inbox.acceptOnce(event);
    } catch {
      console.error("Inbox write failed; returning 503 so Relay can retry.");
      response.writeHead(503).end("Inbox unavailable");
      return;
    }
    response.writeHead(204).end();
    console.log(`Relay event committed: ${event.eventId}`);
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return server;
}
