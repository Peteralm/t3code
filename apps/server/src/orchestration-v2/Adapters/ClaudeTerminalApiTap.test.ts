// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeZlib from "node:zlib";

import { describe, expect, it } from "@effect/vitest";

import { startClaudeTerminalApiTap } from "./ClaudeTerminalApiTap.ts";

const SSE =
  'event: message_start\ndata: {"type":"message_start"}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

const MAIN_REQUEST = {
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_entrypoint=cli;" },
    { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
  ],
  tools: [{ name: "Bash" }],
  messages: [],
};

function listen(server: NodeHttp.Server) {
  return new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    }),
  );
}

function post(url: string, body: unknown) {
  return new Promise<{ readonly status: number; readonly body: Buffer }>((resolve, reject) => {
    const request = NodeHttp.request(
      `${url}/v1/messages?beta=true`,
      { method: "POST", headers: { "content-type": "application/json" } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

describe("startClaudeTerminalApiTap", () => {
  it("passes the response through and reads the main conversation's stream", async () => {
    const compressed = NodeZlib.gzipSync(SSE);
    const received: string[] = [];
    const upstream = NodeHttp.createServer((request, response) => {
      request.on("data", (chunk: Buffer) => received.push(chunk.toString("utf8")));
      request.on("end", () => {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "content-encoding": "gzip",
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-5h-utilization": "0.4",
          "anthropic-ratelimit-unified-5h-reset": "1792969800",
        });
        // Split mid-event, as the network does.
        response.write(compressed.subarray(0, 20));
        response.end(compressed.subarray(20));
      });
    });
    const upstreamPort = await listen(upstream);
    const events: unknown[] = [];
    const rateLimits: unknown[] = [];
    const statuses: number[] = [];
    let mainRequests = 0;
    const tap = await startClaudeTerminalApiTap(`http://127.0.0.1:${upstreamPort}`, {
      onMainRequest: () => mainRequests++,
      onMainResponse: (status) => statuses.push(status),
      onStreamEvent: (event) => events.push(event),
      onRateLimits: (infos) => rateLimits.push(...infos),
    });
    try {
      const response = await post(tap.url, MAIN_REQUEST);
      expect(response.status).toBe(200);
      expect(response.body.equals(compressed)).toBe(true);
      expect(JSON.parse(received.join(""))).toEqual(MAIN_REQUEST);
      expect(mainRequests).toBe(1);
      expect(statuses).toEqual([200]);
      // Decompression finishes on a later tick than the response.
      await expect.poll(() => events.length).toBe(3);
      expect(events).toEqual([
        { type: "message_start" },
        { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
        { type: "message_stop" },
      ]);
      expect(rateLimits).toMatchObject([{ rateLimitType: "five_hour", utilization: 0.4 }]);
    } finally {
      tap.close();
      upstream.close();
    }
  });

  it("leaves side requests unread", async () => {
    const upstream = NodeHttp.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(SSE);
    });
    const upstreamPort = await listen(upstream);
    const events: unknown[] = [];
    let mainRequests = 0;
    const tap = await startClaudeTerminalApiTap(`http://127.0.0.1:${upstreamPort}`, {
      onMainRequest: () => mainRequests++,
      onMainResponse: () => mainRequests++,
      onStreamEvent: (event) => events.push(event),
      onRateLimits: () => undefined,
    });
    try {
      const response = await post(tap.url, { ...MAIN_REQUEST, tools: [] });
      expect(response.body.toString("utf8")).toBe(SSE);
      expect(mainRequests).toBe(0);
      expect(events).toEqual([]);
    } finally {
      tap.close();
      upstream.close();
    }
  });

  it("reports the status and Retry-After of a failed main response", async () => {
    const upstream = NodeHttp.createServer((_request, response) => {
      response.writeHead(529, { "content-type": "application/json", "retry-after": "2" });
      response.end('{"type":"error"}');
    });
    const upstreamPort = await listen(upstream);
    const responses: Array<{ status: number; retryAfter: unknown }> = [];
    const tap = await startClaudeTerminalApiTap(`http://127.0.0.1:${upstreamPort}`, {
      onMainRequest: () => undefined,
      onMainResponse: (status, headers) =>
        responses.push({ status, retryAfter: headers["retry-after"] }),
      onStreamEvent: () => undefined,
      onRateLimits: () => undefined,
    });
    try {
      const response = await post(tap.url, MAIN_REQUEST);
      expect(response.status).toBe(529);
      expect(responses).toEqual([{ status: 529, retryAfter: "2" }]);
    } finally {
      tap.close();
      upstream.close();
    }
  });
});
