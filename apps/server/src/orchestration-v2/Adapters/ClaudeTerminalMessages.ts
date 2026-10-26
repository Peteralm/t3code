/**
 * Pure translation between Claude Code's interactive terminal and the Agent SDK's
 * message protocol: CLI arguments and hook settings in, SDK messages out of
 * transcript rows, hook payloads and API response headers.
 */
import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  SDKMessage,
  SDKRateLimitInfo,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type HookKind =
  | "session-start"
  | "prompt-submit"
  | "stop"
  | "permission"
  | "pre-tool-use"
  | "pre-compact"
  | "post-compact"
  | "subagent-start"
  | "subagent-stop";

const HOOK_EVENTS: ReadonlyArray<readonly [string, HookKind]> = [
  ["SessionStart", "session-start"],
  ["UserPromptSubmit", "prompt-submit"],
  ["Stop", "stop"],
  // A turn an API error ended, such as a refusal, fires StopFailure instead of Stop.
  ["StopFailure", "stop"],
  ["PermissionRequest", "permission"],
  ["PreToolUse", "pre-tool-use"],
  ["PreCompact", "pre-compact"],
  ["PostCompact", "post-compact"],
  ["SubagentStart", "subagent-start"],
  ["SubagentStop", "subagent-stop"],
];

/** Approvals wait on a person; the hook must outlive any realistic review. */
const PERMISSION_HOOK_TIMEOUT_SECONDS = 24 * 60 * 60;

/** One hook payload, as Claude Code writes it to the hook's stdin. */
export interface HookInput {
  readonly session_id?: string;
  readonly transcript_path?: string;
  readonly permission_mode?: string;
  readonly prompt?: string;
  readonly source?: string;
  readonly model?: string;
  readonly tool_name?: string;
  readonly tool_input?: Record<string, unknown>;
  readonly tool_use_id?: string;
  readonly tool_response?: unknown;
  readonly permission_suggestions?: unknown;
  readonly trigger?: string;
  /** Set on tool and approval hooks fired inside a subagent. */
  readonly agent_id?: string;
  readonly agent_type?: string;
  readonly agent_transcript_path?: string;
  readonly last_assistant_message?: string;
  readonly background_tasks?: ReadonlyArray<{ readonly id?: string; readonly status?: string }>;
}

/** One JSON line of a Claude Code session transcript. */
export interface ClaudeTranscriptEntry {
  readonly type?: string;
  readonly subtype?: string;
  readonly uuid?: string;
  readonly timestamp?: string;
  readonly requestId?: string;
  readonly isSidechain?: boolean;
  readonly isMeta?: boolean;
  readonly isCompactSummary?: boolean;
  readonly isApiErrorMessage?: boolean;
  readonly error?: unknown;
  readonly apiErrorStatus?: number;
  readonly apiErrorParams?: unknown;
  readonly toolUseResult?: unknown;
  readonly content?: unknown;
  readonly level?: unknown;
  readonly compactMetadata?: Record<string, unknown>;
  readonly logicalParentUuid?: string;
  readonly operation?: string;
  readonly reason?: string;
  readonly retryAttempt?: number;
  readonly maxRetries?: number;
  readonly retryInMs?: number;
  readonly agentId?: string;
  /** Who submitted a prompt row: a person, a finished task, a peer session. */
  readonly origin?: Record<string, unknown>;
  readonly message?: {
    readonly id?: string;
    readonly role?: string;
    readonly model?: string;
    readonly content?: unknown;
    readonly stop_reason?: string | null;
    readonly usage?: Record<string, unknown>;
  };
}

export const stripTerminalEscapes = (text: string) =>
  text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][0-9A-B]/g, "");

/** What the footer shows for each mode Shift+Tab cycles through. */
const PERMISSION_MODE_LABELS: ReadonlyArray<readonly [string, PermissionMode]> = [
  ["accept edits on", "acceptEdits"],
  ["plan mode on", "plan"],
  ["auto mode on", "auto"],
  ["bypass permissions on", "bypassPermissions"],
  // Default mode reads "manual" when the user's own default is auto, and has no label otherwise.
  ["manual mode on", "default"],
  ["? for shortcuts", "default"],
];

/** Stands for a cell a redraw skipped because it already held the right character. */
const SKIPPED_CELL = "\u0000";

const PERMISSION_MODE_PATTERNS = PERMISSION_MODE_LABELS.map(([label, mode]) => ({
  mode,
  pattern: new RegExp([...label].map((char) => `[${char}${SKIPPED_CELL}]`).join(""), "g"),
}));

/** The permission mode the footer shows last in a stretch of terminal output. */
export function permissionModeShown(output: string): PermissionMode | undefined {
  const text = stripTerminalEscapes(
    output.replace(/\x1b\[(\d*)C/g, (_, count: string) =>
      SKIPPED_CELL.repeat(Number(count || "1")),
    ),
  );
  let shown: { readonly mode: PermissionMode; readonly at: number } | undefined;
  for (const { mode, pattern } of PERMISSION_MODE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (!shown || match.index > shown.at) shown = { mode, at: match.index };
    }
  }
  return shown?.mode;
}

/** Options the SDK would have handled that a startup dialog asks about instead. */
const ACCEPTED_DIALOG_OPTIONS = ["Yes, I trust this folder", "Yes, I accept"];

/**
 * Key to press for a startup dialog (folder trust, bypass-permissions warning,
 * project MCP servers), or undefined when no dialog is open. Accepts the
 * options listed in ACCEPTED_DIALOG_OPTIONS, keeps the default otherwise.
 */
export function startupDialogKey(screenTail: string): "down" | "enter" | undefined {
  // Cursor moves render as gaps, so compare with whitespace removed.
  const flat = stripTerminalEscapes(screenTail).replace(/\s/g, "");
  if (!flat.slice(-200).includes("Entertoconfirm")) return undefined;
  for (const option of ACCEPTED_DIALOG_OPTIONS) {
    const label = option.replace(/\s/g, "");
    if (!flat.includes(label)) continue;
    const selectedAt = flat.lastIndexOf(`❯${label}`);
    const otherSelectedAt = flat.lastIndexOf("❯");
    return selectedAt >= 0 && selectedAt === otherSelectedAt ? "enter" : "down";
  }
  return "enter";
}

function hookCommand(port: number, token: string, kind: HookKind) {
  return `curl -sS -X POST --data-binary @- http://127.0.0.1:${port}/${token}/${kind}`;
}

/** Settings layered over the user's, adding the hooks the terminal runtime listens to. */
export function makeTerminalSettings<Base extends Record<string, unknown>>(
  base: Base,
  hook: { readonly port: number; readonly token: string },
) {
  // Hooks the adapter's settings already carry run beside T3's own.
  const baseHooks = (base.hooks ?? {}) as Record<string, ReadonlyArray<unknown>>;
  const ownHooks = Object.fromEntries(
    HOOK_EVENTS.map(([event, kind]) => [
      event,
      {
        // An approval names its tool call only through the PreToolUse before it.
        ...(kind === "pre-tool-use" ? { matcher: "*" } : {}),
        hooks: [
          {
            type: "command",
            command: hookCommand(hook.port, hook.token, kind),
            ...(kind === "permission" ? { timeout: PERMISSION_HOOK_TIMEOUT_SECONDS } : {}),
          },
        ],
      },
    ]),
  );
  return {
    ...base,
    hooks: Object.fromEntries(
      [...new Set([...Object.keys(baseHooks), ...Object.keys(ownHooks)])].map((event) => [
        event,
        [...(baseHooks[event] ?? []), ...(ownHooks[event] ? [ownHooks[event]] : [])],
      ]),
    ) as Record<
      string,
      Array<{
        readonly matcher?: string;
        readonly hooks: Array<{
          readonly type: string;
          readonly command: string;
          readonly timeout?: number;
        }>;
      }>
    >,
  };
}

/** CLI arguments equivalent to the SDK options the adapter builds. */
export function makeTerminalArgs(
  options: ClaudeQueryOptions,
  files: {
    readonly settingsPath: string;
    readonly mcpConfigPath?: string | undefined;
    /** Set when the process restarts on a session it already created. */
    readonly resumeSessionId?: string | undefined;
  },
): string[] {
  const systemPrompt = options.systemPrompt;
  const append =
    typeof systemPrompt === "object" &&
    !Array.isArray(systemPrompt) &&
    systemPrompt.type === "preset"
      ? systemPrompt.append
      : undefined;
  const extraArgs = Object.entries(options.extraArgs ?? {}).flatMap(([flag, value]) =>
    // T3's settings file carries the hooks; launch settings are merged into it instead.
    flag === "settings"
      ? []
      : value === null
        ? [`--${flag}`]
        : // A value that looks like a flag must stay attached to its own.
          value.startsWith("-")
          ? [`--${flag}=${value}`]
          : [`--${flag}`, value],
  );
  const resume = files.resumeSessionId ?? options.resume;
  return [
    "--settings",
    files.settingsPath,
    ...(resume
      ? ["--resume", resume]
      : options.sessionId
        ? ["--session-id", options.sessionId]
        : []),
    ...(options.model ? ["--model", options.model] : []),
    ...(options.effort ? ["--effort", String(options.effort)] : []),
    ...(options.permissionMode ? ["--permission-mode", options.permissionMode] : []),
    ...(options.allowDangerouslySkipPermissions ? ["--allow-dangerously-skip-permissions"] : []),
    ...(options.settingSources ? ["--setting-sources", options.settingSources.join(",")] : []),
    ...(Array.isArray(options.tools) ? ["--tools", options.tools.join(",")] : []),
    ...(options.allowedTools?.length ? ["--allowedTools", options.allowedTools.join(",")] : []),
    ...(options.disallowedTools?.length
      ? ["--disallowedTools", options.disallowedTools.join(",")]
      : []),
    ...(options.additionalDirectories ?? []).flatMap((dir) => ["--add-dir", dir]),
    ...(append ? ["--append-system-prompt", append] : []),
    ...(files.mcpConfigPath ? ["--mcp-config", files.mcpConfigPath] : []),
    ...extraArgs,
  ];
}

export function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

export function promptText(message: SDKUserMessage): string {
  const content = message.message.content;
  if (typeof content === "string") return content;
  return contentBlocks(content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n\n");
}

const isEmojiPart = (character: string | undefined) =>
  character !== undefined &&
  // A selector or skin tone ends an emoji as much as its base does.
  /\p{Extended_Pictographic}|\uFE0F|[\u{1F3FB}-\u{1F3FF}]/u.test(character);

/**
 * Removes the characters the input box strips on its own (it then asks for a
 * confirmation or drops the prompt): zero-width, bidi, soft hyphen, tags and
 * variation selectors. Line and paragraph separators become line breaks; the
 * joiner, selector and tags inside an emoji sequence stay.
 */
export function stripInvisibleCharacters(text: string): string {
  const characters = Array.from(text.replace(/[\u2028\u2029]/g, "\n"));
  const kept: string[] = [];
  for (const [index, character] of characters.entries()) {
    // Judged against what stays: a tag after a removed tag has no emoji before it.
    const before = kept.at(-1);
    const after = characters[index + 1];
    const code = character.codePointAt(0) ?? 0;
    let keep: boolean;
    if (character === "\u200D") keep = isEmojiPart(before) && isEmojiPart(after);
    else if (/^[\uFE00-\uFE0F]$/.test(character)) keep = isEmojiPart(before) || after === "\u20E3";
    else if (code >= 0xe0020 && code <= 0xe007f) {
      keep = isEmojiPart(before) || (before?.codePointAt(0) ?? 0) >= 0xe0020;
    } else keep = !/^\p{Cf}$/u.test(character);
    if (keep) kept.push(character);
  }
  return kept.join("");
}

/** A prompt as T3 types it: Claude Code reads a lone carriage return as Enter. */
export const normalizePromptText = (text: string) =>
  stripInvisibleCharacters(text).replace(/\r\n?/g, "\n").trim();

/**
 * What a typed prompt and the text Claude Code reports for it share. The input
 * box turns tabs into spaces, and a guard space may lead the typed text.
 */
export const promptMatchKey = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The prompt as keys for the input box. A prompt that starts with `!` would
 * run as a shell command, so a space leads it, which Claude Code keeps as text.
 */
export function terminalInputText(text: string): string {
  // Control characters would reach the terminal as keys: Esc could end the paste early
  // and run the rest as shortcuts, such as interrupting the turn. The C1 range
  // (U+0080-U+009F) holds the 8-bit forms of the same controls, such as CSI.
  const typable = text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  return typable.startsWith("!") ? ` ${typable}` : typable;
}

/**
 * What one paste may carry: Claude Code wraps a paste of more than 800 characters
 * or 3 lines as pasted material (measured), so these stay under both.
 */
const PASTE_CHUNK_LENGTH = 500;
const PASTE_MAX_LINE_BREAKS = 2;

/**
 * Splits input into pastes Claude Code takes as typed text. A wrapped paste
 * reaches the model inside `<pasted_content>` tags, which tell it the text may
 * not be the user's own request.
 */
export function inputPastes(text: string): string[] {
  const pastes: string[] = [];
  let current = "";
  let lineBreaks = 0;
  for (const character of text) {
    if (current.length + character.length > PASTE_CHUNK_LENGTH) {
      pastes.push(current);
      current = "";
      lineBreaks = 0;
    }
    current += character;
    if (character === "\n" && ++lineBreaks === PASTE_MAX_LINE_BREAKS) {
      pastes.push(current);
      current = "";
      lineBreaks = 0;
    }
  }
  if (current) pastes.push(current);
  return pastes;
}

const LOCAL_COMMAND_STDOUT = "<local-command-stdout>";
/** A local command that failed, such as /compact with too little to summarize, prints here. */
const LOCAL_COMMAND_STDERR = "<local-command-stderr>";

/**
 * The command line a local command's row records, such as `/model sonnet`. A command
 * typed while a turn ran waits in Claude's queue and is recorded as a system row.
 */
export function localCommandInvocation(entry: ClaudeTranscriptEntry): string | undefined {
  if (entry.isMeta) return undefined;
  const content =
    entry.type === "user"
      ? entry.message?.content
      : entry.type === "system" && entry.subtype === "local_command"
        ? entry.content
        : undefined;
  if (typeof content !== "string") return undefined;
  const name = /<command-name>([^<]*)<\/command-name>/.exec(content)?.[1];
  if (name === undefined) return undefined;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(content)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

/**
 * Splits a session transcript at the row `uuid`, so a resume continues from
 * that message the way the SDK's `resumeSessionAt` does; the interactive CLI
 * ignores that flag. Undefined when nothing follows the row, or it is absent.
 */
export function transcriptRewoundTo(
  text: string,
  uuid: string,
): { readonly kept: string; readonly removed: string } | undefined {
  const lines = text.split("\n").filter((line) => line.trim());
  const rows = lines.map((line) => {
    try {
      return JSON.parse(line) as ClaudeTranscriptEntry;
    } catch {
      return undefined;
    }
  });
  const at = rows.findIndex((row) => row?.uuid === uuid);
  if (at < 0) return undefined;
  const later = rows
    .slice(at + 1)
    .some((row) => (row?.type === "user" || row?.type === "assistant") && !row.isSidechain);
  if (!later) return undefined;
  return {
    kept: `${lines.slice(0, at + 1).join("\n")}\n`,
    removed: `${lines.slice(at + 1).join("\n")}\n`,
  };
}

/** The output a local slash command such as /compact or /cost printed, if the entry holds one. */
export function localCommandOutput(entry: ClaudeTranscriptEntry): string | undefined {
  if (entry.isMeta) return undefined;
  const text =
    entry.type === "user"
      ? entry.message?.content
      : entry.type === "system" && entry.subtype === "local_command"
        ? entry.content
        : undefined;
  return typeof text === "string" &&
    (text.startsWith(LOCAL_COMMAND_STDOUT) || text.startsWith(LOCAL_COMMAND_STDERR))
    ? text
    : undefined;
}

function snakeCaseKeys(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? snakeCaseKeys(value as Record<string, unknown>)
        : value,
    ]),
  );
}

export function apiRetryError(status: number | null): string {
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 400) return "invalid_request";
  if (status === 402) return "billing_error";
  if (status === 404) return "model_not_found";
  if (status !== null && status >= 500) return "server_error";
  return "unknown";
}

/** A 429 that asks for a wait longer than this is a usage limit, which Claude Code shows instead of retrying. */
const MAX_RETRYABLE_429_RETRY_AFTER_SECONDS = 60;

/**
 * The statuses Claude Code retries on its own. A 429 counts only with a short
 * Retry-After: without one, or with a long one, it reports the usage limit.
 */
export function isRetryableApiStatus(status: number, retryAfter?: string): boolean {
  if (status === 429) {
    const seconds = retryAfter === undefined ? Number.NaN : Number(retryAfter);
    return (
      Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_RETRYABLE_429_RETRY_AFTER_SECONDS
    );
  }
  return status === 408 || status === 409 || status >= 500;
}

/** How long Claude Code waits before retry `attempt` (1-based): the server's Retry-After, else a capped doubling. */
export function apiRetryDelayMs(attempt: number, retryAfter: string | undefined): number {
  const seconds = retryAfter === undefined ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  return Math.min(500 * 2 ** (attempt - 1), 32_000);
}

/** Claude Code's retry budget, set by CLAUDE_CODE_MAX_RETRIES (10 when unset or invalid). */
export function maxApiRetries(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
}

/**
 * The SDK message a main-session transcript entry carries, or undefined for
 * entries the SDK would not emit: the prompt itself, meta rows, bookkeeping.
 * Transcript rows store the SDK message bodies verbatim, which the casts rely on.
 * `parentToolUseId` places a subagent's rows under the Agent call that runs it.
 */
export function sdkMessageFromTranscriptEntry(
  entry: ClaudeTranscriptEntry,
  sessionId: string,
  parentToolUseId: string | null = null,
): SDKMessage | undefined {
  if (!entry.uuid || entry.isMeta) return undefined;
  if (entry.isSidechain && parentToolUseId === null) return undefined;
  const common = { uuid: entry.uuid, session_id: sessionId };
  const commandOutput = parentToolUseId === null ? localCommandOutput(entry) : undefined;
  if (commandOutput !== undefined) {
    return {
      type: "user",
      message: { role: "user", content: commandOutput },
      parent_tool_use_id: null,
      isReplay: true,
      ...common,
    } as unknown as SDKMessage;
  }
  if (entry.type === "system") {
    if (entry.subtype === "compact_boundary") {
      return {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: snakeCaseKeys(entry.compactMetadata ?? {}),
        ...(entry.logicalParentUuid ? { logical_parent_uuid: entry.logicalParentUuid } : {}),
        ...common,
      } as unknown as SDKMessage;
    }
    // Notices such as "safeguards stopped the response above · continuing once".
    if (
      (entry.subtype === "informational" || entry.subtype === "model_refusal_fallback") &&
      typeof entry.content === "string"
    ) {
      return {
        type: "system",
        subtype: entry.subtype,
        content: entry.content,
        level: typeof entry.level === "string" ? entry.level : "info",
        ...common,
      } as unknown as SDKMessage;
    }
    if (entry.subtype === "api_error") {
      const error = (entry.error ?? {}) as { readonly status?: unknown };
      const status = typeof error.status === "number" ? error.status : null;
      return {
        type: "system",
        subtype: "api_retry",
        attempt: entry.retryAttempt ?? 1,
        max_retries: entry.maxRetries ?? 1,
        retry_delay_ms: entry.retryInMs ?? 0,
        error_status: status,
        error: apiRetryError(status),
        ...common,
      } as unknown as SDKMessage;
    }
    return undefined;
  }
  if (!entry.message) return undefined;
  if (entry.type === "assistant") {
    return {
      type: "assistant",
      message: entry.message,
      parent_tool_use_id: parentToolUseId,
      ...(entry.isApiErrorMessage
        ? {
            ...(typeof entry.error === "string" ? { error: entry.error } : {}),
            is_api_error_message: true,
            ...(typeof entry.apiErrorStatus === "number"
              ? { api_error_status: entry.apiErrorStatus }
              : {}),
          }
        : {}),
      ...(entry.apiErrorParams ? { api_error_params: entry.apiErrorParams } : {}),
      ...(entry.requestId ? { request_id: entry.requestId } : {}),
      ...common,
    } as unknown as SDKMessage;
  }
  if (entry.type !== "user") return undefined;
  const content = entry.message.content;
  if (contentBlocks(content).some((block) => block.type === "tool_result")) {
    return {
      type: "user",
      message: entry.message,
      parent_tool_use_id: parentToolUseId,
      ...(entry.toolUseResult !== undefined ? { tool_use_result: entry.toolUseResult } : {}),
      ...common,
    } as unknown as SDKMessage;
  }
  // A subagent's opening prompt, which the SDK reports under its Agent call.
  if (parentToolUseId !== null) {
    return {
      type: "user",
      message: entry.message,
      parent_tool_use_id: parentToolUseId,
      ...common,
    } as unknown as SDKMessage;
  }
  if (entry.isCompactSummary) {
    return {
      type: "user",
      message: entry.message,
      parent_tool_use_id: null,
      isSynthetic: true,
      ...common,
    } as unknown as SDKMessage;
  }
  return undefined;
}

/** The prompt text of a transcript row a person or a queue submitted, if it is one. */
export function submittedPromptText(entry: ClaudeTranscriptEntry): string | undefined {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain || entry.isCompactSummary) {
    return undefined;
  }
  const content = entry.message?.content;
  if (typeof content === "string") return localCommandOutput(entry) ? undefined : content;
  const blocks = contentBlocks(content);
  if (blocks.some((block) => block.type === "tool_result")) return undefined;
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n\n");
}

/** Fields of a `<task-notification>` prompt, which Claude Code queues when background work ends. */
export interface TaskNotification {
  readonly taskId: string;
  readonly toolUseId: string | undefined;
  readonly status: string;
  readonly summary: string;
  readonly outputFile: string;
}

export function parseTaskNotification(prompt: string): TaskNotification | undefined {
  if (!prompt.trimStart().startsWith("<task-notification>")) return undefined;
  const field = (name: string) =>
    new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(prompt)?.[1]?.trim();
  const taskId = field("task-id");
  if (!taskId) return undefined;
  return {
    taskId,
    toolUseId: field("tool-use-id"),
    // No status: an event of a task that goes on, such as a Monitor line.
    status: field("status") ?? "",
    summary: field("summary") ?? "",
    outputFile: field("output-file") ?? "",
  };
}

const RATE_LIMIT_WINDOWS: Record<string, string> = {
  "5h": "five_hour",
  "7d": "seven_day",
  "7d_opus": "seven_day_opus",
  "7d_sonnet": "seven_day_sonnet",
};

/**
 * Rate-limit frames for the windows a /v1/messages response reports in its
 * `anthropic-ratelimit-unified-*` headers, one per window like the CLI's.
 */
export function rateLimitInfosFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): SDKRateLimitInfo[] {
  const header = (name: string) => {
    const value = headers[`anthropic-ratelimit-unified-${name}`];
    return Array.isArray(value) ? value[0] : value;
  };
  const number = (name: string) => {
    const text = header(name)?.trim();
    const value = text ? Number(text) : Number.NaN;
    return Number.isFinite(value) ? value : undefined;
  };
  const unifiedWindows: Record<
    string,
    { utilization?: number; resetsAt?: number; status?: string }
  > = {};
  for (const [prefix, window] of Object.entries(RATE_LIMIT_WINDOWS)) {
    const utilization = number(`${prefix}-utilization`);
    if (utilization === undefined) continue;
    unifiedWindows[window] = {
      utilization,
      ...(number(`${prefix}-reset`) === undefined ? {} : { resetsAt: number(`${prefix}-reset`)! }),
      ...(header(`${prefix}-status`) === undefined ? {} : { status: header(`${prefix}-status`)! }),
    };
  }
  const shared = {
    ...(header("overage-status") === undefined ? {} : { overageStatus: header("overage-status") }),
    ...(header("overage-disabled-reason") === undefined
      ? {}
      : { overageDisabledReason: header("overage-disabled-reason") }),
    isUsingOverage: header("overage-in-use") === "true",
    unifiedWindows,
  };
  return Object.entries(unifiedWindows).map(
    ([window, value]) =>
      ({
        // The overall status may come from another window; a full window is rejected.
        status: value.status ?? ((value.utilization ?? 0) >= 1 ? "rejected" : "allowed"),
        rateLimitType: window,
        utilization: value.utilization,
        ...(value.resetsAt === undefined ? {} : { resetsAt: value.resetsAt }),
        ...shared,
      }) as unknown as SDKRateLimitInfo,
  );
}

/**
 * Whether a /v1/messages body is a turn of the main conversation: the Claude
 * Code system prompt with tools, not a subagent, title, summary or hook check.
 */
export function isMainConversationRequest(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const request = body as { readonly system?: unknown; readonly tools?: unknown };
  if (!Array.isArray(request.tools) || request.tools.length === 0) return false;
  const system = Array.isArray(request.system)
    ? request.system.map((part) => String((part as { readonly text?: unknown }).text ?? ""))
    : [String(request.system ?? "")];
  if (system.some((part) => part.includes("cc_is_subagent=true"))) return false;
  if (!system.some((part) => part.startsWith("You are Claude Code"))) return false;
  // After a turn, Claude Code reuses the conversation to suggest the next prompt.
  const messages = (body as { readonly messages?: unknown }).messages;
  const last = Array.isArray(messages) ? (messages.at(-1) as { readonly content?: unknown }) : null;
  const lastText = typeof last?.content === "string" ? last.content : "";
  return !lastText.startsWith("[SUGGESTION MODE");
}

/**
 * Splits a server-sent-events buffer into the JSON payloads of its complete
 * `data:` lines; returns the unfinished tail to prepend to the next chunk.
 */
export function parseServerSentEvents(buffer: string): {
  readonly events: unknown[];
  readonly rest: string;
} {
  const events: unknown[] = [];
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // A keep-alive or a malformed frame carries nothing to stream.
    }
  }
  return { events, rest };
}
