// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
/**
 * Runs a Claude session in the terminal UI behind the SDK's `Query` shape: Agent SDK
 * turns cost ~1.8x more of the 5-hour window than `cli` ones (anthropics/claude-code#97074).
 * Prompts are pasted, hooks report turns and approvals, replies come from the transcript.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";

import type {
  CanUseTool,
  Options as ClaudeQueryOptions,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKResultSuccess,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import type { PtyProcess, PtySpawnInput } from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";

import {
  DEFAULT_ANTHROPIC_BASE_URL,
  startClaudeTerminalApiTap,
  type ClaudeTerminalApiTap,
} from "./ClaudeTerminalApiTap.ts";
import {
  apiRetryDelayMs,
  apiRetryError,
  contentBlocks,
  isRetryableApiStatus,
  localCommandInvocation,
  localCommandOutput,
  makeTerminalArgs,
  makeTerminalSettings,
  maxApiRetries,
  inputPastes,
  normalizePromptText,
  parseTaskNotification,
  permissionModeShown,
  promptMatchKey,
  promptText,
  sdkMessageFromTranscriptEntry,
  startupDialogKey,
  stripTerminalEscapes,
  submittedPromptText,
  terminalInputText,
  transcriptRewoundTo,
  type ClaudeTranscriptEntry,
  type HookInput,
  type HookKind,
  type TaskNotification,
} from "./ClaudeTerminalMessages.ts";

const TERMINAL_COLS = 160;
const TERMINAL_ROWS = 48;
const POLL_INTERVAL_MS = 100;
const STARTUP_TIMEOUT_MS = 90_000;
const SUBMIT_TIMEOUT_MS = 10_000;
/** How long a busy terminal may take to report a prompt before T3 gives up on it. */
const SUBMIT_GIVE_UP_MS = 120_000;
/** How much of a prompt is looked for on screen to tell whether it still sits in the input box. */
const PROMPT_ECHO_CHARACTERS = 30;
/** Added to the wait per character of the prompt. */
const SUBMIT_GIVE_UP_MS_PER_CHARACTER = 5;
/** How much longer a terminal that still shows activity is given. */
const SUBMIT_BUSY_GRACE_MS = 300_000;
/** Pause between the pastes one long prompt is typed in. */
/** Pastes sent per write to the terminal. */
const PASTES_PER_WRITE = 25;
/** Pause after a prompt typed during a turn, before the next one is typed. */
const STEER_SUBMIT_GAP_MS = 150;
/** How long typing waits for the terminal to stop redrawing before it types anyway. */
const INPUT_SETTLE_TIMEOUT_MS = 60_000;
const QUIET_OUTPUT_MS = 800;
/** Stop hooks of the user's own can keep a turn going; its end is the transcript's turn_duration row. */
const TURN_END_FALLBACK_MS = 120_000;
/** How long a turn's closing row may wait for its Stop hook. */
const STOP_HOOK_GRACE_MS = 5_000;
/** Transcript timestamps and this clock may disagree by this much. */
const CLOCK_SKEW_MS = 200;
/** A slash command that neither prompts nor prints, such as one that opens a menu. */
const COMMAND_SETTLE_MS = 3_000;
/** The SDK reports a foreground shell as a task once it outlives this. */
const LONG_SHELL_MS = 2_000;
const TOOL_HEARTBEAT_MS = 30_000;
/** Esc presses an interrupt may take before Claude is left to finish its turn. */
const MAX_ESCAPE_PRESSES = 3;
/** How long an Esc may take to show in the transcript. */
const ESCAPE_CONFIRM_MS = 1_500;
/** No model progress for this long after the Esc presses means the turn is stopped. */
const ESCAPE_STALL_MS = 3_000;
/** How long prompts queued behind an interrupted turn may take to start. */
const QUEUE_RESUME_MS = 2_500;
/** How long the Stop hook and closing row of a turn ended early may take to arrive. */
const LATE_END_WINDOW_MS = 10_000;
/** How long a hook waits for the transcript to show a reply the API stream already ended. */
const REPLY_ROW_WAIT_MS = 2_500;
/** The transcript row Claude Code writes when Esc stopped a turn. */
const INTERRUPT_MARKER = "[Request interrupted by user";
const WORK_DIR_REMOVE_RETRIES = 10;
const WORK_DIR_REMOVE_RETRY_MS = 1_000;
/** Failed transcript reads in a row (about two seconds of ticks) before the session fails. */
const PUMP_FAILURE_GRACE_MS = 2_000;
/** How long a prompt typed into Claude's queue may wait with no turn running before it is given up on. */
const STRANDED_PROMPT_MS = 120_000;
/** How long an interrupt waits for the turn of a prompt just typed. */
const PROMPT_TURN_WAIT_MS = 5_000;
/** How long an interrupt waits for a prompt in the middle of being typed. */
const INTERRUPT_TYPING_WAIT_MS = 3_000;

/**
 * Variables a parent Claude session exports to its children. An inherited
 * CLAUDE_CODE_ENTRYPOINT wins over the CLI's own `cli`, and
 * CLAUDE_CODE_CHILD_SESSION turns transcript saving off.
 */
const PARENT_SESSION_ENV_KEYS = new Set([
  "CLAUDECODE",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
]);

/**
 * Commands whose result T3 keeps track of. Without arguments the terminal
 * would open a picker nobody sees, so those print the current value instead.
 */
const SESSION_SETTING_COMMANDS = new Set(["model", "effort"]);
/** How long a settings command may take to print its result. */
const LOCAL_COMMAND_TIMEOUT_MS = 15_000;
/** Shift+Tab presses before a permission mode counts as out of reach. */
const MAX_MODE_PRESSES = 8;
/** How long the footer may take to show the mode a press selected. */
const MODE_REDRAW_TIMEOUT_MS = 1_500;
/** How long keys wait after an approval closed, for its dialog to leave the screen. */
const APPROVAL_SETTLE_MS = 500;
/** How long after a dialog is drawn keys wait for its approval hook to arrive. */
const DIALOG_HOOK_WAIT_MS = 600;
/** How much of a task's name is looked for in the terminal's task list, which cuts long names. */
const TASK_LABEL_MATCH_CHARS = 40;
/** The modes Shift+Tab cycles through in every session. */
const CYCLED_PERMISSION_MODES = new Set<PermissionMode>(["default", "acceptEdits", "plan", "auto"]);

type FlagSettings = Record<string, unknown>;

/** The part of the SDK's `Query` that ClaudeAdapterV2 drives. */
export interface ClaudeTerminalQueryRuntime extends AsyncIterableIterator<SDKMessage, void> {
  readonly interrupt: () => Promise<void>;
  readonly close: () => void;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly applyFlagSettings: (settings: FlagSettings) => Promise<void>;
  readonly setMcpServers: (servers: Record<string, unknown>) => Promise<{
    readonly added: string[];
    readonly removed: string[];
    readonly errors: Record<string, string>;
  }>;
  readonly stopTask: (taskId: string) => Promise<void>;
  readonly backgroundTasks: (toolUseId: string) => Promise<boolean>;
}

interface PendingPrompt {
  readonly uuid: string;
  readonly text: string;
  readonly command: string | undefined;
  typedAt: number;
}

/** A settings command T3 typed itself. */
interface LocalCommand {
  readonly text: string;
  /** Whether its own row arrived; output before that belongs to an earlier command. */
  seen: boolean;
  output: string | undefined;
}

interface Turn {
  readonly startedAt: number;
  readonly echo: string[];
  origin: Record<string, unknown> | undefined;
  /** A slash command that runs without a model call, such as /compact. */
  readonly command: boolean;
  readonly usage: Map<string, Record<string, unknown>>;
  /** The latest assistant row closed the reply (not a tool call); a prompt after it starts the next turn. */
  replyEnded: boolean;
  replyText: string;
  /** Ids of messages whose stream ended with a closing stop reason; their rows may not be in the file yet. */
  readonly streamEnded: Set<string>;
  /** Ids of the messages the transcript has shown rows of. */
  readonly rowMessages: Set<string>;
  /** The message the API stream is delivering. */
  streamingId: string | undefined;
  /** The reply is the error Claude Code wrote for a failed API call, such as a refusal. */
  apiError: { readonly stopReason: string | null; readonly status: number | null } | undefined;
  stopSeenAt: number;
  /** When the transcript closed the turn before its Stop or StopFailure hook arrived; 0 if not. */
  durationRowSeen: number;
  /** API responses in a row that Claude Code retries; a successful one resets it. */
  apiFailures: number;
  /** Tool calls denied during the turn, as the SDK lists them in its result. */
  readonly denials: Array<Record<string, unknown>>;
}

interface RunningTool {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly startedAt: number;
  heartbeats: number;
  /** The subagent that called the tool; its results land in the subagent's transcript. */
  readonly agentId: string | undefined;
  /** Set once a long shell is reported as a task. */
  taskId?: string;
  approvalRequested?: boolean;
}

interface Subagent {
  readonly agentId: string;
  readonly toolUseId: string;
  readonly description: string;
  readonly subagentType: string;
  readonly startedAt: number;
  readonly transcript: TranscriptReader;
  backgrounded: boolean;
  toolUses: number;
  totalTokens: number;
  lastToolName: string | undefined;
}

interface BackgroundTask {
  readonly taskId: string;
  readonly taskType: "local_bash" | "local_agent";
  readonly description: string;
  readonly toolUseId: string | undefined;
  /** How the terminal's task list names it: a shell's command, an agent's description. */
  readonly label: string;
}

/** Reads the rows a JSONL transcript gained since the last read. */
class TranscriptReader {
  readonly path: string;
  #offset = 0;
  #remainder = "";
  /** Holds the bytes of a character a read split until the next read completes it. */
  readonly #decoder = new NodeStringDecoder.StringDecoder("utf8");

  constructor(path: string, startAtEnd: boolean) {
    this.path = path;
    if (startAtEnd) this.#offset = NodeFS.statSync(path, { throwIfNoEntry: false })?.size ?? 0;
  }

  read(): ClaudeTranscriptEntry[] {
    if (!this.path) return [];
    // Claude Code creates the file with the first row; until then there is nothing to read.
    const size = NodeFS.statSync(this.path, { throwIfNoEntry: false })?.size ?? 0;
    // A file that shrank was rewritten: read it again from the start.
    if (size < this.#offset) {
      this.#offset = 0;
      this.#remainder = "";
      this.#decoder.end();
    }
    if (size <= this.#offset) return [];
    const length = size - this.#offset;
    const buffer = Buffer.alloc(length);
    let bytesRead: number;
    const fd = NodeFS.openSync(this.path, "r");
    try {
      bytesRead = NodeFS.readSync(fd, buffer, 0, length, this.#offset);
    } finally {
      NodeFS.closeSync(fd);
    }
    // A short read leaves the rest for the next one.
    this.#offset += bytesRead;
    const lines = (this.#remainder + this.#decoder.write(buffer.subarray(0, bytesRead))).split(
      "\n",
    );
    this.#remainder = lines.pop() ?? "";
    return lines.flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line) as ClaudeTranscriptEntry];
      } catch {
        return [];
      }
    });
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function slashCommandName(text: string): string | undefined {
  return /^\/([\w:.-]+)/.exec(text.trimStart())?.[1];
}

class ClaudeTerminalQuery implements ClaudeTerminalQueryRuntime {
  readonly #options: ClaudeQueryOptions;
  readonly #spawn: (input: PtySpawnInput) => Promise<PtyProcess>;
  readonly #abort = new AbortController();
  readonly #token = NodeCrypto.randomUUID();
  readonly #workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-terminal-"));
  readonly #imagesDir = NodePath.join(this.#workDir, "images");

  #hookServer: NodeHttp.Server | undefined;
  #hookPort = 0;
  #tap: ClaudeTerminalApiTap | undefined;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  // The terminal process; a restart replaces it on the same session.
  #process: PtyProcess | undefined;
  #exitCode: number | undefined;
  #screen = "";
  /** Characters received in total; #screen keeps only the tail. */
  #screenTotal = 0;
  #lastOutputAt = 0;
  #sessionStart: HookInput | undefined;
  #restartPending = false;

  #sessionId = "";
  #model: string | undefined;
  #permissionMode: PermissionMode;
  #transcript: TranscriptReader | undefined;

  readonly #pending: PendingPrompt[] = [];
  #turn: Turn | undefined;
  #turnEndedAt = 0;
  /** When the last Stop hook arrived; 0 once Claude is busy again. */
  #stoppedAt = 0;
  /** Stop hooks and closing rows still due from a turn the next prompt's row ended first. */
  #lateEnd = { stops: 0, durations: 0, until: 0 };
  #promptIterator: AsyncIterator<SDKUserMessage> | undefined;
  #command: { readonly prompt: PendingPrompt; readonly done: () => void } | undefined;
  #localCommand: LocalCommand | undefined;
  /** Texts being typed right now; a key written between their pastes would land in the text. */
  #typing = 0;
  #interrupting: Promise<void> | undefined;
  /** Prompts the terminal queued behind an interrupted turn are being sorted out. */
  #recovering: Promise<void> | undefined;
  /** When the model last showed progress: a stream event or a transcript row. */
  #activityAt = 0;
  /** Assistant rows that arrived while an interrupt was under way; dropped if it cancels the turn. */
  #bufferedDuringInterrupt: ClaudeTranscriptEntry[] = [];
  #replayingBuffered = false;
  /** What each prompt was typed as, to erase it if an interrupt hands it back to the input box. */
  readonly #promptTexts = new Map<string, string>();
  /** Prompts taken in while an interrupt was under way, waiting for its row. */
  readonly #heldByInterrupt: PendingPrompt[] = [];
  /** A compaction started and has not reported its end yet. */
  #compacting = false;
  /** Approvals Claude waits on; keys typed meanwhile could answer its dialog. */
  #openApprovals = 0;
  readonly #approvalAborts = new Set<AbortController>();
  /** When the last approval closed; Claude's dialog may stay drawn a moment longer. */
  #approvalClosedAt = 0;
  /** When a choice dialog ("1. Yes") was last drawn; its hook arrives within a moment. */
  #dialogDrawnAt = 0;
  readonly #runningTools = new Map<string, RunningTool>();
  readonly #agentLaunches: Array<{
    readonly toolUseId: string;
    readonly input: Record<string, unknown>;
  }> = [];
  readonly #subagents = new Map<string, Subagent>();
  readonly #backgroundTasks = new Map<string, BackgroundTask>();
  readonly #notifiedTaskIds = new Set<string>();
  #lastRateLimits = "";
  /**
   * Set when an interrupt cancelled a turn: the rows of the cut reply reach the
   * transcript afterwards and must not become the next prompt's reply.
   */
  #discardingCutReply = false;
  /** When the cut happened; the cut reply's rows are dated before it. */
  #cutAt = 0;
  /** After a cancelled turn, approvals are denied until the next turn begins. */
  #denyUntilNextTurn = false;
  /** Rows seen that record an interrupt; an Esc is confirmed by a new one. */
  #interruptMarks = 0;
  /** Transcript reads in a row that failed. */
  #pumpFailingSince = 0;

  // Outgoing SDK messages, delivered through the async iterator.
  readonly #outbox: SDKMessage[] = [];
  #outboxWaiter: (() => void) | undefined;
  #failure: Error | undefined;

  // Serializes typing and restarts.
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    input: { readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: ClaudeQueryOptions },
    spawn: (input: PtySpawnInput) => Promise<PtyProcess>,
  ) {
    this.#options = { ...input.options };
    this.#spawn = spawn;
    this.#permissionMode = input.options.permissionMode ?? "default";
    this.#model = input.options.model;
    void this.#run(input.prompt).catch((error: unknown) => this.#fail(error));
  }

  async #run(prompt: AsyncIterable<SDKUserMessage>) {
    this.#hookPort = await this.#startHookServer();
    const env = this.#options.env ?? process.env;
    const tap = await startClaudeTerminalApiTap(
      env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL,
      {
        onMainRequest: () => this.#onMainRequest(),
        onMainResponse: (status, headers) => this.#onMainResponse(status, headers),
        onStreamEvent: (event) => this.#onStreamEvent(event),
        onRateLimits: (infos) => this.#onRateLimits(infos),
      },
    );
    // close() ran while the tap started; it had nothing to close yet.
    if (this.#closed) {
      tap.close();
      return;
    }
    this.#tap = tap;
    this.#rewindTranscript();
    await this.#launch(undefined);
    this.#pollTimer = setInterval(() => this.#tick(), POLL_INTERVAL_MS);
    const iterator = prompt[Symbol.asyncIterator]();
    this.#promptIterator = iterator;
    // close() ran while the terminal launched; it had no iterator to end yet.
    if (this.#closed) return this.#endPromptIterator();
    for (;;) {
      const next = await iterator.next();
      if (next.done || this.#closed) return;
      this.#offer(next.value);
    }
  }

  /** Ends the prompt source so it stops waiting for a consumer that is gone. */
  #endPromptIterator() {
    const iterator = this.#promptIterator;
    this.#promptIterator = undefined;
    try {
      void Promise.resolve(iterator?.return?.()).catch(() => undefined);
    } catch {
      // A source that throws on return has nothing left to release.
    }
  }

  // ── Process ────────────────────────────────────────────────────────────

  /**
   * The interactive CLI ignores `--resume-session-at`, so a resume after a
   * rollback would bring back the turns T3 dropped. The transcript is cut at
   * that message instead; the cut rows are kept in a file beside it.
   */
  #rewindTranscript() {
    const sessionId = this.#options.resume;
    const at = this.#options.resumeSessionAt;
    if (!sessionId || !at) return;
    const env = this.#options.env ?? process.env;
    const projects = NodePath.join(
      env.CLAUDE_CONFIG_DIR ?? NodePath.join(NodeOS.homedir(), ".claude"),
      "projects",
    );
    const directories = NodeFS.existsSync(projects)
      ? NodeFS.readdirSync(projects, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      : [];
    for (const directory of directories) {
      const path = NodePath.join(projects, directory.name, `${sessionId}.jsonl`);
      if (!NodeFS.existsSync(path)) continue;
      const split = transcriptRewoundTo(NodeFS.readFileSync(path, "utf8"), at);
      if (!split) return;
      NodeFS.writeFileSync(`${path}.rewound-${Date.now()}`, split.removed);
      // A crash mid-write must not leave Claude a half transcript.
      NodeFS.writeFileSync(`${path}.t3-tmp`, split.kept);
      NodeFS.renameSync(`${path}.t3-tmp`, path);
      return;
    }
  }

  /** Settings given as an object, inline JSON, or the path of a JSON file. */
  #readSettings(value: unknown): Record<string, unknown> {
    if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
    if (typeof value !== "string" || !value.trim()) return {};
    try {
      const text = value.trim().startsWith("{") ? value : NodeFS.readFileSync(value, "utf8");
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  async #launch(resumeSessionId: string | undefined) {
    // Pasted images are saved here and mentioned in the prompt; Claude may read the folder.
    NodeFS.mkdirSync(this.#imagesDir, { recursive: true });
    const settingsPath = NodePath.join(this.#workDir, "settings.json");
    NodeFS.writeFileSync(
      settingsPath,
      JSON.stringify(
        makeTerminalSettings(
          // Launch-argument settings first; the SDK lets the adapter's own override them.
          {
            ...this.#readSettings(this.#options.extraArgs?.settings),
            ...this.#readSettings(this.#options.settings),
          },
          { port: this.#hookPort, token: this.#token },
        ),
      ),
    );
    // MCP servers can carry credentials; a private file keeps them out of argv.
    const mcpServers = this.#options.mcpServers ?? {};
    const mcpConfigPath =
      Object.keys(mcpServers).length === 0 ? undefined : NodePath.join(this.#workDir, "mcp.json");
    if (mcpConfigPath) {
      NodeFS.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
    }

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.#options.env ?? process.env)) {
      if (value !== undefined && !PARENT_SESSION_ENV_KEYS.has(key)) env[key] = value;
    }
    if (this.#tap) env.ANTHROPIC_BASE_URL = this.#tap.url;

    this.#sessionStart = undefined;
    this.#stoppedAt = 0;
    this.#exitCode = undefined;
    this.#screen = "";
    const child = await this.#spawn({
      shell: this.#options.pathToClaudeCodeExecutable ?? "claude",
      args: makeTerminalArgs(
        {
          ...this.#options,
          additionalDirectories: [...(this.#options.additionalDirectories ?? []), this.#imagesDir],
        },
        { settingsPath, mcpConfigPath, resumeSessionId },
      ),
      cwd: this.#options.cwd ?? process.cwd(),
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
      env,
    });
    // close() ran during the spawn and killed nothing; this process is left to end.
    if (this.#closed) {
      child.kill();
      throw new Error("Claude terminal session closed.");
    }
    this.#process = child;
    child.onData((data) => {
      if (this.#process !== child) return;
      this.#screen = (this.#screen + data).slice(-16_000);
      this.#screenTotal += data.length;
      this.#lastOutputAt = Date.now();
      // A permission dialog is drawn before its hook reaches T3; keys must not meet it.
      if (
        data.includes("Yes") &&
        stripTerminalEscapes(data).replace(/\s/g, "").includes("❯1.Yes")
      ) {
        this.#dialogDrawnAt = this.#lastOutputAt;
      }
    });
    child.onExit(({ exitCode }) => {
      if (this.#process !== child) return;
      this.#exitCode = exitCode;
      if (!this.#closed) this.#fail(new Error(`Claude exited with code ${exitCode}.`));
    });
    await this.#waitForStartup();
  }

  async #waitForStartup() {
    let lastKeyAt = 0;
    const started = await this.#waitFor("Claude to start", STARTUP_TIMEOUT_MS, () => {
      const now = Date.now();
      // Answer a dialog only once it has finished drawing.
      if (now - lastKeyAt > 1_000 && now - this.#lastOutputAt > 400) {
        const key = startupDialogKey(this.#screen.slice(-4_000));
        if (key) {
          lastKeyAt = now;
          this.#process?.write(key === "down" ? "\x1b[B" : "\r");
        }
      }
      return this.#sessionStart;
    });
    this.#sessionId = started.session_id ?? this.#sessionId;
    this.#model = started.model ?? this.#model;
    const transcriptPath = started.transcript_path ?? "";
    // A resumed session already has history; only what follows is new.
    if (this.#transcript?.path !== transcriptPath) {
      this.#transcript = new TranscriptReader(transcriptPath, true);
    }
    await this.#waitForQuietOutput();
  }

  /** Starts the process again on the same session, so changed flags take effect. */
  async #restart() {
    this.#restartPending = false;
    this.#discardingCutReply = false;
    this.#lateEnd = { stops: 0, durations: 0, until: 0 };
    // Nothing of the old process survives: its tools, subagents and typed prompts end with it.
    this.#runningTools.clear();
    this.#agentLaunches.length = 0;
    this.#subagents.clear();
    for (const prompt of this.#pending.filter((candidate) => candidate.typedAt > 0)) {
      this.#pending.splice(this.#pending.indexOf(prompt), 1);
      this.#cancelPrompt(prompt.uuid);
    }
    const previous = this.#process;
    this.#process = undefined;
    if (previous && this.#exitCode === undefined) {
      const exited = new Promise<void>((resolve) => previous.onExit(() => resolve()));
      previous.kill();
      await Promise.race([exited, sleep(5_000)]);
    }
    await this.#launch(this.#sessionId);
  }

  /** Background work runs inside the process, so a restart would end it. */
  #assertCanRestart(change: string) {
    if (this.#backgroundTasks.size === 0) return;
    throw new Error(
      `Claude is running background tasks; ${change} applies once they finish or are stopped.`,
    );
  }

  #markRestart() {
    this.#restartPending = true;
  }

  // ── Hooks ──────────────────────────────────────────────────────────────

  #startHookServer() {
    const server = NodeHttp.createServer((request, response) => {
      const [, token, kind] = (request.url ?? "").split("/");
      if (token !== this.#token) {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      // Claude drops a hook it no longer waits for, such as an approval an interrupt ended.
      const dropped = new AbortController();
      response.on("close", () => {
        if (!response.writableFinished) dropped.abort();
      });
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        let input: HookInput;
        try {
          input = JSON.parse(body || "{}") as HookInput;
        } catch {
          response.writeHead(400).end();
          return;
        }
        void this.#handleHook(kind as HookKind, input, dropped.signal).then(
          (output) => response.writeHead(200).end(output),
          (error: unknown) => response.writeHead(500).end(String(error)),
        );
      });
    });
    this.#hookServer = server;
    return new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
  }

  /** Waits, bounded, until the transcript shows every reply message the API stream has ended. */
  async #waitForReplyRow() {
    const deadline = Date.now() + REPLY_ROW_WAIT_MS;
    for (;;) {
      const turn = this.#turn;
      const missing =
        turn !== undefined &&
        !turn.command &&
        [...turn.streamEnded].some((id) => !turn.rowMessages.has(id));
      if (!missing || this.#closed || Date.now() >= deadline) return;
      await sleep(25);
      try {
        this.#pumpTranscripts();
      } catch (error) {
        this.#fail(error);
        return;
      }
    }
  }

  /** Returns the hook's stdout. Stdout of most hooks becomes context, so they stay empty. */
  async #handleHook(kind: HookKind, input: HookInput, dropped: AbortSignal): Promise<string> {
    if (this.#closed) return "";
    // Rows written before the hook belong before whatever it reports. A failure
    // here must not turn the hook into a 500, which leaves an approval dialog nobody answers.
    try {
      this.#pumpTranscripts();
    } catch (error) {
      this.#fail(error);
      return "";
    }
    // Stop and the next prompt's hook can reach us before the file holds the last assistant row; a
    // turn closed on them would send its result ahead of the reply.
    if (kind === "stop" || kind === "prompt-submit") await this.#waitForReplyRow();
    if (this.#closed) return "";
    this.#notePermissionMode(input.permission_mode);
    switch (kind) {
      case "session-start":
        this.#onSessionStarted(input);
        return "";
      case "prompt-submit":
        this.#stoppedAt = 0;
        this.#onPromptSubmitted(input.prompt ?? "");
        return "";
      case "stop": {
        this.#stoppedAt = Date.now();
        if (this.#lateEnd.stops > 0 && Date.now() < this.#lateEnd.until) {
          this.#lateEnd.stops--;
          return "";
        }
        const turn = this.#turn;
        if (!turn) return "";
        turn.stopSeenAt = Date.now();
        // The turn's closing row can land before a StopFailure reports it.
        if (turn.durationRowSeen > 0 && !turn.command) this.#finishTurn(turn, "completed");
        return "";
      }
      case "pre-tool-use":
        // Main-thread work after a Stop, such as a user Stop hook that asked Claude to go on.
        if (this.#turn && !input.agent_id) this.#turn.stopSeenAt = 0;
        if (!input.agent_id) this.#stoppedAt = 0;
        this.#onToolStarted(input);
        return "";
      case "pre-compact":
        this.#onCompactStarted();
        return "";
      case "post-compact":
        this.#compacting = false;
        // /compact normally ends on its output line; if none comes, #checkTurnEnd closes the turn.
        if (this.#turn?.command) this.#turn.durationRowSeen = Date.now();
        this.#emitSystem({ subtype: "status", status: null, compact_result: "success" });
        return "";
      case "subagent-start":
        this.#onSubagentStarted(input);
        return "";
      case "subagent-stop":
        this.#onSubagentStopped(input);
        return "";
      case "permission": {
        // A turn Esc stopped may still ask for one more tool; the answer ends it for good.
        if (this.#interrupting !== undefined || (this.#denyUntilNextTurn && !this.#turn)) {
          return JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: {
                behavior: "deny",
                message: "The turn was interrupted.",
                interrupt: true,
              },
            },
          });
        }
        this.#openApprovals++;
        // Its own abort, so an interrupt can end this approval alone, even for a handler that ignores the signal.
        const own = new AbortController();
        this.#approvalAborts.add(own);
        const signal = AbortSignal.any([dropped, own.signal]);
        const ended = new Promise<PermissionResult>((resolve) =>
          signal.addEventListener(
            "abort",
            // interrupt: true makes Claude stop the turn rather than try another tool.
            () =>
              resolve({
                behavior: "deny",
                message: "The approval was interrupted.",
                interrupt: true,
              }),
            { once: true },
          ),
        );
        let decision: PermissionResult;
        try {
          const deciding = this.#decidePermission(input, signal);
          deciding.catch(() => undefined);
          decision = await Promise.race([deciding, ended]);
        } catch (error) {
          // A failed hook would leave Claude on a terminal dialog nobody answers.
          decision = {
            behavior: "deny",
            message: error instanceof Error ? error.message : String(error),
          };
        } finally {
          this.#approvalAborts.delete(own);
          this.#openApprovals--;
          this.#approvalClosedAt = Date.now();
        }
        this.#noteDecision(input, decision);
        return JSON.stringify({
          hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
        });
      }
    }
  }

  /** An interrupt answers every open approval with a denial; Claude drops the dialogs with the turn. */
  #abortApprovals() {
    for (const approval of this.#approvalAborts) approval.abort();
  }

  /** What a decision changes at once: denials go in the turn's result, a mode change is noted now. */
  #noteDecision(input: HookInput, decision: PermissionResult) {
    if (decision.behavior === "deny") {
      this.#turn?.denials.push({
        tool_name: input.tool_name ?? "",
        tool_use_id: input.tool_use_id ?? "",
        tool_input: input.tool_input ?? {},
      });
      return;
    }
    for (const update of decision.updatedPermissions ?? []) {
      if (update.type === "setMode") this.#notePermissionMode(update.mode);
    }
  }

  /** The first SessionStart of a launch, or a new session such as one `/clear` began. */
  #onSessionStarted(input: HookInput) {
    if (!this.#sessionStart) {
      this.#sessionStart = input;
      return;
    }
    if (!input.session_id || input.session_id === this.#sessionId) return;
    this.#sessionId = input.session_id;
    if (input.transcript_path)
      this.#transcript = new TranscriptReader(input.transcript_path, false);
  }

  #notePermissionMode(mode: string | undefined) {
    if (!mode || mode === this.#permissionMode) return;
    this.#permissionMode = mode as PermissionMode;
    // A restart relaunches in the mode Claude is in now, such as after an approved plan.
    this.#options.permissionMode = mode as PermissionMode;
    this.#emitSystem({ subtype: "status", status: null, permissionMode: mode });
  }

  async #decidePermission(input: HookInput, dropped: AbortSignal): Promise<PermissionResult> {
    const canUseTool: CanUseTool | undefined = this.#options.canUseTool;
    if (!canUseTool) return { behavior: "deny", message: "No approval handler." };
    const toolName = input.tool_name ?? "";
    const toolInput = input.tool_input ?? {};
    const suggestions = Array.isArray(input.permission_suggestions)
      ? (input.permission_suggestions as Parameters<CanUseTool>[2]["suggestions"])
      : undefined;
    const toolUseId = input.tool_use_id ?? this.#toolUseIdForApproval(toolName, toolInput);
    const result = await canUseTool(toolName, toolInput, {
      signal: AbortSignal.any([this.#abort.signal, dropped]),
      toolUseID: toolUseId,
      // Answers return through this hook's HTTP response, never a control envelope.
      requestId: toolUseId,
      ...(input.agent_id ? { agentID: input.agent_id } : {}),
      ...(suggestions ? { suggestions } : {}),
    });
    return result ?? { behavior: "deny", message: "The approval was dismissed." };
  }

  /**
   * PermissionRequest payloads carry no tool_use_id; the call they ask about is
   * the latest PreToolUse of the same tool and input still waiting on one.
   */
  #toolUseIdForApproval(toolName: string, toolInput: Record<string, unknown>): string {
    const inputKey = JSON.stringify(toolInput);
    const candidates = [...this.#runningTools].filter(
      ([, tool]) => tool.name === toolName && !tool.approvalRequested,
    );
    const match =
      candidates.findLast(([, tool]) => JSON.stringify(tool.input) === inputKey) ??
      candidates.at(-1);
    if (!match) return NodeCrypto.randomUUID();
    match[1].approvalRequested = true;
    return match[0];
  }

  // ── Prompts and turns ──────────────────────────────────────────────────

  #offer(message: SDKUserMessage) {
    const uuid = message.uuid ?? NodeCrypto.randomUUID();
    this.#emitLifecycle(uuid, "queued");
    let text: string;
    try {
      text = this.#withImageMentions(promptText(message), message, uuid);
    } catch {
      // An image that cannot be saved fails this prompt alone, not the session.
      this.#cancelPrompt(uuid);
      return;
    }
    const pending: PendingPrompt = {
      uuid,
      text: normalizePromptText(text),
      command: slashCommandName(text),
      typedAt: 0,
    };
    this.#promptTexts.set(uuid, pending.text);
    // The input box ignores Enter on an empty text (the SDK sends it to the model), so
    // such a prompt ends at once instead of waiting for a submission that never comes.
    if (!pending.text) {
      this.#cancelPrompt(uuid);
      return;
    }
    this.#pending.push(pending);
    void this.#enqueue(() => this.#deliver(pending)).catch((error: unknown) => this.#fail(error));
  }

  /**
   * Pasted images reach the terminal as `@path` mentions, which Claude Code
   * attaches as image blocks the way the SDK sends them.
   */
  #withImageMentions(text: string, message: SDKUserMessage, uuid: string): string {
    const images = contentBlocks(message.message.content).flatMap((block) => {
      const source = block.source as
        | { readonly type?: string; readonly media_type?: string; readonly data?: string }
        | undefined;
      return block.type === "image" && source?.type === "base64" && source.data ? [source] : [];
    });
    if (images.length === 0) return text;
    const mentions = images.map((image, index) => {
      const extension = (image.media_type ?? "image/png").split("/")[1] ?? "png";
      const path = NodePath.join(this.#imagesDir, `${uuid}-${index}.${extension}`);
      NodeFS.writeFileSync(path, Buffer.from(image.data ?? "", "base64"));
      const mention = path.replaceAll("\\", "/");
      return mention.includes(" ") ? `@"${mention}"` : `@${mention}`;
    });
    return [text, mentions.join(" ")].filter(Boolean).join("\n\n");
  }

  async #deliver(pending: PendingPrompt) {
    // An interrupt cancels prompts still waiting their turn.
    if (this.#closed || !this.#pending.includes(pending)) return;
    const command = pending.command;
    if (command && SESSION_SETTING_COMMANDS.has(command)) {
      // It stays cancellable by an interrupt until Claude is free to run it.
      await this.#waitForIdle();
      if (!this.#pending.includes(pending)) return;
      this.#pending.splice(this.#pending.indexOf(pending), 1);
      await this.#runSessionSettingCommand(pending.uuid, command, pending.text);
      return;
    }
    // Background tasks that started since the setting changed would end with the restart.
    if (this.#restartPending && !this.#turn && this.#backgroundTasks.size === 0) {
      await this.#restart();
      // An interrupt during the restart cancelled the prompt; a command waiting for it would never end.
      if (!this.#pending.includes(pending)) return;
    }

    if (command) {
      await new Promise<void>((resolve) => {
        this.#command = { prompt: pending, done: resolve };
        void this.#typePrompt(pending).catch((error: unknown) => this.#fail(error));
      });
      return;
    }
    await this.#typePrompt(pending);
  }

  /** Pastes a prompt; while no turn runs, waits for Claude to take it. */
  async #typePrompt(pending: PendingPrompt) {
    const cancelled = () => !this.#pending.includes(pending);
    const taken = () => (cancelled() ? true : undefined);
    const markTyped = () => (pending.typedAt = Date.now());
    // Keys typed while Claude waits on an approval could answer its dialog.
    await this.#waitForOpenApprovals();
    const steering = await this.#type(pending.text, cancelled, markTyped);
    if (steering === undefined || steering || pending.command !== undefined) return;
    // A long prompt takes longer to be accepted, more so on a loaded machine.
    const deadline =
      Date.now() + SUBMIT_GIVE_UP_MS + pending.text.length * SUBMIT_GIVE_UP_MS_PER_CHARACTER;
    let retyped = false;
    for (;;) {
      try {
        await this.#waitFor("the prompt to submit", SUBMIT_TIMEOUT_MS, taken);
        return;
      } catch (error) {
        // Claude queues a prompt typed while a turn it started on its own runs.
        if (this.#turn) return;
        if (this.#closed || this.#exitCode !== undefined) throw error;
        // The prompt's row may be in the transcript before its hook arrives.
        this.#pumpTranscripts();
        if (taken()) return;
        // The user's own UserPromptSubmit hooks run before Claude reports the
        // prompt, and the terminal redraws its spinner meanwhile. They can also take
        // long without redrawing; typing again would send the prompt twice.
        const accepting =
          Date.now() - this.#lastOutputAt < QUIET_OUTPUT_MS ||
          stripTerminalEscapes(this.#screen.slice(-2_000)).includes("UserPromptSubmit hooks");
        // While the terminal shows signs of working on it, the prompt is not given up on.
        if (accepting) {
          if (Date.now() > deadline + SUBMIT_BUSY_GRACE_MS) return this.#giveUpOn(pending);
          continue;
        }
        if (Date.now() > deadline) return this.#giveUpOn(pending);
        // Typing again is for text left in the input box, such as under a notice. A box
        // without it means Claude took the prompt and is slow to report it: wait on.
        const flat = (text: string) => stripTerminalEscapes(text).replace(/\s/g, "");
        const inInput = flat(this.#screen.slice(-4_000)).includes(
          flat(pending.text).slice(0, PROMPT_ECHO_CHARACTERS),
        );
        if (retyped || !inInput) continue;
        retyped = true;
        // Something covers the input, such as a notice. Dismiss it, clear the
        // input, and send the prompt once more.
        this.#process?.write("\x1b");
        await sleep(500);
        this.#clearInput(pending.text);
        if ((await this.#type(pending.text, cancelled, markTyped)) === undefined) return;
      }
    }
  }

  /** A prompt Claude never took fails alone; the session and the prompts behind it go on. */
  #giveUpOn(pending: PendingPrompt) {
    const index = this.#pending.indexOf(pending);
    if (index < 0) return;
    this.#pending.splice(index, 1);
    this.#clearInput(pending.text);
    this.#cancelPrompt(pending.uuid);
  }

  /**
   * Types text into the input box and presses Enter. Returns whether a turn
   * was running, which then queues the text, or undefined when `cancelled`
   * turned true midway and the typed part was cleared again.
   */
  async #type(
    text: string,
    cancelled: () => boolean = () => false,
    onStart: () => void = () => undefined,
  ): Promise<boolean | undefined> {
    this.#typing++;
    try {
      return await this.#typeText(text, cancelled, onStart);
    } finally {
      this.#typing--;
    }
  }

  async #typeText(
    text: string,
    cancelled: () => boolean,
    onStart: () => void,
  ): Promise<boolean | undefined> {
    // A running turn redraws its spinner without pause; it queues the paste itself.
    // Keys typed while an interrupt is under way are lost, or interrupted themselves.
    await this.#waitFor("the interrupt to end", Number.POSITIVE_INFINITY, () =>
      this.#interrupting === undefined && this.#recovering === undefined ? true : undefined,
    );
    await this.#waitFor("the terminal to settle", INPUT_SETTLE_TIMEOUT_MS, () =>
      // After a Stop hook the terminal is ready, though it redraws for seconds more.
      this.#turn || this.#stoppedAt > 0 || Date.now() - this.#lastOutputAt >= QUIET_OUTPUT_MS
        ? true
        : undefined,
    ).catch(() => undefined);
    if (cancelled()) return undefined;
    const steering = this.#turn !== undefined;
    onStart();
    const input = terminalInputText(text);
    // Bracketed paste keeps newlines in the text from submitting early.
    const pastes = inputPastes(input);
    for (let from = 0; from < pastes.length; from += PASTES_PER_WRITE) {
      // An approval Claude opened meanwhile would take these keys as its answer.
      await this.#waitForOpenApprovals();
      if (cancelled()) {
        this.#clearInput(input);
        return undefined;
      }
      // The terminal takes pastes, and the Enter after them, back to back (measured); one
      // write carries several, as a write costs more than a short paste.
      const batch = pastes.slice(from, from + PASTES_PER_WRITE);
      this.#process?.write(batch.map((paste) => `\x1b[200~${paste}\x1b[201~`).join(""));
      // Lets an interrupt or a hook run between batches.
      await sleep(0);
    }
    // Enter right after a backslash inserts a line break instead of sending;
    // with the cursor before the trailing backslashes, Enter sends the whole text.
    const trailingBackslashes = /\\*$/.exec(input)?.[0].length ?? 0;
    if (trailingBackslashes > 0) {
      this.#process?.write("\x1b[D".repeat(trailingBackslashes));
      await sleep(100);
    }
    // An interrupt during the last pause cleared nothing yet; Enter would send the cancelled prompt.
    await this.#waitForOpenApprovals();
    if (cancelled()) {
      this.#clearInput(input);
      return undefined;
    }
    this.#process?.write("\r");
    // Text pasted before the box has taken this Enter would join it into one prompt.
    if (steering) await sleep(STEER_SUBMIT_GAP_MS);
    return steering;
  }

  /** Empties the input box of `text`, line by line; Ctrl+U clears only up to the line start. */
  #clearInput(text: string) {
    const lines = text.split("\n").length;
    this.#process?.write("\x15\x7f".repeat(lines) + "\x15");
  }

  /**
   * Waits until no turn runs and no approval is open. A turn whose Stop fired
   * waits only on its closing row; Claude is idle, so it is closed here.
   */
  async #waitForIdle() {
    await this.#waitFor("the turn to end", Number.POSITIVE_INFINITY, () => {
      if (this.#openApprovals > 0) return undefined;
      const turn = this.#turn;
      if (turn && !turn.command && turn.stopSeenAt > 0) {
        this.#expectLateEnd(turn);
        this.#finishTurn(turn, "completed");
      }
      return this.#turn ? undefined : true;
    });
  }

  /** Also waits out the redraw after an approval closed, which can still show its dialog. */
  #waitForOpenApprovals() {
    return this.#waitFor("open approvals", Number.POSITIVE_INFINITY, () =>
      this.#openApprovals === 0 &&
      Date.now() - this.#approvalClosedAt >= APPROVAL_SETTLE_MS &&
      Date.now() - this.#dialogDrawnAt >= DIALOG_HOOK_WAIT_MS
        ? true
        : undefined,
    );
  }

  /** Writes keys once no approval is open: a dialog that opened meanwhile would take them as its answer. */
  async #press(keys: string) {
    await this.#waitForOpenApprovals();
    this.#process?.write(keys);
  }

  /**
   * The typed prompts a submitted text stands for, taken out of the pending list.
   * Prompts typed in quick succession can reach Claude as one text, so a text
   * made of several typed prompts in a row takes all of them, in order.
   */
  #takePending(text: string, fallBackToOldest = false): PendingPrompt[] {
    const key = promptMatchKey(text);
    const index = this.#pending.findIndex(
      (prompt) => prompt.typedAt > 0 && promptMatchKey(prompt.text) === key,
    );
    if (index >= 0) return this.#pending.splice(index, 1);
    const typed = this.#pending.filter((prompt) => prompt.typedAt > 0);
    const squeezed = key.replace(/\s/g, "");
    let joined = "";
    for (const [count, prompt] of typed.entries()) {
      joined += promptMatchKey(prompt.text).replace(/\s/g, "");
      if (count > 0 && joined === squeezed) {
        const taken = typed.slice(0, count + 1);
        for (const each of taken) this.#pending.splice(this.#pending.indexOf(each), 1);
        return taken;
      }
      if (!squeezed.startsWith(joined)) break;
    }
    // Claude Code may rewrite a prompt on its way in; the oldest typed one is then the match.
    const oldest = fallBackToOldest ? typed[0] : undefined;
    if (!oldest) return [];
    this.#pending.splice(this.#pending.indexOf(oldest), 1);
    return [oldest];
  }

  #onPromptSubmitted(prompt: string) {
    const notification = parseTaskNotification(prompt);
    if (notification) this.#onTaskNotification(notification);
    // A prompt after Stop opens the next turn, even before the last one's turn_duration row.
    if (this.#turn && this.#turn.stopSeenAt > 0 && !this.#turn.command) {
      this.#expectLateEnd(this.#turn);
      this.#finishTurn(this.#turn, "completed");
    }
    // Typed during a turn, a prompt waits in Claude's queue: it joins the turn when
    // the transcript shows Claude took it in, or starts its own turn after this one.
    if (this.#turn) return;
    const pending = this.#takePending(prompt, notification === undefined);
    // The transcript row of the prompt names its origin exactly; see #onMainEntry.
    this.#startTurn({
      echo: pending.map((each) => each.uuid),
      origin: pending.length > 0 || !notification ? undefined : { kind: "task-notification" },
      command: this.#isCompaction(pending),
    });
  }

  /** /compact runs without a model call and no Stop hook ends it; its output line does. */
  #isCompaction(prompts: PendingPrompt[]) {
    return (
      prompts.length === 1 &&
      prompts[0]?.command === "compact" &&
      this.#command?.prompt === prompts[0]
    );
  }

  #startTurn(input: {
    readonly echo: string[];
    readonly origin: Record<string, unknown> | undefined;
    readonly command: boolean;
  }): Turn {
    const turn: Turn = {
      startedAt: Date.now(),
      echo: [],
      origin: input.origin,
      command: input.command,
      usage: new Map(),
      replyText: "",
      streamEnded: new Set(),
      rowMessages: new Set(),
      streamingId: undefined,
      replyEnded: false,
      apiError: undefined,
      durationRowSeen: 0,
      apiFailures: 0,
      denials: [],
      stopSeenAt: 0,
    };
    this.#turn = turn;
    this.#denyUntilNextTurn = false;
    for (const uuid of input.echo) this.#addToTurn(turn, uuid, false);
    this.#emitSystem({
      subtype: "init",
      cwd: this.#options.cwd ?? process.cwd(),
      tools: [],
      mcp_servers: [],
      model: this.#model ?? "",
      permissionMode: this.#permissionMode,
      slash_commands: [],
      apiKeySource: "none",
      output_style: "default",
      ...(turn.echo.length > 0 ? { user_message_uuids: [...turn.echo] } : {}),
    });
    return turn;
  }

  #addToTurn(turn: Turn, uuid: string, emit = true) {
    turn.echo.push(uuid);
    this.#emitLifecycle(uuid, "started");
    if (emit)
      this.#emitSystem({
        subtype: "status",
        status: "requesting",
        user_message_uuids: [...turn.echo],
      });
  }

  #finishTurn(turn: Turn, outcome: "completed" | "cancelled") {
    if (this.#turn !== turn) return;
    this.#turn = undefined;
    this.#turnEndedAt = Date.now();
    // A cancelled /compact never reaches PostCompact.
    if (turn.command && this.#compacting) {
      this.#compacting = false;
      this.#emitSystem({ subtype: "status", status: null });
    }
    this.#emit(this.#resultMessage(turn, outcome));
    for (const uuid of turn.echo) this.#emitLifecycle(uuid, outcome);
    if (this.#command && turn.echo.includes(this.#command.prompt.uuid)) {
      const command = this.#command;
      this.#command = undefined;
      command.done();
    }
  }

  async #runSessionSettingCommand(uuid: string, command: string, text: string) {
    const args = text
      .trim()
      .slice(command.length + 1)
      .trim();
    let output: string;
    try {
      if (!args) {
        const current =
          command === "model"
            ? (this.#model ?? "default")
            : String(this.#options.effort ?? "default");
        output = `Current ${command}: ${current}`;
      } else {
        output = command === "model" ? await this.#applyModel(args) : await this.#applyEffort(args);
      }
    } catch (error) {
      output = error instanceof Error ? error.message : String(error);
    }
    // A turn Claude started meanwhile, such as one a finished background task woke, ends first.
    await this.#waitForIdle();
    const turn = this.#startTurn({ echo: [uuid], origin: undefined, command: true });
    this.#emitReplay(output);
    this.#finishTurn(turn, "completed");
  }

  /** Runs a slash command for its effect once no turn runs, and returns what it printed. */
  async #runLocalCommand(text: string): Promise<string> {
    await this.#waitForIdle();
    const local: LocalCommand = { text, seen: false, output: undefined };
    this.#localCommand = local;
    try {
      const before = this.#screenTotal;
      // A turn that began while the terminal settled queues the command; it runs when that turn ends.
      if (await this.#type(text)) await this.#waitForIdle();
      let confirmed = false;
      const printed = await this.#waitFor(`${text} to finish`, LOCAL_COMMAND_TIMEOUT_MS, () => {
        // Switching models mid-conversation asks first, as the cache stays with the old one.
        // An approval dialog has the same "1. Yes" line; Enter on it would grant a tool.
        const shown = Math.max(this.#screenTotal - before, 0);
        const fresh = shown > 0 ? stripTerminalEscapes(this.#screen.slice(-shown)) : "";
        if (
          !confirmed &&
          this.#openApprovals === 0 &&
          Date.now() - this.#lastOutputAt > QUIET_OUTPUT_MS &&
          /Switchmodel\?[\s\S]*❯1\.Yes/.test(fresh.replace(/\s/g, ""))
        ) {
          confirmed = true;
          this.#process?.write("\r");
        }
        return local.output;
      });
      return printed.replace(/<\/?local-command-std(?:out|err)>/g, "").trim();
    } catch (error) {
      // A command that opened a dialog instead of printing leaves it open. Esc
      // during a turn would interrupt that turn instead.
      if (!this.#turn) this.#process?.write("\x1b");
      throw error;
    } finally {
      this.#localCommand = undefined;
    }
  }

  /** `/model` switches in place; the terminal also saves it as the user's default. */
  async #applyModel(model: string): Promise<string> {
    const output = await this.#runLocalCommand(`/model ${model}`);
    if (!output.startsWith("Set model to")) throw new Error(output);
    this.#options.model = model;
    this.#model = model;
    return output;
  }

  /** `/effort` sets the level or turns ultracode on and off, in place. */
  async #applyEffort(args: string): Promise<string> {
    const output = await this.#runLocalCommand(`/effort ${args}`);
    const ultracode = /^Ultracode (on|off)\b/.exec(output)?.[1];
    if (ultracode) {
      this.#options.settings = {
        ...this.#readSettings(this.#options.settings),
        ultracode: ultracode === "on",
      } as NonNullable<ClaudeQueryOptions["settings"]>;
    } else if (output.startsWith("Set effort level to")) {
      this.#options.effort = args.split(/\s+/)[0] as NonNullable<ClaudeQueryOptions["effort"]>;
    } else {
      throw new Error(output);
    }
    return output;
  }

  /** Presses Shift+Tab until the footer names the mode; a press the terminal drops is retried. */
  async #cyclePermissionMode(mode: PermissionMode): Promise<boolean> {
    // Shift+Tab on an approval dialog answers it. Default mode has no footer label
    // while a turn runs, so it is recognized only when Claude is idle.
    if (mode === "default") await this.#waitForIdle();
    else await this.#waitForOpenApprovals();
    let current: PermissionMode = this.#permissionMode;
    for (let press = 0; press < MAX_MODE_PRESSES; press++) {
      // An approval can open between presses.
      await this.#waitForOpenApprovals();
      const before = this.#screenTotal;
      this.#process?.write("\x1b[Z");
      // A redraw of the spinner can repeat the old mode; only a changed label counts.
      const shown = await this.#waitFor("the permission mode", MODE_REDRAW_TIMEOUT_MS, () => {
        const fresh = this.#screenTotal - before;
        const label = fresh > 0 ? permissionModeShown(this.#screen.slice(-fresh)) : undefined;
        return label !== undefined && label !== current ? label : undefined;
      }).catch(() => undefined);
      if (shown === mode) return true;
      if (shown) current = shown;
    }
    return false;
  }

  #emitReplay(text: string) {
    this.#emit({
      type: "user",
      message: { role: "user", content: `<local-command-stdout>${text}</local-command-stdout>` },
      parent_tool_use_id: null,
      isReplay: true,
      uuid: NodeCrypto.randomUUID(),
      session_id: this.#sessionId,
    } as unknown as SDKMessage);
  }

  #onCompactStarted() {
    const command = this.#command;
    if (!this.#turn && command && this.#pending.includes(command.prompt)) {
      this.#pending.splice(this.#pending.indexOf(command.prompt), 1);
      this.#startTurn({ echo: [command.prompt.uuid], origin: undefined, command: true });
    }
    this.#compacting = true;
    this.#emitSystem({ subtype: "status", status: "compacting" });
  }

  // ── Transcript ─────────────────────────────────────────────────────────

  #tick() {
    if (this.#closed) return;
    try {
      this.#pumpTranscripts();
      this.#checkTurnEnd();
      this.#checkCommandSettled();
      this.#checkStrandedPrompts();
      this.#reportRunningTools();
    } catch (error) {
      this.#fail(error);
    }
  }

  #pumpTranscripts() {
    let failure: unknown;
    try {
      for (const entry of this.#transcript?.read() ?? []) {
        // The reader has moved past the whole batch; one bad row must not drop the rest.
        try {
          this.#onMainEntry(entry);
        } catch (error) {
          failure ??= error;
        }
      }
      for (const subagent of this.#subagents.values()) {
        try {
          this.#pumpSubagent(subagent);
        } catch (error) {
          failure ??= error;
        }
      }
    } catch (error) {
      failure ??= error;
    }
    if (failure === undefined) {
      this.#pumpFailingSince = 0;
      return;
    }
    // Windows can hold a transcript for a moment; only a run of failures is fatal.
    this.#pumpFailingSince ||= Date.now();
    if (Date.now() - this.#pumpFailingSince > PUMP_FAILURE_GRACE_MS) throw failure;
  }

  #onMainEntry(entry: ClaudeTranscriptEntry) {
    if (entry.isSidechain) return;
    this.#activityAt = Date.now();
    if (entry.type === "user" && submittedPromptText(entry)?.startsWith(INTERRUPT_MARKER)) {
      this.#interruptMarks++;
      // Rows after the marker belong to what Claude runs next, not to the turn Esc stopped.
      const live = this.#turn;
      if (live && !live.command && this.#interrupting !== undefined) {
        this.#cancelLiveTurn(live);
        this.#releaseHeld();
      }
    }
    if (
      this.#interrupting !== undefined &&
      !this.#replayingBuffered &&
      entry.type === "assistant" &&
      // A row that closes the reply is the turn's own, however late the Esc came.
      !(entry.message?.stop_reason && entry.message.stop_reason !== "tool_use") &&
      this.#turn &&
      !this.#turn.command
    ) {
      // The reply being cut: shown only if the Esc turns out not to stop the turn.
      this.#bufferedDuringInterrupt.push(entry);
      return;
    }
    if (this.#discardingCutReply) {
      if (entry.type === "assistant") {
        // Rows dated after the cut belong to what runs next, such as a queued prompt's reply.
        const at = Date.parse(entry.timestamp ?? "");
        if (Number.isNaN(at) || at <= this.#cutAt) return;
        this.#discardingCutReply = false;
      }
      // The next prompt ends the discarding; the interrupt marker row is no prompt.
      const submitted = submittedPromptText(entry);
      if (submitted !== undefined && !submitted.startsWith(INTERRUPT_MARKER)) {
        this.#discardingCutReply = false;
      }
    }
    if (entry.type === "system" && entry.subtype === "turn_duration") {
      const turn = this.#turn;
      // The closing row is written after the Stop hooks, which can outlast the next prompt's
      // start, so its date says nothing; the first one after an early end is that turn's.
      if (this.#lateEnd.durations > 0 && Date.now() < this.#lateEnd.until) {
        this.#lateEnd.durations--;
        return;
      }
      if (!turn || turn.command) return;
      // Only a turn whose Stop fired; a later prompt may already have opened the next one.
      if (turn.stopSeenAt > 0) this.#finishTurn(turn, "completed");
      // A late row of the turn before this one is dated before this one began.
      else if (Date.parse(entry.timestamp ?? "") >= turn.startedAt - CLOCK_SKEW_MS) {
        turn.durationRowSeen = Date.now();
      }
      return;
    }
    if (entry.type === "queue-operation") {
      const text = String(entry.content ?? "");
      const notification = parseTaskNotification(text);
      if (notification) this.#onTaskNotification(notification);
      else if (entry.operation === "remove" && entry.reason === "absorbed_mid_turn" && this.#turn) {
        // A queued prompt the running turn took in between two of its steps leaves no prompt row.
        const taken = this.#takePending(text);
        if (this.#interrupting !== undefined) this.#heldByInterrupt.push(...taken);
        else for (const each of taken) this.#addToTurn(this.#turn, each.uuid);
      }
      return;
    }

    // A local command finished: it printed instead of prompting.
    const commandOutput = localCommandOutput(entry);
    // A settings command T3 typed itself is no part of the conversation.
    const local = this.#localCommand;
    if (local && localCommandInvocation(entry) === local.text) {
      local.seen = true;
      return;
    }
    if (local && commandOutput !== undefined) {
      if (local.seen) local.output ??= commandOutput;
      return;
    }
    const command = this.#command;
    if (commandOutput !== undefined && command && !this.#turn) {
      const index = this.#pending.indexOf(command.prompt);
      if (index >= 0) this.#pending.splice(index, 1);
      this.#startTurn({ echo: [command.prompt.uuid], origin: undefined, command: true });
    }

    const submitted = submittedPromptText(entry);
    if (submitted !== undefined && !submitted.startsWith(INTERRUPT_MARKER)) {
      // A queued prompt Claude took in, which skips UserPromptSubmit: mid-turn it joins
      // the turn; after one ended it opens the turn of the prompts that were waiting.
      const pending = this.#takePending(submitted);
      const current = this.#turn;
      // During an interrupt the terminal sends its queue before it writes the interrupt row;
      // those prompts run after the stopped turn, so they must not join it.
      if (pending.length > 0 && this.#interrupting !== undefined && current && !current.command) {
        this.#heldByInterrupt.push(...pending);
        return;
      }
      // Claude took the prompt in after a reply that was already complete: that turn is over.
      if (
        current &&
        !current.command &&
        pending.length > 0 &&
        (current.replyEnded || current.stopSeenAt > 0 || current.durationRowSeen > 0)
      ) {
        this.#expectLateEnd(current);
        this.#finishTurn(current, "completed");
      }
      // A command such as /compact answers nothing: a prompt taken in after it starts its own turn.
      if (current?.command && pending.length > 0) this.#finishTurn(current, "completed");
      if (this.#turn) {
        for (const each of pending) this.#addToTurn(this.#turn, each.uuid);
      } else if (pending.length > 0) {
        this.#startTurn({
          echo: pending.map((each) => each.uuid),
          origin: undefined,
          command: this.#isCompaction(pending),
        });
      }
      // A turn no prompt of ours started: a finished task, a peer message.
      if (this.#turn?.echo.length === 0 && entry.origin && entry.origin.kind !== "human") {
        this.#turn.origin = entry.origin;
      }
    }

    if (entry.type === "user") this.#onToolResults(entry);
    const message = sdkMessageFromTranscriptEntry(entry, this.#sessionId);
    if (message) {
      this.#emit(message);
      if (entry.type === "assistant" && this.#turn) this.#recordAssistant(this.#turn, entry);
    }
    if (commandOutput !== undefined && this.#turn?.command && command) {
      // A compaction that printed an error never reached PostCompact.
      if (this.#compacting) {
        this.#compacting = false;
        this.#emitSystem({
          subtype: "status",
          status: null,
          compact_result: "failed",
          compact_error: commandOutput.replace(/<\/?local-command-std(?:out|err)>/g, "").trim(),
        });
      }
      this.#finishTurn(this.#turn, "completed");
    }
  }

  #recordAssistant(turn: Turn, entry: ClaudeTranscriptEntry) {
    if (entry.message?.id) turn.rowMessages.add(entry.message.id);
    if (entry.message?.usage) {
      turn.usage.set(`${entry.message.id}:${entry.requestId}`, entry.message.usage);
    }
    for (const block of contentBlocks(entry.message?.content)) {
      if (block.type === "text" && typeof block.text === "string") turn.replyText = block.text;
    }
    const stopReason = entry.message?.stop_reason;
    turn.replyEnded = typeof stopReason === "string" && stopReason !== "tool_use";
    turn.apiError = entry.isApiErrorMessage
      ? {
          stopReason: entry.message?.stop_reason ?? null,
          status: typeof entry.apiErrorStatus === "number" ? entry.apiErrorStatus : null,
        }
      : undefined;
  }

  /** Tool results end running tools and start background shells. */
  #onToolResults(entry: ClaudeTranscriptEntry) {
    for (const block of contentBlocks(entry.message?.content)) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const toolUseId = block.tool_use_id;
      const tool = this.#runningTools.get(toolUseId);
      this.#runningTools.delete(toolUseId);
      const launch = this.#agentLaunches.findIndex(
        (candidate) => candidate.toolUseId === toolUseId,
      );
      if (launch >= 0) this.#agentLaunches.splice(launch, 1);
      if (tool?.taskId) {
        this.#emitSystem({
          subtype: "task_notification",
          task_id: tool.taskId,
          tool_use_id: toolUseId,
          // A shell cut off by an interrupt returns an error result; the SDK calls that stopped.
          status:
            block.is_error !== true
              ? "completed"
              : this.#interrupting !== undefined
                ? "stopped"
                : "failed",
          output_file: "",
          summary: String(tool.input.description ?? tool.input.command ?? ""),
        });
      }
      const result = entry.toolUseResult as
        | {
            readonly backgroundTaskId?: unknown;
            readonly taskId?: unknown;
            readonly status?: unknown;
            readonly agentId?: unknown;
          }
        | undefined;
      // A Monitor call starts a task of its own, named in its result as `taskId`.
      const startedTaskId =
        tool?.name === "Bash"
          ? result?.backgroundTaskId
          : tool?.name === "Monitor"
            ? result?.taskId
            : undefined;
      if (tool && typeof startedTaskId === "string") {
        this.#startBackgroundTask({
          taskId: startedTaskId,
          taskType: "local_bash",
          description: String(tool.input.description ?? tool.input.command ?? ""),
          toolUseId,
          label: String(tool.input.command ?? ""),
        });
      }
      // The terminal may run an Agent call in the background on its own.
      const subagent =
        result?.status === "async_launched" && typeof result.agentId === "string"
          ? this.#subagents.get(result.agentId)
          : undefined;
      if (subagent && !subagent.backgrounded) this.#moveToBackground(subagent);
    }
  }

  #checkTurnEnd() {
    const turn = this.#turn;
    if (!turn) return;
    if (turn.command) {
      // A compaction that reported its end but printed no line.
      if (turn.durationRowSeen && Date.now() - turn.durationRowSeen > STOP_HOOK_GRACE_MS) {
        this.#finishTurn(turn, "completed");
      }
      return;
    }
    // The closing row came but its Stop hook never did, such as when the hook call failed.
    if (turn.durationRowSeen && Date.now() - turn.durationRowSeen > STOP_HOOK_GRACE_MS) {
      this.#finishTurn(turn, "completed");
      return;
    }
    if (!turn.stopSeenAt) return;
    if (Date.now() - turn.stopSeenAt > TURN_END_FALLBACK_MS) this.#finishTurn(turn, "completed");
  }

  /** A prompt typed into Claude's queue that no turn ever took in is given up on. */
  #checkStrandedPrompts() {
    if (this.#turn || this.#openApprovals > 0 || this.#recovering || this.#interrupting) return;
    const now = Date.now();
    for (const prompt of this.#pending) {
      if (
        prompt.typedAt > 0 &&
        prompt.command === undefined &&
        now - prompt.typedAt > STRANDED_PROMPT_MS
      ) {
        this.#giveUpOn(prompt);
      }
    }
  }

  /** A slash command that neither prompts, compacts nor prints left a menu, or nothing, on screen. */
  #checkCommandSettled() {
    const command = this.#command;
    if (!command || this.#turn || !command.prompt.typedAt) return;
    if (!this.#pending.includes(command.prompt)) return;
    const now = Date.now();
    if (
      now - command.prompt.typedAt < COMMAND_SETTLE_MS ||
      now - this.#lastOutputAt < QUIET_OUTPUT_MS
    ) {
      return;
    }
    this.#pending.splice(this.#pending.indexOf(command.prompt), 1);
    this.#process?.write("\x1b");
    const turn = this.#startTurn({ echo: [command.prompt.uuid], origin: undefined, command: true });
    this.#finishTurn(turn, "completed");
  }

  // ── Tools, subagents and background tasks ──────────────────────────────

  #onToolStarted(input: HookInput) {
    const toolUseId = input.tool_use_id;
    if (!toolUseId) return;
    const tool: RunningTool = {
      name: input.tool_name ?? "",
      input: input.tool_input ?? {},
      startedAt: Date.now(),
      heartbeats: 0,
      agentId: input.agent_id,
    };
    this.#runningTools.set(toolUseId, tool);
    if (tool.name === "Agent" || tool.name === "Task") {
      this.#agentLaunches.push({ toolUseId, input: tool.input });
    }
  }

  /** Long shells become tasks, and long tools report heartbeats, as the SDK's do. */
  #reportRunningTools() {
    const now = Date.now();
    for (const [toolUseId, tool] of this.#runningTools) {
      // The SDK reports progress of the main conversation's tools only.
      if (tool.agentId !== undefined) continue;
      if (
        tool.name === "Bash" &&
        !tool.taskId &&
        tool.input.run_in_background !== true &&
        now - tool.startedAt > LONG_SHELL_MS
      ) {
        tool.taskId = `terminal-${toolUseId}`;
        this.#emitSystem({
          subtype: "task_started",
          task_id: tool.taskId,
          tool_use_id: toolUseId,
          description: String(tool.input.description ?? tool.input.command ?? ""),
          is_backgrounded: false,
          task_type: "local_bash",
        });
      }
      const heartbeat = Math.floor((now - tool.startedAt) / TOOL_HEARTBEAT_MS);
      if (heartbeat > tool.heartbeats) {
        tool.heartbeats = heartbeat;
        this.#emit({
          type: "tool_progress",
          tool_use_id: `${toolUseId}-heartbeat-${heartbeat - 1}`,
          tool_name: tool.name,
          parent_tool_use_id: toolUseId,
          elapsed_time_seconds: Math.round((now - tool.startedAt) / 1000),
          heartbeat: true,
          uuid: NodeCrypto.randomUUID(),
          session_id: this.#sessionId,
        } as unknown as SDKMessage);
      }
    }
  }

  #onSubagentStarted(input: HookInput) {
    const agentId = input.agent_id;
    if (!agentId) return;
    // Agent-type hooks of the user's own start subagents too; only Agent calls are reported.
    const agentType = input.agent_type ?? "";
    const index = this.#agentLaunches.findIndex(
      (launch) => String(launch.input.subagent_type ?? "general-purpose") === agentType,
    );
    if (index < 0) return;
    const [launch] = this.#agentLaunches.splice(index, 1);
    if (!launch) return;
    const transcriptPath = NodePath.join(
      NodePath.dirname(this.#transcript?.path ?? ""),
      this.#sessionId,
      "subagents",
      `agent-${agentId}.jsonl`,
    );
    const backgrounded = launch.input.run_in_background === true;
    const subagent: Subagent = {
      agentId,
      toolUseId: launch.toolUseId,
      description: String(launch.input.description ?? ""),
      subagentType: agentType,
      startedAt: Date.now(),
      transcript: new TranscriptReader(transcriptPath, false),
      backgrounded,
      toolUses: 0,
      totalTokens: 0,
      lastToolName: undefined,
    };
    this.#subagents.set(agentId, subagent);
    this.#emitSystem({
      subtype: "task_started",
      task_id: agentId,
      tool_use_id: launch.toolUseId,
      description: subagent.description,
      subagent_type: agentType,
      is_backgrounded: backgrounded,
      task_type: "local_agent",
      prompt: String(launch.input.prompt ?? ""),
    });
    if (backgrounded) {
      this.#startBackgroundTask(
        {
          taskId: agentId,
          taskType: "local_agent",
          description: subagent.description,
          toolUseId: launch.toolUseId,
          label: subagent.description,
        },
        false,
      );
    }
  }

  #pumpSubagent(subagent: Subagent) {
    for (const entry of subagent.transcript.read()) {
      for (const block of contentBlocks(entry.message?.content)) {
        if (block.type === "tool_result") this.#runningTools.delete(String(block.tool_use_id));
      }
      const message = sdkMessageFromTranscriptEntry(entry, this.#sessionId, subagent.toolUseId);
      if (!message) continue;
      this.#emit({
        ...message,
        agent_id: subagent.agentId,
        subagent_type: subagent.subagentType,
        task_description: subagent.description,
      } as unknown as SDKMessage);
      if (entry.type !== "assistant") continue;
      const usage = entry.message?.usage ?? {};
      subagent.totalTokens =
        (Number(usage.input_tokens) || 0) +
        (Number(usage.cache_read_input_tokens) || 0) +
        (Number(usage.cache_creation_input_tokens) || 0) +
        (Number(usage.output_tokens) || 0);
      const toolUses = contentBlocks(entry.message?.content).filter(
        (block) => block.type === "tool_use",
      );
      if (toolUses.length === 0) continue;
      subagent.toolUses += toolUses.length;
      subagent.lastToolName = String(toolUses.at(-1)?.name ?? "");
      this.#emitSystem({
        subtype: "task_progress",
        task_id: subagent.agentId,
        tool_use_id: subagent.toolUseId,
        description: subagent.description,
        subagent_type: subagent.subagentType,
        usage: this.#subagentUsage(subagent),
        last_tool_name: subagent.lastToolName,
      });
    }
  }

  #subagentUsage(subagent: Subagent) {
    return {
      total_tokens: subagent.totalTokens,
      tool_uses: subagent.toolUses,
      duration_ms: Date.now() - subagent.startedAt,
    };
  }

  #onSubagentStopped(input: HookInput) {
    const subagent = input.agent_id ? this.#subagents.get(input.agent_id) : undefined;
    if (!subagent) return;
    this.#pumpSubagent(subagent);
    this.#subagents.delete(subagent.agentId);
    this.#onTaskNotification(
      {
        taskId: subagent.agentId,
        toolUseId: subagent.toolUseId,
        status: "completed",
        summary: input.last_assistant_message ?? subagent.description,
        outputFile: "",
      },
      this.#subagentUsage(subagent),
    );
  }

  #moveToBackground(subagent: Subagent) {
    subagent.backgrounded = true;
    this.#emitSystem({
      subtype: "task_updated",
      task_id: subagent.agentId,
      patch: { is_backgrounded: true },
    });
    this.#startBackgroundTask(
      {
        taskId: subagent.agentId,
        taskType: "local_agent",
        description: subagent.description,
        toolUseId: subagent.toolUseId,
        label: subagent.description,
      },
      false,
    );
  }

  #startBackgroundTask(task: BackgroundTask, announce = true) {
    this.#backgroundTasks.set(task.taskId, task);
    this.#emitBackgroundTasks();
    if (!announce) return;
    this.#emitSystem({
      subtype: "task_started",
      task_id: task.taskId,
      tool_use_id: task.toolUseId,
      description: task.description,
      is_backgrounded: true,
      task_type: task.taskType,
    });
  }

  #emitBackgroundTasks() {
    this.#emitSystem({
      subtype: "background_tasks_changed",
      tasks: [...this.#backgroundTasks.values()].map((task) => ({
        task_id: task.taskId,
        task_type: task.taskType,
        description: task.description,
      })),
    });
  }

  #onTaskNotification(notification: TaskNotification, usage?: Record<string, unknown>) {
    // A notification without a status is an event of a task that goes on, such as a Monitor line.
    if (!notification.status) return;
    if (this.#notifiedTaskIds.has(notification.taskId)) return;
    this.#notifiedTaskIds.add(notification.taskId);
    const task = this.#backgroundTasks.get(notification.taskId);
    // The terminal says "killed" for a task that was stopped; the SDK says "stopped".
    const status = notification.status === "killed" ? "stopped" : notification.status;
    this.#emitSystem({
      subtype: "task_updated",
      task_id: notification.taskId,
      patch: { status, end_time: Date.now() },
    });
    this.#emitSystem({
      subtype: "task_notification",
      task_id: notification.taskId,
      tool_use_id: notification.toolUseId ?? task?.toolUseId,
      status,
      output_file: notification.outputFile,
      summary: notification.summary,
      ...(usage ? { usage } : {}),
    });
    if (task) {
      this.#backgroundTasks.delete(notification.taskId);
      this.#emitBackgroundTasks();
    }
  }

  // ── API tap ────────────────────────────────────────────────────────────

  #onMainRequest() {
    // Tool results land in the transcript just before the request that sends them.
    this.#stoppedAt = 0;
    this.#pumpTranscripts();
    const turn = this.#turn;
    if (!turn || turn.command) return;
    // Claude went on after a Stop, such as when a user Stop hook asked it to.
    turn.stopSeenAt = 0;
    this.#emitSystem({
      subtype: "status",
      status: "requesting",
      ...(turn.echo.length > 0 ? { user_message_uuids: [...turn.echo] } : {}),
    });
  }

  /** The terminal writes no rows for API retries, so the SDK's api_retry is rebuilt from the response status. */
  #onMainResponse(status: number, headers: NodeHttp.IncomingHttpHeaders) {
    const turn = this.#turn;
    if (!turn || turn.command || turn.stopSeenAt > 0) return;
    if (status < 400) {
      turn.apiFailures = 0;
      return;
    }
    const retryAfterHeader = headers["retry-after"];
    const retryAfter = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
    if (!isRetryableApiStatus(status, retryAfter)) return;
    // Claude Code does not repeat a call the server marks so, other than an overload.
    if (status !== 529 && headers["x-should-retry"] === "false") return;
    const attempt = ++turn.apiFailures;
    const env = this.#options.env ?? process.env;
    const maxRetries = maxApiRetries(env.CLAUDE_CODE_MAX_RETRIES);
    // Past the budget Claude Code gives up and writes the error reply instead.
    if (attempt > maxRetries) return;
    this.#emitSystem({
      subtype: "api_retry",
      attempt,
      max_retries: maxRetries,
      retry_delay_ms: apiRetryDelayMs(attempt, retryAfter),
      error_status: status,
      error: apiRetryError(status),
    });
  }

  #onStreamEvent(event: unknown) {
    this.#trackStreamedReply(event);
    this.#activityAt = Date.now();
    // After Stop, requests such as the next-prompt suggestion reuse the main
    // conversation; their text is not part of the reply.
    if (!this.#turn || this.#turn.command || this.#turn.stopSeenAt > 0) return;
    // A reply that starts streaming ends the run of failed calls.
    if ((event as { readonly type?: unknown } | null)?.type === "message_start") {
      this.#turn.apiFailures = 0;
    }
    // The terminal saves each finished block; it goes out before the next block's deltas.
    this.#pumpTranscripts();
    this.#emit({
      type: "stream_event",
      event,
      parent_tool_use_id: null,
      uuid: NodeCrypto.randomUUID(),
      session_id: this.#sessionId,
    } as unknown as SDKMessage);
  }

  /** Notes which messages the stream closed, so a hook can tell when the file still lacks their rows. */
  #trackStreamedReply(event: unknown) {
    const turn = this.#turn;
    if (!turn || turn.command || turn.stopSeenAt > 0) return;
    const { type, message, delta } = event as {
      readonly type?: string;
      readonly message?: { readonly id?: unknown };
      readonly delta?: { readonly stop_reason?: unknown };
    };
    if (type === "message_start") {
      turn.streamingId = typeof message?.id === "string" ? message.id : undefined;
    } else if (
      type === "message_delta" &&
      turn.streamingId &&
      typeof delta?.stop_reason === "string" &&
      delta.stop_reason !== "tool_use"
    ) {
      turn.streamEnded.add(turn.streamingId);
    }
  }

  #onRateLimits(infos: ReadonlyArray<SDKRateLimitInfo>) {
    const key = JSON.stringify(infos);
    if (key === this.#lastRateLimits) return;
    this.#lastRateLimits = key;
    for (const info of infos) {
      this.#emit({
        type: "rate_limit_event",
        rate_limit_info: info,
        uuid: NodeCrypto.randomUUID(),
        session_id: this.#sessionId,
      } as unknown as SDKMessage);
    }
  }

  // ── Output ─────────────────────────────────────────────────────────────

  #emitLifecycle(uuid: string, state: "queued" | "started" | "completed" | "cancelled") {
    this.#emit({
      type: "command_lifecycle",
      command_uuid: uuid,
      state,
      uuid: NodeCrypto.randomUUID(),
      session_id: this.#sessionId,
    } as unknown as SDKMessage);
  }

  #emitSystem(fields: Record<string, unknown>) {
    this.#emit({
      type: "system",
      ...fields,
      uuid: NodeCrypto.randomUUID(),
      session_id: this.#sessionId,
    } as unknown as SDKMessage);
  }

  #resultMessage(turn: Turn, outcome: "completed" | "cancelled"): SDKResultMessage {
    const usages = [...turn.usage.values()];
    const sum = (key: string) =>
      usages.reduce((total, usage) => total + (Number(usage[key]) || 0), 0);
    const durationMs = Date.now() - turn.startedAt;
    const messageIds = new Set([...turn.usage.keys()].map((key) => key.split(":")[0]));
    const common = {
      type: "result" as const,
      duration_ms: durationMs,
      duration_api_ms: durationMs,
      num_turns: turn.command ? 0 : Math.max(1, messageIds.size),
      // Subscription turns have no per-turn price.
      total_cost_usd: 0,
      usage: {
        ...usages.at(-1),
        input_tokens: sum("input_tokens"),
        output_tokens: sum("output_tokens"),
        cache_creation_input_tokens: sum("cache_creation_input_tokens"),
        cache_read_input_tokens: sum("cache_read_input_tokens"),
      } as SDKResultSuccess["usage"],
      modelUsage: {},
      permission_denials: turn.denials,
      uuid: NodeCrypto.randomUUID() as SDKResultSuccess["uuid"],
      session_id: this.#sessionId,
      ...(turn.echo.length > 0
        ? { user_message_uuid: turn.echo[0], user_message_uuids: [...turn.echo] }
        : {}),
      ...(turn.origin ? { origin: turn.origin } : {}),
    };
    if (outcome === "cancelled") {
      return {
        ...common,
        subtype: "error_during_execution",
        is_error: false,
        stop_reason: null,
        terminal_reason: "aborted_streaming",
        errors: ["Request interrupted by user"],
      } as unknown as SDKResultMessage;
    }
    // The SDK reports a failed API call as a success envelope flagged as an error.
    if (turn.apiError && !turn.command) {
      return {
        ...common,
        subtype: "success",
        is_error: true,
        result: turn.replyText,
        stop_reason: turn.apiError.stopReason,
        terminal_reason: "api_error",
        api_error_status: turn.apiError.status,
      } as unknown as SDKResultSuccess;
    }
    return {
      ...common,
      subtype: "success",
      is_error: false,
      result: turn.command ? "" : turn.replyText,
      stop_reason: turn.command ? null : "end_turn",
      terminal_reason: "completed",
    } as unknown as SDKResultSuccess;
  }

  #emit(message: SDKMessage) {
    this.#outbox.push(message);
    this.#outboxWaiter?.();
  }

  #fail(error: unknown) {
    if (this.#closed) return;
    const detail = error instanceof Error ? error.message : String(error);
    this.#failure = new Error(`${detail}\n${this.#screenTail()}`, { cause: error });
    this.#outboxWaiter?.();
    this.close();
  }

  async next(): Promise<IteratorResult<SDKMessage, void>> {
    for (;;) {
      const message = this.#outbox.shift();
      if (message) return { done: false, value: message };
      if (this.#failure) throw this.#failure;
      if (this.#closed) return { done: true, value: undefined };
      await new Promise<void>((resolve) => (this.#outboxWaiter = resolve));
      this.#outboxWaiter = undefined;
    }
  }

  async return(): Promise<IteratorResult<SDKMessage, void>> {
    this.close();
    return { done: true, value: undefined };
  }

  async throw(error?: unknown): Promise<IteratorResult<SDKMessage, void>> {
    this.close();
    throw error;
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  async #waitFor<T>(label: string, timeoutMs: number, check: () => T | undefined): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.#closed) throw new Error("Claude terminal session closed.");
      if (this.#exitCode !== undefined)
        throw new Error(`Claude exited while waiting for ${label}.`);
      const value = check();
      if (value !== undefined) return value;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for ${label}.\n${this.#screenTail()}`);
  }

  #screenTail() {
    return stripTerminalEscapes(this.#screen).slice(-1_500);
  }

  #waitForQuietOutput(timeoutMs = 60_000) {
    return this.#waitFor("the terminal to settle", timeoutMs, () =>
      Date.now() - this.#lastOutputAt >= QUIET_OUTPUT_MS ? true : undefined,
    );
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  // ── Query controls ─────────────────────────────────────────────────────

  /** Esc stops the running reply the way a person at the terminal would. */
  /** One Stop at a time: a second Esc on an idle input opens the rewind picker. */
  readonly interrupt = () =>
    (this.#interrupting ??= this.#interrupt().finally(() => {
      this.#interrupting = undefined;
    }));

  async #interrupt() {
    // A prompt typed a moment ago starts its turn when its hook arrives; that turn is the one to stop.
    if (!this.#turn && this.#pending.some((prompt) => prompt.typedAt > 0 && !prompt.command)) {
      await this.#waitFor("the turn to start", PROMPT_TURN_WAIT_MS, () => this.#turn).catch(
        () => undefined,
      );
    }
    // Esc in the middle of a paste would cut the prompt.
    await this.#waitFor("typing to finish", INTERRUPT_TYPING_WAIT_MS, () =>
      this.#typing === 0 ? true : undefined,
    ).catch(() => undefined);
    const turn = this.#turn;
    // Open approvals end with the turn; Esc on their dialog would deny them, so answer first.
    this.#abortApprovals();
    if (!turn) {
      this.#releaseCancelledCommand();
      return;
    }
    // Claude already stopped and only the turn's closing row is missing; Esc
    // on an idle input would open the rewind picker instead.
    const stopped = turn.stopSeenAt > 0 && !turn.command;
    const marksBefore = this.#interruptMarks;
    const turnTexts = turn.echo.flatMap((uuid) => this.#promptTexts.get(uuid) ?? []);
    // Prompts typed into Claude's queue before this Esc; they outlive the turn.
    const waiting = this.#pending.filter((prompt) => prompt.typedAt > 0);
    if (!stopped && !(await this.#escapeTurn(turn))) {
      // Claude kept going; the turn ends with its own result.
      this.#replayBuffered();
      return;
    }
    this.#pumpTranscripts();
    // An interrupt before any reply hands the prompt back to the input box and writes no
    // interrupt row; the next prompt pasted over it would be sent with it as one.
    if (!stopped && this.#interruptMarks === marksBefore && turnTexts.length > 0) {
      await this.#waitForQuietOutput(3_000).catch(() => undefined);
      if (this.#openApprovals === 0) this.#clearInput(turnTexts.join("\n"));
    }
    // The turn may have ended on its own, or the interrupt row ended it, while the Esc settled.
    if (this.#turn === turn) {
      if (stopped) {
        this.#clearAbandonedWork();
        this.#expectLateEnd(turn);
        this.#finishTurn(turn, "completed");
      } else {
        this.#cancelLiveTurn(turn);
      }
    }
    this.#releaseHeld();
    this.#replayBuffered();
    if (!stopped && waiting.length > 0) {
      // Detached, so a second interrupt can stop what the terminal runs next; typing waits for it.
      const recovering: Promise<void> = this.#recoverQueued(waiting)
        .catch(() => undefined)
        .finally(() => {
          if (this.#recovering === recovering) this.#recovering = undefined;
        });
      this.#recovering = recovering;
    }
    this.#releaseCancelledCommand();
  }

  /** Rows held back during an interrupt that did not cancel their turn go out after all. */
  #replayBuffered() {
    const rows = this.#bufferedDuringInterrupt.splice(0);
    if (!this.#turn || this.#turn.command) return;
    this.#replayingBuffered = true;
    try {
      for (const row of rows) this.#onMainEntry(row);
    } finally {
      this.#replayingBuffered = false;
    }
  }

  /** Prompts the terminal took in during an interrupt run as the next turn. */
  #releaseHeld() {
    const held = this.#heldByInterrupt.splice(0);
    if (held.length === 0) return;
    if (this.#turn) {
      for (const each of held) this.#addToTurn(this.#turn, each.uuid);
      return;
    }
    this.#startTurn({ echo: held.map((each) => each.uuid), origin: undefined, command: false });
  }

  /** Ends a turn Esc stopped: its work is dropped and its result says cancelled. */
  #cancelLiveTurn(turn: Turn) {
    this.#clearAbandonedWork();
    this.#finishTurn(turn, "cancelled");
    this.#discardingCutReply = true;
    this.#cutAt = Date.now();
    this.#denyUntilNextTurn = true;
    this.#bufferedDuringInterrupt.length = 0;
  }

  /** What an interrupted turn leaves behind in the bookkeeping. */
  #clearAbandonedWork() {
    // Interrupted calls never write a result row.
    for (const [toolUseId, tool] of this.#runningTools) {
      if (tool.agentId !== undefined) continue;
      this.#runningTools.delete(toolUseId);
      if (tool.taskId) {
        this.#emitSystem({
          subtype: "task_notification",
          task_id: tool.taskId,
          tool_use_id: toolUseId,
          status: "stopped",
          output_file: "",
          summary: String(tool.input.description ?? tool.input.command ?? ""),
        });
      }
    }
    // The same goes for Agent calls: launches that never started, and foreground
    // subagents Esc ended without a SubagentStop. Backgrounded ones keep running.
    this.#agentLaunches.length = 0;
    for (const subagent of this.#subagents.values()) {
      if (subagent.backgrounded) continue;
      this.#subagents.delete(subagent.agentId);
      for (const [toolUseId, tool] of this.#runningTools) {
        if (tool.agentId === subagent.agentId) this.#runningTools.delete(toolUseId);
      }
      this.#onTaskNotification(
        {
          taskId: subagent.agentId,
          toolUseId: subagent.toolUseId,
          status: "stopped",
          summary: subagent.description,
          outputFile: "",
        },
        this.#subagentUsage(subagent),
      );
    }
  }

  /**
   * Presses Esc until the transcript records the interrupt, or Claude is idle.
   * Esc is sometimes ignored, such as while a tool starts; a second one on an
   * idle input would open the rewind picker, so it is sent only while the
   * terminal still redraws. False when Claude went on with the turn.
   */
  async #escapeTurn(turn: Turn): Promise<boolean> {
    const done = () => (this.#turn !== turn || turn.stopSeenAt > 0 ? true : undefined);
    for (let press = 0; press < MAX_ESCAPE_PRESSES; press++) {
      if (this.#closed) return false;
      const marks = this.#interruptMarks;
      this.#process?.write("\x1b");
      const confirmed = await this.#waitFor(
        "the interrupt",
        ESCAPE_CONFIRM_MS,
        () => done() ?? (this.#interruptMarks > marks ? true : undefined),
      ).catch(() => undefined);
      if (confirmed) return true;
      // A terminal that stopped redrawing is idle: the interrupt took, its row is late.
      if (Date.now() - this.#lastOutputAt >= QUIET_OUTPUT_MS) {
        const late = await this.#waitFor(
          "the interrupt row",
          ESCAPE_CONFIRM_MS * 2,
          () => done() ?? (this.#interruptMarks > marks ? true : undefined),
        ).catch(() => undefined);
        return late !== undefined || this.#turn === turn;
      }
    }
    // A loaded terminal never goes quiet. A model that shows no progress after the
    // presses was stopped, whatever the transcript says.
    return Date.now() - this.#activityAt > ESCAPE_STALL_MS;
  }

  /**
   * After an interrupt the terminal runs the prompts queued behind the turn, or
   * hands them back to the input box. Those it handed back are cleared and sent again.
   */
  async #recoverQueued(waiting: PendingPrompt[]) {
    // Turns the terminal runs first, such as another queued prompt, come before the wait.
    const since = Date.now();
    await this.#waitFor("the queued prompts", Number.POSITIVE_INFINITY, () => {
      this.#pumpTranscripts();
      if (waiting.every((prompt) => !this.#pending.includes(prompt))) return true;
      const idleSince = Math.max(this.#turnEndedAt, since);
      return !this.#turn && Date.now() - idleSince >= QUEUE_RESUME_MS ? true : undefined;
    }).catch(() => undefined);
    // Only a prompt shown back in the input box was handed back; one the terminal is
    // slow to report (hooks running) would be sent twice.
    const flat = (text: string) => stripTerminalEscapes(text).replace(/\s/g, "");
    const bottom = flat(this.#screen.slice(-1_500));
    const hooksRunning = this.#screen.slice(-2_000).includes("UserPromptSubmit hooks");
    const handedBack = waiting.filter(
      (prompt) =>
        this.#pending.includes(prompt) &&
        !hooksRunning &&
        bottom.includes(flat(prompt.text).slice(0, PROMPT_ECHO_CHARACTERS)),
    );
    if (handedBack.length === 0 || this.#turn || this.#openApprovals > 0) return;
    this.#clearInput(handedBack.map((prompt) => prompt.text).join("\n"));
    for (const prompt of handedBack) {
      prompt.typedAt = 0;
      void this.#enqueue(() => this.#deliver(prompt)).catch((error: unknown) => this.#fail(error));
    }
  }

  /** A turn closed before its Stop hook or closing row: those still arrive, and belong to it. */
  #expectLateEnd(turn: Turn) {
    this.#lateEnd = {
      stops: this.#lateEnd.stops + (turn.stopSeenAt > 0 ? 0 : 1),
      durations: this.#lateEnd.durations + (turn.durationRowSeen > 0 ? 0 : 1),
      until: Date.now() + LATE_END_WINDOW_MS,
    };
  }

  /** Ends a prompt that will never run, with a cancelled result when no turn can carry it. */
  #cancelPrompt(uuid: string) {
    // A turn Claude started meanwhile keeps running; the prompt only ends its lifecycle.
    if (this.#turn) {
      this.#emitLifecycle(uuid, "cancelled");
      return;
    }
    const cancelled = this.#startTurn({ echo: [uuid], origin: undefined, command: true });
    this.#finishTurn(cancelled, "cancelled");
  }

  /** A slash command whose prompt was cancelled gets no turn; its waiter would never return. */
  #releaseCancelledCommand() {
    const command = this.#command;
    if (!command || this.#pending.includes(command.prompt)) return;
    this.#command = undefined;
    command.done();
  }

  readonly setModel = (model?: string) =>
    this.#enqueue(async () => {
      // The SDK resets to the default model when given none; the terminal has no such command.
      if (!model || model === this.#options.model) return;
      await this.#applyModel(model);
    });

  /**
   * Effort and ultracode switch in place through `/effort`. Other settings
   * only load at launch, so they restart the terminal on the same session.
   */
  readonly applyFlagSettings = (settings: FlagSettings) =>
    this.#enqueue(async () => {
      const { effortLevel, ultracode, ...rest } = settings;
      if (typeof effortLevel === "string" && effortLevel !== this.#options.effort) {
        await this.#applyEffort(effortLevel);
      }
      const current: FlagSettings = this.#readSettings(this.#options.settings);
      if (ultracode !== undefined && (ultracode === true) !== (current.ultracode === true)) {
        await this.#applyEffort(`ultracode ${ultracode === true ? "on" : "off"}`);
      }
      const next: FlagSettings = { ...current };
      for (const [key, value] of Object.entries(rest)) {
        if (value === null || value === undefined) delete next[key];
        else next[key] = value;
      }
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      // With background tasks running, the restart waits for the next prompt after they end.
      this.#options.settings = next as NonNullable<ClaudeQueryOptions["settings"]>;
      this.#markRestart();
    });

  /**
   * Shift+Tab switches the mode in place. A mode outside its cycle, such as
   * bypass in a session that did not start allowing it, restarts the terminal.
   */
  readonly setPermissionMode = (mode: PermissionMode) =>
    this.#enqueue(async () => {
      if (mode === this.#permissionMode) return;
      const previous = this.#permissionMode;
      const cycled =
        CYCLED_PERMISSION_MODES.has(mode) ||
        (mode === "bypassPermissions" && this.#options.allowDangerouslySkipPermissions === true);
      if (cycled && (await this.#cyclePermissionMode(mode))) {
        this.#options.permissionMode = mode;
        this.#notePermissionMode(mode);
        return;
      }
      if (cycled && CYCLED_PERMISSION_MODES.has(previous))
        await this.#cyclePermissionMode(previous);
      this.#assertCanRestart("the permission mode");
      // The next prompt must run in the new mode, so the restart cannot wait for it.
      await this.#waitForIdle();
      // The turn that just ended may have started a background task.
      this.#assertCanRestart("the permission mode");
      this.#options.permissionMode = mode;
      if (mode === "bypassPermissions") this.#options.allowDangerouslySkipPermissions = true;
      await this.#restart();
    });

  readonly setMcpServers = async (servers: Record<string, unknown>) => {
    const current = this.#options.mcpServers ?? {};
    const added = Object.keys(servers).filter((name) => !(name in current));
    const removed = Object.keys(current).filter((name) => !(name in servers));
    if (JSON.stringify(servers) !== JSON.stringify(current)) {
      this.#options.mcpServers = servers as NonNullable<ClaudeQueryOptions["mcpServers"]>;
      this.#markRestart();
    }
    return { added, removed, errors: {} };
  };

  /** Stops one background task from the terminal's task list (↓, Enter, select, x). */
  readonly stopTask = (taskId: string) =>
    this.#enqueue(async () => {
      const task = this.#backgroundTasks.get(taskId);
      if (!task) throw new Error(`Claude has no background task ${taskId} to stop.`);
      const flat = (text: string) => stripTerminalEscapes(text).replace(/\s/g, "");
      if (task.taskType === "local_agent") {
        // Down opens the agents panel on "main"; each further Down moves to the next agent,
        // in launch order, and x stops the one selected (no Enter). A running shell adds a
        // "shell" pill that takes the first Down, so Down is pressed until the footer offers
        // "x to stop", which only an agent row does.
        const agents = [...this.#backgroundTasks.values()].filter(
          (each) => each.taskType === "local_agent",
        );
        let onAgent = false;
        for (let presses = 0; presses < 4 && !onAgent; presses++) {
          const before = this.#screenTotal;
          await this.#press("\x1b[B");
          onAgent = await this.#waitFor("the agent row", 1_500, () => {
            const fresh = this.#screenTotal - before;
            return fresh > 0 && flat(this.#screen.slice(-fresh)).includes("xtostop")
              ? true
              : undefined;
          }).catch(() => false);
        }
        if (!onAgent) {
          // The panel, if open, takes Esc; closed, there is nothing for it to do.
          await this.#press("\x1b");
          throw new Error(`The terminal's agent list does not show task ${taskId}.`);
        }
        for (let step = 0; step < agents.indexOf(task); step++) {
          await this.#press("\x1b[B");
          await sleep(250);
        }
        await this.#press("x");
        await sleep(500);
        await this.#press("\x1b");
        await sleep(300);
        return;
      }
      // Every key goes through #press: an approval can open between them.
      await this.#waitForOpenApprovals();
      const before = this.#screenTotal;
      this.#process?.write("\x1b[B");
      await sleep(400);
      await this.#press("\r");
      const list = await this.#waitFor("the task list", 5_000, () => {
        const fresh = this.#screenTotal - before;
        if (fresh <= 0) return undefined;
        const text = flat(this.#screen.slice(-fresh));
        const at = text.lastIndexOf("xtostop");
        return at >= 0 ? text.slice(0, at) : undefined;
      }).catch(() => undefined);
      // Rows keep launch order; each is found by the name the list shows. The
      // list cuts long names, so only their start is compared. A task without a
      // name cannot be found, and one launched before the target would shift its place.
      const launched = [...this.#backgroundTasks.values()];
      const nameOf = (candidate: BackgroundTask) =>
        flat(candidate.label).slice(0, TASK_LABEL_MATCH_CHARS);
      const rows = launched
        .map((candidate) => ({ candidate, at: list ? list.lastIndexOf(nameOf(candidate)) : -1 }))
        .filter((row) => nameOf(row.candidate) && row.at >= 0)
        .sort((a, b) => a.at - b.at);
      const index = rows.findIndex((row) => row.candidate === task);
      const unnamedBefore = launched
        .slice(0, launched.indexOf(task))
        .some((candidate) => !nameOf(candidate));
      if (index < 0 || unnamedBefore) {
        // Without the list open, Esc would interrupt the turn instead.
        if (list !== undefined) await this.#press("\x1b");
        throw new Error(`The terminal's task list does not show task ${taskId}.`);
      }
      for (let step = 0; step < index; step++) {
        await this.#press("\x1b[B");
        await sleep(150);
      }
      await this.#press("x");
      await sleep(500);
      await this.#press("\x1b");
      await sleep(300);
    });

  /** Ctrl+B moves the running foreground work to the background, as at the terminal. */
  readonly backgroundTasks = async (toolUseId: string) => {
    const subagent = [...this.#subagents.values()].find(
      (candidate) => candidate.toolUseId === toolUseId && !candidate.backgrounded,
    );
    if (!subagent || !this.#turn) return false;
    // Outside the queue, as a queued prompt may be waiting on this very subagent.
    await this.#waitFor("typing to finish", Number.POSITIVE_INFINITY, () =>
      this.#typing === 0 ? true : undefined,
    );
    await this.#waitForOpenApprovals();
    // The work may have ended while the key waited.
    if (!this.#turn || !this.#subagents.has(subagent.agentId) || subagent.backgrounded) {
      return false;
    }
    this.#process?.write("\x02");
    this.#moveToBackground(subagent);
    return true;
  };

  readonly close = () => {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#outboxWaiter?.();
    if (this.#exitCode === undefined) this.#process?.kill();
    this.#hookServer?.close();
    // An approval hook still open keeps its socket, and the curl behind it, alive.
    this.#hookServer?.closeAllConnections();
    this.#tap?.close();
    this.#endPromptIterator();
    this.#command?.done();
    this.#removeWorkDir(0);
  };

  /** settings.json holds the hook token and mcp.json may hold credentials, so a failed delete is retried. */
  #removeWorkDir(attempt: number) {
    try {
      NodeFS.rmSync(this.#workDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the files of a process still exiting; give up to the OS's temp cleanup.
      if (attempt >= WORK_DIR_REMOVE_RETRIES) return;
      setTimeout(() => this.#removeWorkDir(attempt + 1), WORK_DIR_REMOVE_RETRY_MS).unref();
    }
  }
}

/** Builds the `query()` replacement for Claude instances that run in the terminal. */
export const makeClaudeTerminalQueryFactory = Effect.gen(function* () {
  const pty = yield* PtyAdapter.PtyAdapter;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  return (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }): ClaudeTerminalQueryRuntime =>
    new ClaudeTerminalQuery(input, (spawnInput) => runPromise(pty.spawn(spawnInput)));
});
