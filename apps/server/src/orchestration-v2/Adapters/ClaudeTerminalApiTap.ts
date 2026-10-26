// @effect-diagnostics nodeBuiltinImport:off
/**
 * A loopback pass-through between the Claude Code terminal and the Anthropic
 * API. Requests and responses cross unchanged; the tap reads the main
 * conversation's response stream and rate-limit headers, which the terminal
 * only shows on screen but the SDK reports as messages.
 */
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import type * as NodeStream from "node:stream";
import * as NodeStringDecoder from "node:string_decoder";
import * as NodeZlib from "node:zlib";

import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

import {
  isMainConversationRequest,
  parseServerSentEvents,
  rateLimitInfosFromHeaders,
} from "./ClaudeTerminalMessages.ts";

export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

const KEEP_ALIVE_TIMEOUT_MS = 120_000;

export interface ClaudeTerminalApiTapListener {
  /** A main-conversation request was sent. */
  readonly onMainRequest: () => void;
  /** The status and headers of a main-conversation response, before its body. */
  readonly onMainResponse: (status: number, headers: NodeHttp.IncomingHttpHeaders) => void;
  /** One server-sent event of a main-conversation response stream. */
  readonly onStreamEvent: (event: unknown) => void;
  readonly onRateLimits: (infos: ReadonlyArray<SDKRateLimitInfo>) => void;
}

export interface ClaudeTerminalApiTap {
  /** Base URL to hand Claude Code as ANTHROPIC_BASE_URL. */
  readonly url: string;
  readonly close: () => void;
}

function decompressorFor(encoding: string): NodeStream.Transform | undefined {
  switch (encoding) {
    case "gzip":
      return NodeZlib.createGunzip();
    case "deflate":
      return NodeZlib.createInflate();
    case "br":
      return NodeZlib.createBrotliDecompress();
    case "zstd":
      return NodeZlib.createZstdDecompress();
    default:
      return undefined;
  }
}

/** Decodes a copy of a response stream into server-sent events for the listener. */
function streamReader(
  headers: NodeHttp.IncomingHttpHeaders,
  listener: ClaudeTerminalApiTapListener,
): { readonly write: (chunk: Buffer) => void; readonly end: () => void } | undefined {
  let pending = "";
  const readText = (text: string) => {
    const parsed = parseServerSentEvents(pending + text);
    pending = parsed.rest;
    for (const event of parsed.events) notify(() => listener.onStreamEvent(event));
  };
  const encoding = String(headers["content-encoding"] ?? "identity")
    .trim()
    .toLowerCase();
  if (encoding === "identity") {
    const decoder = new NodeStringDecoder.StringDecoder("utf8");
    return { write: (chunk) => readText(decoder.write(chunk)), end: () => readText(decoder.end()) };
  }
  const decompressor = decompressorFor(encoding);
  if (!decompressor) return undefined;
  decompressor.setEncoding("utf8");
  decompressor.on("data", readText);
  // A decoding failure only costs the live preview, never the response.
  decompressor.on("error", () => undefined);
  return { write: (chunk) => decompressor.write(chunk), end: () => decompressor.end() };
}

/** Runs a listener callback; its failure only costs the live preview, never the API call. */
function notify(callback: () => void) {
  try {
    callback();
  } catch {
    // The transcript still carries everything the preview would have shown.
  }
}

function isMessagesRequest(method: string | undefined, url: string | undefined) {
  return method === "POST" && /^\/v1\/messages(\?|$)/.test(url ?? "");
}

export function startClaudeTerminalApiTap(
  upstreamBaseUrl: string,
  listener: ClaudeTerminalApiTapListener,
): Promise<ClaudeTerminalApiTap> {
  const upstream = new URL(upstreamBaseUrl);
  const transport = upstream.protocol === "http:" ? NodeHttp : NodeHttps;
  const agent = new transport.Agent({ keepAlive: true });
  const basePath = upstream.pathname.replace(/\/$/, "");

  const server = NodeHttp.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const messages = isMessagesRequest(request.method, request.url);
      let main = false;
      if (messages) {
        try {
          main = isMainConversationRequest(JSON.parse(body.toString("utf8")));
        } catch {
          main = false;
        }
      }
      if (main) notify(() => listener.onMainRequest());

      const outgoing = transport.request(
        {
          agent,
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || undefined,
          method: request.method,
          path: `${basePath}${request.url ?? "/"}`,
          headers: { ...request.headers, host: upstream.host },
        },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          if (main) {
            notify(() => listener.onMainResponse(incoming.statusCode ?? 502, incoming.headers));
          }
          if (messages) {
            const infos = rateLimitInfosFromHeaders(incoming.headers);
            if (infos.length > 0) notify(() => listener.onRateLimits(infos));
          }
          const isStream = String(incoming.headers["content-type"] ?? "").includes(
            "text/event-stream",
          );
          const tee = main && isStream ? streamReader(incoming.headers, listener) : undefined;
          incoming.on("data", (chunk: Buffer) => {
            response.write(chunk);
            tee?.write(chunk);
          });
          incoming.on("end", () => {
            response.end();
            tee?.end();
          });
          incoming.on("error", () => response.destroy());
        },
      );
      outgoing.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      // An interrupted turn closes the request; the API call must stop with it.
      response.on("close", () => {
        if (!response.writableFinished) outgoing.destroy();
      });
      outgoing.end(body);
    });
  });

  // Claude reuses its connection across tool calls; Node's 5 s default would close it between them.
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1_000;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => {
          server.close();
          server.closeAllConnections();
          agent.destroy();
        },
      });
    });
  });
}
