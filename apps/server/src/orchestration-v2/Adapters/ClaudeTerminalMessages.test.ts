import { describe, expect, it } from "@effect/vitest";

import {
  apiRetryDelayMs,
  apiRetryError,
  inputPastes,
  isMainConversationRequest,
  isRetryableApiStatus,
  localCommandInvocation,
  makeTerminalArgs,
  makeTerminalSettings,
  maxApiRetries,
  normalizePromptText,
  parseServerSentEvents,
  parseTaskNotification,
  permissionModeShown,
  promptMatchKey,
  promptText,
  rateLimitInfosFromHeaders,
  sdkMessageFromTranscriptEntry,
  startupDialogKey,
  stripInvisibleCharacters,
  submittedPromptText,
  terminalInputText,
  transcriptRewoundTo,
} from "./ClaudeTerminalMessages.ts";

const SESSION_ID = "6f1c2a7e-0000-4000-8000-000000000000";

describe("startupDialogKey", () => {
  const trustDialog = (selected: "no" | "yes") =>
    [
      "Quick safety check: Is this a project you created or one you trust?",
      selected === "no" ? "❯ No, exit" : "  No, exit",
      selected === "yes" ? "❯ Yes, I trust this folder" : "  Yes, I trust this folder",
      "Enter to confirm · Esc to cancel",
    ].join("\n");

  it("moves to the trust option, then confirms it", () => {
    expect(startupDialogKey(trustDialog("no"))).toBe("down");
    expect(startupDialogKey(`${trustDialog("no")}\n${trustDialog("yes")}`)).toBe("enter");
  });

  it("keeps the default of other dialogs", () => {
    const mcpDialog = [
      "New MCP server found in this project: xcodebuildmcp",
      "  Use this MCP server",
      "❯ Continue without using this MCP server",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(startupDialogKey(mcpDialog)).toBe("enter");
  });

  it("ignores screens without a dialog", () => {
    expect(startupDialogKey('❯ Try "refactor <filepath>"')).toBeUndefined();
  });
});

describe("permissionModeShown", () => {
  // Footer redraws as Claude Code 2.1.310 writes them after Shift+Tab.
  const ESC = "\u001b";
  const footer = (label: string) => `${ESC}[38;2;175;135;255m${ESC}[48;3H${label}${ESC}[39m`;

  it("reads the mode a redraw names last", () => {
    expect(permissionModeShown(footer(`⏵⏵ accept edits on${ESC}[1C(shift+tab to cycle)`))).toBe(
      "acceptEdits",
    );
    expect(
      permissionModeShown(
        `${footer("⏵⏵ auto mode on (shift+tab to cycle)")}${footer("⏸ plan mode on ")}`,
      ),
    ).toBe("plan");
    expect(permissionModeShown(footer("⏵⏵ bypass permissions on (shift+tab to cycle)"))).toBe(
      "bypassPermissions",
    );
  });

  it("reads default mode with or without a label", () => {
    expect(permissionModeShown(footer(`⏸ manual mode on · ? for short${ESC}[1Cuts`))).toBe(
      "default",
    );
    expect(permissionModeShown(footer("? for shortcuts"))).toBe("default");
  });

  it("matches cells a redraw skipped because they already held the letter", () => {
    expect(permissionModeShown(footer(`⏵⏵ ${ESC}[1Cuto mode on`))).toBe("auto");
    expect(permissionModeShown(footer(`${ESC}[3Cplan mode on`))).toBe("plan");
  });

  it("finds nothing in output without the footer", () => {
    expect(permissionModeShown(`${ESC}[10;1H● Reading 2 files`)).toBeUndefined();
  });
});

describe("terminal input", () => {
  it("pastes one line at a time, in pieces Claude Code takes as typed text", () => {
    expect(inputPastes("one\ntwo\n\nthree")).toEqual(["one\ntwo\n", "\nthree"]);
    const long = "a".repeat(1100);
    expect(inputPastes(long).map((paste) => paste.length)).toEqual([500, 500, 100]);
    expect(inputPastes(`${"b".repeat(499)}😀c`)).toEqual(["b".repeat(499), "😀c"]);
    // 3000 lines take 1500 pastes, none with more than two line breaks.
    const lines = Array.from({ length: 3000 }, (_, index) => `line ${index}`).join("\n");
    const pastes = inputPastes(lines);
    expect(pastes).toHaveLength(1500);
    expect(pastes.join("")).toBe(lines);
    expect(pastes.every((paste) => paste.split("\n").length <= 3)).toBe(true);
    expect(inputPastes("")).toEqual([]);
  });

  it("removes the invisible characters the input box would strip", () => {
    expect(stripInvisibleCharacters("a\u200Bb\u202Ec\u00ADd\uFEFFe\u2060f\u200Eg\u{E0041}h")).toBe(
      "abcdefgh",
    );
    expect(stripInvisibleCharacters("a\u2028b\u2029c")).toBe("a\nb\nc");
    // Tags outside an emoji sequence all go, not only the first.
    expect(stripInvisibleCharacters("ok\u{E0041}\u{E0042}\u{E0043}")).toBe("ok");
    // Inside an emoji sequence the joiner and selector are part of the character.
    expect(stripInvisibleCharacters("\u{1F468}\u200D\u{1F469}")).toBe("\u{1F468}\u200D\u{1F469}");
    expect(stripInvisibleCharacters("\u2764\uFE0F")).toBe("\u2764\uFE0F");
    expect(stripInvisibleCharacters("a\u200Db\uFE0Fc")).toBe("abc");
    // The joiner after a selector or a skin tone is part of the sequence too.
    for (const sequence of ["\u2764\uFE0F\u200D\u{1F525}", "\u{1F469}\u{1F3FD}\u200D\u{1F4BB}"]) {
      expect(stripInvisibleCharacters(sequence)).toBe(sequence);
    }
    expect(normalizePromptText(" \u200B\n ")).toBe("");
  });

  it("keeps a prompt that starts with ! out of shell mode", () => {
    expect(terminalInputText("!important")).toBe(" !important");
    expect(terminalInputText("say !hi")).toBe("say !hi");
  });

  it("drops control characters that would reach the terminal as keys", () => {
    expect(terminalInputText("log \u001b[201~ end\u0003\ttab\nnext")).toBe(
      "log [201~ end\ttab\nnext",
    );
  });

  it("drops the C1 control characters, the 8-bit forms of the same keys", () => {
    expect(terminalInputText("a\u009b201~b\u0080c\u009fd e")).toBe("a201~bcd e");
  });

  it("matches a prompt to what Claude Code reports for it", () => {
    expect(promptMatchKey(" !a\tb\r\nc ")).toBe(promptMatchKey("!a    b\nc"));
  });
});

describe("makeTerminalArgs", () => {
  it("maps the adapter's SDK options to CLI flags", () => {
    const args = makeTerminalArgs(
      {
        sessionId: SESSION_ID,
        model: "claude-opus-5-5",
        effort: "medium",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["user", "project", "local"],
        additionalDirectories: ["/work", "/attachments"],
        tools: ["Read", "Bash"],
        allowedTools: ["mcp__t3-code__*"],
        disallowedTools: ["WebFetch"],
        systemPrompt: { type: "preset", preset: "claude_code", append: "Be brief." },
        extraArgs: { chrome: null, "max-turns": "5" },
      },
      { settingsPath: "/tmp/settings.json", mcpConfigPath: "/tmp/mcp.json" },
    );
    expect(args).toEqual([
      "--settings",
      "/tmp/settings.json",
      "--session-id",
      SESSION_ID,
      "--model",
      "claude-opus-5-5",
      "--effort",
      "medium",
      "--permission-mode",
      "bypassPermissions",
      "--allow-dangerously-skip-permissions",
      "--setting-sources",
      "user,project,local",
      "--tools",
      "Read,Bash",
      "--allowedTools",
      "mcp__t3-code__*",
      "--disallowedTools",
      "WebFetch",
      "--add-dir",
      "/work",
      "--add-dir",
      "/attachments",
      "--append-system-prompt",
      "Be brief.",
      "--mcp-config",
      "/tmp/mcp.json",
      "--chrome",
      "--max-turns",
      "5",
    ]);
  });

  it("resumes instead of naming a new session", () => {
    const args = makeTerminalArgs(
      { resume: SESSION_ID, sessionId: "unused" },
      { settingsPath: "s.json" },
    );
    expect(args.slice(2, 4)).toEqual(["--resume", SESSION_ID]);
    expect(args).not.toContain("--session-id");
  });

  it("merges launch settings instead of passing them, and keeps flag-like values attached", () => {
    const args = makeTerminalArgs(
      { extraArgs: { settings: "{}", "thinking-display": "summarized", "append-flag": "-x" } },
      { settingsPath: "s.json" },
    );
    expect(args.filter((arg) => arg === "--settings")).toHaveLength(1);
    expect(args).toContain("--append-flag=-x");
    expect(args.slice(-3, -1)).toEqual(["--thinking-display", "summarized"]);
  });

  it("resumes its own session on a restart, from the session head", () => {
    const args = makeTerminalArgs(
      { sessionId: SESSION_ID, resumeSessionAt: "msg_1" },
      { settingsPath: "s.json", resumeSessionId: SESSION_ID },
    );
    expect(args.slice(2, 4)).toEqual(["--resume", SESSION_ID]);
    expect(args).not.toContain("--resume-session-at");
  });
});

describe("transcriptRewoundTo", () => {
  const row = (uuid: string, type = "user", extra: Record<string, unknown> = {}) =>
    JSON.stringify({ uuid, type, ...extra });
  const transcript = [
    row("u1"),
    row("a1", "assistant"),
    row("u2"),
    row("s1", "assistant", { isSidechain: true }),
    row("a2", "assistant"),
  ].join("\n");

  it("cuts the transcript after the message a resume continues from", () => {
    expect(transcriptRewoundTo(transcript, "a1")).toEqual({
      kept: `${row("u1")}\n${row("a1", "assistant")}\n`,
      removed: `${[row("u2"), row("s1", "assistant", { isSidechain: true }), row("a2", "assistant")].join("\n")}\n`,
    });
  });

  it("leaves a transcript alone when nothing follows the message, or it is missing", () => {
    expect(transcriptRewoundTo(transcript, "a2")).toBeUndefined();
    expect(transcriptRewoundTo(`${transcript}\n${row("x", "system")}`, "a2")).toBeUndefined();
    expect(transcriptRewoundTo(transcript, "missing")).toBeUndefined();
  });
});

describe("makeTerminalSettings", () => {
  it("keeps the adapter's settings and points every hook at the loopback port", () => {
    const settings = makeTerminalSettings({ fastMode: true }, { port: 4123, token: "secret" });
    expect(settings.fastMode).toBe(true);
    expect(Object.keys(settings.hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "StopFailure",
      "PermissionRequest",
      "PreToolUse",
      "PreCompact",
      "PostCompact",
      "SubagentStart",
      "SubagentStop",
    ]);
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe("*");
    const permissionHook = settings.hooks.PermissionRequest?.[0]?.hooks[0];
    expect(permissionHook?.command).toBe(
      "curl -sS -X POST --data-binary @- http://127.0.0.1:4123/secret/permission",
    );
    expect(permissionHook?.timeout).toBeGreaterThan(60 * 60);
    expect(settings.hooks.StopFailure?.[0]?.hooks[0]?.command).toBe(
      "curl -sS -X POST --data-binary @- http://127.0.0.1:4123/secret/stop",
    );
  });

  it("runs hooks the base settings already carry beside its own", () => {
    const userHook = { hooks: [{ type: "command", command: "echo base" }] };
    const settings = makeTerminalSettings(
      { hooks: { Stop: [userHook], Notification: [userHook] } },
      { port: 4123, token: "secret" },
    );
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop?.[0]).toBe(userHook);
    expect(settings.hooks.Notification).toEqual([userHook]);
  });
});

describe("sdkMessageFromTranscriptEntry", () => {
  const assistant = {
    type: "assistant",
    uuid: "a1",
    requestId: "req_1",
    message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "alpha" }] },
  };

  it("passes assistant rows through as SDK assistant messages", () => {
    expect(sdkMessageFromTranscriptEntry(assistant, SESSION_ID)).toEqual({
      type: "assistant",
      message: assistant.message,
      parent_tool_use_id: null,
      uuid: "a1",
      session_id: SESSION_ID,
      request_id: "req_1",
    });
  });

  it("marks the reply Claude Code wrote for a failed API call, as the SDK does", () => {
    expect(
      sdkMessageFromTranscriptEntry(
        { ...assistant, isApiErrorMessage: true, error: "server_error", apiErrorStatus: 529 },
        SESSION_ID,
      ),
    ).toMatchObject({
      error: "server_error",
      is_api_error_message: true,
      api_error_status: 529,
    });
  });

  it("emits tool results but not the prompt the terminal echoes", () => {
    const toolResult = {
      type: "user",
      uuid: "u2",
      toolUseResult: { stdout: "ok" },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] },
    };
    expect(sdkMessageFromTranscriptEntry(toolResult, SESSION_ID)).toMatchObject({
      type: "user",
      tool_use_result: { stdout: "ok" },
    });
    const prompt = { type: "user", uuid: "u1", message: { role: "user", content: "hi" } };
    expect(sdkMessageFromTranscriptEntry(prompt, SESSION_ID)).toBeUndefined();
  });

  it("skips subagent sidechains and meta rows", () => {
    expect(sdkMessageFromTranscriptEntry({ ...assistant, isSidechain: true }, SESSION_ID)).toBe(
      undefined,
    );
    expect(sdkMessageFromTranscriptEntry({ ...assistant, isMeta: true }, SESSION_ID)).toBe(
      undefined,
    );
  });
});

describe("promptText", () => {
  it("joins text blocks and drops the rest", () => {
    expect(
      promptText({
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "" } },
            { type: "text", text: "second" },
          ],
        },
      }),
    ).toBe("first\n\nsecond");
  });
});

describe("terminal-only transcript rows", () => {
  it("reports compaction like the SDK, with snake_case metadata", () => {
    expect(
      sdkMessageFromTranscriptEntry(
        {
          type: "system",
          subtype: "compact_boundary",
          uuid: "c1",
          logicalParentUuid: "p1",
          compactMetadata: { trigger: "manual", preTokens: 65436, postTokens: 23801 },
        },
        SESSION_ID,
      ),
    ).toMatchObject({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 65436, post_tokens: 23801 },
      logical_parent_uuid: "p1",
    });
  });

  it("passes on notices Claude Code shows in the terminal", () => {
    const content =
      "Opus 5.5's safeguards stopped the response above · continuing once with that noted";
    expect(
      sdkMessageFromTranscriptEntry(
        { type: "system", subtype: "informational", uuid: "n1", content, level: "notice" },
        SESSION_ID,
      ),
    ).toMatchObject({ type: "system", subtype: "informational", content, level: "notice" });
  });

  it("reports a failed local command, which prints to stderr", () => {
    const output =
      "<local-command-stderr>Error: Not enough messages to compact.</local-command-stderr>";
    expect(
      sdkMessageFromTranscriptEntry(
        { type: "system", subtype: "local_command", uuid: "e1", content: output },
        SESSION_ID,
      ),
    ).toMatchObject({ type: "user", isReplay: true, message: { content: output } });
  });

  it("replays local command output and marks the compaction summary synthetic", () => {
    const output = "<local-command-stdout>Compacted</local-command-stdout>";
    expect(
      sdkMessageFromTranscriptEntry(
        { type: "system", subtype: "local_command", uuid: "l1", content: output },
        SESSION_ID,
      ),
    ).toMatchObject({ type: "user", isReplay: true, message: { content: output } });
    expect(
      sdkMessageFromTranscriptEntry(
        {
          type: "user",
          uuid: "s1",
          isCompactSummary: true,
          message: { role: "user", content: "Summary" },
        },
        SESSION_ID,
      ),
    ).toMatchObject({ type: "user", isSynthetic: true });
  });

  it("turns an API error row into an api_retry frame", () => {
    expect(
      sdkMessageFromTranscriptEntry(
        {
          type: "system",
          subtype: "api_error",
          uuid: "e1",
          error: { status: 529 },
          retryAttempt: 2,
          maxRetries: 10,
          retryInMs: 1200,
        },
        SESSION_ID,
      ),
    ).toMatchObject({
      subtype: "api_retry",
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 1200,
      error_status: 529,
      error: "overloaded",
    });
  });

  it("places a subagent's rows, its prompt included, under the Agent call", () => {
    const prompt = {
      type: "user",
      uuid: "u1",
      isSidechain: true,
      message: { role: "user", content: [{ type: "text", text: "go" }] },
    };
    expect(sdkMessageFromTranscriptEntry(prompt, SESSION_ID, "toolu_agent")).toMatchObject({
      type: "user",
      parent_tool_use_id: "toolu_agent",
    });
    expect(sdkMessageFromTranscriptEntry(prompt, SESSION_ID)).toBeUndefined();
  });

  it("reads the text of submitted prompts only", () => {
    const user = (content: unknown, extra: object = {}) => ({
      type: "user",
      uuid: "u",
      message: { role: "user", content },
      ...extra,
    });
    expect(submittedPromptText(user("hi"))).toBe("hi");
    expect(submittedPromptText(user([{ type: "tool_result", tool_use_id: "t" }]))).toBeUndefined();
    expect(submittedPromptText(user("x", { isMeta: true }))).toBeUndefined();
  });
});

describe("localCommandInvocation", () => {
  const row = (content: string, isMeta?: true) => ({
    type: "user",
    uuid: "row",
    ...(isMeta ? { isMeta } : {}),
    message: { role: "user", content },
  });

  const command = (name: string, args: string) =>
    row(
      [
        `<command-name>/${name}</command-name>`,
        `            <command-message>${name}</command-message>`,
        `            <command-args>${args}</command-args>`,
      ].join("\n"),
    );

  it("reads the command line a local command row records", () => {
    expect(localCommandInvocation(command("model", "opus[1m]"))).toBe("/model opus[1m]");
    expect(localCommandInvocation(command("compact", ""))).toBe("/compact");
  });

  it("reads the row of a command that waited in Claude's queue", () => {
    expect(
      localCommandInvocation({
        type: "system",
        subtype: "local_command",
        uuid: "row",
        content: [
          "<command-name>/model</command-name>",
          "            <command-message>model</command-message>",
          "            <command-args>claude-sonnet-5-5</command-args>",
        ].join("\n"),
      }),
    ).toBe("/model claude-sonnet-5-5");
    expect(
      localCommandInvocation({ type: "system", subtype: "turn_duration", uuid: "row" }),
    ).toBeUndefined();
  });

  it("ignores prompts and the caveat row", () => {
    expect(localCommandInvocation(row("Reply with exactly: one"))).toBeUndefined();
    expect(
      localCommandInvocation(row("<local-command-caveat>Caveat</local-command-caveat>", true)),
    ).toBeUndefined();
  });
});

describe("parseTaskNotification", () => {
  it("reads the fields of a finished task", () => {
    const prompt = [
      "<task-notification>",
      "<task-id>b6h2k5jdh</task-id>",
      "<tool-use-id>toolu_01</tool-use-id>",
      "<output-file>C:\\tmp\\b6h2k5jdh.output</output-file>",
      "<status>completed</status>",
      "<summary>Run sleep</summary>",
      "</task-notification>",
    ].join("\n");
    expect(parseTaskNotification(prompt)).toEqual({
      taskId: "b6h2k5jdh",
      toolUseId: "toolu_01",
      status: "completed",
      summary: "Run sleep",
      outputFile: "C:\\tmp\\b6h2k5jdh.output",
    });
    expect(parseTaskNotification("hello")).toBeUndefined();
  });

  it("reads a notification without a status as an event of a running task", () => {
    const prompt =
      "<task-notification><task-id>bjwk28ap2</task-id><summary>tick 3</summary></task-notification>";
    expect(parseTaskNotification(prompt)).toMatchObject({ taskId: "bjwk28ap2", status: "" });
  });
});

describe("rateLimitInfosFromHeaders", () => {
  it("reports each window the response names", () => {
    const infos = rateLimitInfosFromHeaders({
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.35",
      "anthropic-ratelimit-unified-5h-reset": "1792969800",
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-7d-utilization": "0.5",
      "anthropic-ratelimit-unified-7d-reset": "1793102400",
      "anthropic-ratelimit-unified-overage-status": "rejected",
    });
    expect(infos).toMatchObject([
      {
        rateLimitType: "five_hour",
        utilization: 0.35,
        resetsAt: 1792969800,
        status: "allowed",
        overageStatus: "rejected",
      },
      { rateLimitType: "seven_day", utilization: 0.5, resetsAt: 1793102400, status: "allowed" },
    ]);
    expect(rateLimitInfosFromHeaders({ "content-type": "text/event-stream" })).toEqual([]);
  });
});

describe("isMainConversationRequest", () => {
  const billing = "x-anthropic-billing-header: cc_version=2.1.310; cc_entrypoint=cli;";
  const claudeCode = "You are Claude Code, Anthropic's official CLI for Claude.";
  const request = (parts: string[], tools: unknown[] = [{ name: "Bash" }]) => ({
    system: parts.map((text) => ({ type: "text", text })),
    tools,
  });

  it("accepts the main conversation", () => {
    expect(isMainConversationRequest(request([billing, claudeCode]))).toBe(true);
  });

  it("skips subagents, tool-less side requests and hook checks", () => {
    expect(isMainConversationRequest(request([`${billing} cc_is_subagent=true`, claudeCode]))).toBe(
      false,
    );
    expect(isMainConversationRequest(request([billing, claudeCode], []))).toBe(false);
    expect(
      isMainConversationRequest({
        ...request([billing, claudeCode]),
        messages: [
          { role: "user", content: "[SUGGESTION MODE: Suggest what the user might type.]" },
        ],
      }),
    ).toBe(false);
    expect(
      isMainConversationRequest(
        request([billing, "You are a Claude agent, built on Anthropic's Claude Agent SDK."]),
      ),
    ).toBe(false);
  });
});

describe("parseServerSentEvents", () => {
  it("returns complete events and keeps the unfinished tail", () => {
    const first = parseServerSentEvents(
      'event: message_start\ndata: {"type":"message_start"}\n\n' +
        'event: ping\ndata: {"type":"ping"}\n\n' +
        'event: content_block_delta\ndata: {"type":"cont',
    );
    expect(first.events).toEqual([{ type: "message_start" }, { type: "ping" }]);
    const second = parseServerSentEvents(`${first.rest}ent_block_delta"}\n\n`);
    expect(second.events).toEqual([{ type: "content_block_delta" }]);
    expect(second.rest).toBe("");
  });
});

describe("API retries", () => {
  it("retries the statuses Claude Code retries", () => {
    expect([408, 409, 500, 529].every((status) => isRetryableApiStatus(status))).toBe(true);
    expect([200, 400, 401, 404].some((status) => isRetryableApiStatus(status))).toBe(false);
  });

  it("retries a 429 only when Retry-After is short", () => {
    expect(isRetryableApiStatus(429, "2")).toBe(true);
    expect(isRetryableApiStatus(429, "60")).toBe(true);
    // A usage limit asks for minutes or hours, and Claude Code shows it instead of retrying.
    expect(isRetryableApiStatus(429, "3600")).toBe(false);
    expect(isRetryableApiStatus(429, undefined)).toBe(false);
    expect(isRetryableApiStatus(429, "soon")).toBe(false);
    expect(isRetryableApiStatus(429, "-1")).toBe(false);
  });

  it("waits Retry-After, else a doubling capped at 32 s", () => {
    expect(apiRetryDelayMs(1, "3")).toBe(3000);
    expect([1, 2, 3].map((attempt) => apiRetryDelayMs(attempt, undefined))).toEqual([
      500, 1000, 2000,
    ]);
    expect(apiRetryDelayMs(10, undefined)).toBe(32_000);
    expect(apiRetryDelayMs(2, "soon")).toBe(1000);
  });

  it("reads the retry budget from CLAUDE_CODE_MAX_RETRIES", () => {
    expect(maxApiRetries(undefined)).toBe(10);
    expect(maxApiRetries("2")).toBe(2);
    expect(maxApiRetries("many")).toBe(10);
  });

  it("names the error as the SDK does", () => {
    expect(apiRetryError(529)).toBe("overloaded");
    expect(apiRetryError(429)).toBe("rate_limit");
    expect(apiRetryError(503)).toBe("server_error");
  });
});
