import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import { explainSandboxError } from "./diagnostics.ts";
import { buildLauncher, USER_SCRIPT_NAME } from "./launcher.ts";

export const DEFAULT_TIMEOUT_SECS = 30;
export const DEFAULT_MAX_STDOUT_BYTES = 20 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 20 * 1024;
export const DEFAULT_MAX_RETAINED_OUTPUT_BYTES = 64 * 1024 * 1024;
export const PYTHON_COMMAND = "uv";
/**
 * A grandchild that inherited the output pipes can hold them open after uv
 * exits, so reads are drained on a bounded wait rather than to EOF.
 */
const DRAIN_GRACE_MS = 500;
const PROCESS_STOP_GRACE_MS = 500;
const MAX_DISPATCH_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_DISPATCH_CONNECTIONS = 4;
const MAX_PENDING_DISPATCHES = 128;

const missingUvMessage = (command: string): string =>
  `code_execution needs the \`${command}\` command, which is not on PATH.

uv runs the script's CPython interpreter and installs PEP 723 dependencies. Install it from https://docs.astral.sh/uv/getting-started/installation/ or set PI_CODE_EXECUTION_UV to the uv executable.`;

export const MISSING_UV_MESSAGE = missingUvMessage(PYTHON_COMMAND);

const isMissingExecutable = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

export interface SpooledOutputStream {
  emittedBytes: number;
  emittedLines: number;
  endsWithNewline: boolean;
  path: string;
  retainedBytes: number;
}

export interface OutputSpool {
  retainedBytes: number;
  retentionLimitBytes: number;
  retentionTruncated: boolean;
  stderr: SpooledOutputStream;
  stdout: SpooledOutputStream;
}

export type OutputSpoolConsumer = (spool: OutputSpool) => Promise<void> | void;

export interface RunnerOptions {
  cwd?: string;
  env?: Record<string, string>;
  maxRetainedOutputBytes?: number;
  maxStderrBytes?: number;
  maxStdoutBytes?: number;
  outputSpoolConsumer?: OutputSpoolConsumer;
  signal?: AbortSignal;
  timeoutSecs?: number;
  toolSignatures?: Record<string, string>;
}

export type RunStatus =
  | "cancelled"
  | "policy_error"
  | "runtime_error"
  | "setup_error"
  | "success"
  | "timeout";

export interface OutputStreamPreview {
  head: string;
  tail: string;
  truncated: boolean;
}

export interface RunResult {
  diagnostic?: string;
  durationMs: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  outputPreview: {
    stderr: OutputStreamPreview;
    stdout: OutputStreamPreview;
  };
  outputRetentionTruncated: boolean;
  retainedOutputBytes: number;
  status: RunStatus;
  stderr?: string;
  stderrBytes: number;
  stderrLines: number;
  stderrTruncated: boolean;
  stdout: string;
  stdoutBytes: number;
  stdoutEndsWithNewline: boolean;
  stdoutLines: number;
  stdoutTruncated: boolean;
}

/** Marks a rejected nested call without relying on its human-readable reason. */
export class NestedToolPolicyError extends Error {
  override readonly name = "NestedToolPolicyError";
}

export interface OutputChunk {
  stream: "stderr" | "stdout";
  text: string;
}

export type OutputCallback = (chunk: OutputChunk) => void;

/** Agent tools, keyed by the name Python calls them by. */
export type HostFunctions = Record<
  string,
  (args: Record<string, unknown>) => Promise<string> | string
>;

/** A factory can give cancellable host work the signal for this specific run. */
export type HostFunctionsFactory = (signal: AbortSignal) => HostFunctions;
export type HostFunctionsInput = HostFunctions | HostFunctionsFactory;

interface DispatchRequest {
  args: Record<string, unknown>;
  id: number;
  token: string;
  tool: string;
}

interface DispatchServer {
  policyError: () => NestedToolPolicyError | undefined;
  port: number;
  stop: () => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isDispatchRequest = (value: unknown): value is DispatchRequest => {
  if (!isRecord(value)) return false;
  const { args, id, token, tool } = value;
  return (
    isRecord(args) &&
    typeof token === "string" &&
    typeof tool === "string" &&
    tool.length > 0 &&
    Number.isSafeInteger(id) &&
    typeof id === "number" &&
    id > 0
  );
};

const sameToken = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

const raceWithAbort = async <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) {
    throw signal.reason ?? new Error("code execution was cancelled");
  }
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        onAbort = (): void => reject(signal.reason ?? new Error("code execution was cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
};

/**
 * Serves Python tool calls over authenticated loopback TCP. The token is per
 * run, so an unrelated local process cannot use the ephemeral listener.
 */
const startDispatchServer = async (
  token: string,
  tools: HostFunctions,
  signal: AbortSignal,
): Promise<DispatchServer> => {
  const sockets = new Set<Socket>();
  let pending = 0;
  let policyError: NestedToolPolicyError | undefined;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;

  const stop = async (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }
    stopped = true;
    for (const socket of sockets) {
      socket.destroy();
    }
    stopPromise = new Promise<void>((resolve) => server.close(() => resolve()));
    return stopPromise;
  };

  const server = createServer((socket) => {
    if (stopped || sockets.size >= MAX_DISPATCH_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let writes = Promise.resolve();
    const send = (message: unknown): void => {
      let frame: Buffer;
      try {
        frame = Buffer.from(`${JSON.stringify(message)}\n`, "utf-8");
      } catch {
        socket.destroy();
        return;
      }
      if (frame.length > MAX_DISPATCH_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      writes = writes
        .then(
          () =>
            new Promise<void>((resolve) => {
              if (socket.destroyed) {
                resolve();
              } else if (socket.write(frame)) {
                resolve();
              } else {
                const finish = (): void => {
                  socket.off("close", finish);
                  socket.off("error", finish);
                  resolve();
                };
                socket.once("drain", finish);
                socket.once("close", finish);
                socket.once("error", finish);
              }
            }),
        )
        .catch(() => undefined);
    };
    const dispatch = async (line: Buffer): Promise<void> => {
      let request: unknown;
      try {
        request = JSON.parse(line.toString("utf-8"));
      } catch {
        socket.destroy();
        return;
      }
      if (!isDispatchRequest(request) || !sameToken(request.token, token)) {
        socket.destroy();
        return;
      }
      const tool = tools[request.tool];
      if (!tool) {
        send({ error: `unknown tool: ${request.tool}`, id: request.id, ok: false });
        return;
      }
      if (pending >= MAX_PENDING_DISPATCHES) {
        send({ error: "too many pending tool calls", id: request.id, ok: false });
        return;
      }
      pending += 1;
      try {
        const value = await raceWithAbort(Promise.resolve(tool(request.args)), signal);
        if (!signal.aborted) {
          send({ id: request.id, ok: true, value });
        }
      } catch (error) {
        if (error instanceof NestedToolPolicyError) {
          policyError ??= error;
        }
        if (!signal.aborted) {
          send({
            error: error instanceof Error ? error.message : String(error),
            id: request.id,
            ok: false,
          });
        }
      } finally {
        pending -= 1;
      }
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let newline = buffer.indexOf(10);
      while (newline >= 0) {
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length === 0 || line.length > MAX_DISPATCH_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        void dispatch(line);
        newline = buffer.indexOf(10);
      }
      if (buffer.length > MAX_DISPATCH_FRAME_BYTES) {
        socket.destroy();
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  });
  server.on("error", () => undefined);

  await new Promise<void>((resolve, reject) => {
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await stop();
    throw new Error("could not start host dispatch server");
  }
  signal.addEventListener("abort", () => void stop(), { once: true });
  if (signal.aborted) {
    await stop();
    throw signal.reason ?? new Error("code execution was cancelled");
  }
  return { policyError: () => policyError, port: address.port, stop };
};

type PythonProcess = ChildProcessByStdio<null, Readable, Readable>;

interface SpawnOptions {
  cwd?: string;
  env: Record<string, string>;
  launcherPath: string;
  scriptPath: string;
  uvCommand: string;
}

/**
 * uv is a hard requirement rather than a fallback: it selects the interpreter
 * and installs PEP 723 dependencies, so a plain `python3` would silently run a
 * different environment. Missing it is reported on the first run.
 */
const spawnPython = async (options: SpawnOptions): Promise<PythonProcess> => {
  if (options.cwd) {
    let metadata;
    try {
      metadata = await stat(options.cwd);
    } catch (error) {
      throw new Error(`Python working directory is unavailable: ${options.cwd}`, {
        cause: error,
      });
    }
    if (!metadata.isDirectory()) {
      throw new Error(`Python working directory is not a directory: ${options.cwd}`);
    }
  }
  const child = spawn(
    options.uvCommand,
    ["run", "--quiet", "--no-config", options.launcherPath, options.scriptPath],
    {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, ...options.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  return await new Promise<PythonProcess>((resolve, reject) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolve(child);
    };
    const onError = (error: Error): void => {
      child.off("spawn", onSpawn);
      reject(
        isMissingExecutable(error)
          ? new Error(missingUvMessage(options.uvCommand), { cause: error })
          : error,
      );
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
};

/**
 * `uv run` starts CPython as a child. Put uv in a separate process group, then
 * signal that group so a timed-out script cannot leave background subprocesses
 * behind holding files, sockets, or inherited stdout open.
 */
const signalProcess = (child: PythonProcess, signal: NodeJS.Signals): boolean => {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return false;
      }
    }
  }
  // Windows has no POSIX process groups here. This is direct-child cleanup
  // only; descendants are not claimed to be contained.
  return child.kill(signal);
};

interface ProcessExit {
  exitCode?: number;
  signal?: NodeJS.Signals;
}

const waitForExit = (child: PythonProcess): Promise<ProcessExit> =>
  new Promise((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      child.off("error", onError);
      resolve({
        ...(code === null ? {} : { exitCode: code }),
        ...(signal === null ? {} : { signal }),
      });
    };
    const onError = (error: Error): void => {
      child.off("exit", onExit);
      reject(error);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Give POSIX descendants a chance to exit, then force bounded cleanup. */
const terminateProcessTree = async (child: PythonProcess): Promise<void> => {
  if (!signalProcess(child, "SIGTERM")) return;
  await delay(PROCESS_STOP_GRACE_MS);
  signalProcess(child, "SIGKILL");
};

interface StreamPreview {
  complete?: Buffer;
  head: Buffer;
  limit: number;
  tail: Buffer;
}

interface SpooledStreamResult {
  bytes: number;
  endsWithNewline: boolean;
  lines: number;
  preview: OutputStreamPreview;
  retainedBytes: number;
  text: string;
  truncated: boolean;
}

const createStreamPreview = (maxBytes: number): StreamPreview => ({
  complete: Buffer.alloc(0),
  head: Buffer.alloc(0),
  limit: Math.max(0, maxBytes),
  tail: Buffer.alloc(0),
});

const appendTail = (current: Buffer, data: Buffer, limit: number): Buffer => {
  if (limit === 0) return Buffer.alloc(0);
  if (data.length >= limit) return data.subarray(data.length - limit);
  const keepFromCurrent = Math.min(current.length, limit - data.length);
  return Buffer.concat([current.subarray(current.length - keepFromCurrent), data]);
};

/** Maintain a bounded exact value until it becomes a bounded head-tail preview. */
const appendPreview = (preview: StreamPreview, data: Buffer): void => {
  if (preview.complete === undefined) {
    preview.tail = appendTail(preview.tail, data, preview.limit - preview.head.length);
    return;
  }

  const remaining = preview.limit - preview.complete.length;
  const kept = data.subarray(0, Math.max(0, remaining));
  preview.complete = Buffer.concat([preview.complete, kept]);
  if (data.length <= remaining) return;

  const headLimit = Math.floor(preview.limit / 2);
  const tailLimit = preview.limit - headLimit;
  preview.head = preview.complete.subarray(0, headLimit);
  preview.tail = appendTail(
    preview.complete.subarray(headLimit),
    data.subarray(Math.max(0, remaining)),
    tailLimit,
  );
  preview.complete = undefined;
};

const decodePreviewPart = (data: Buffer, boundary: "head" | "tail"): string => {
  const decoded = data.toString("utf-8");
  return boundary === "head"
    ? decoded.replace(/\uFFFD+$/u, "")
    : decoded.replace(/^\uFFFD+/u, "");
};

const finishPreview = (preview: StreamPreview): OutputStreamPreview => {
  if (preview.complete !== undefined) {
    return {
      head: preview.complete.toString("utf-8"),
      tail: "",
      truncated: false,
    };
  }
  return {
    head: decodePreviewPart(preview.head, "head"),
    tail: decodePreviewPart(preview.tail, "tail"),
    truncated: true,
  };
};

const appendLegacyCapture = (
  captured: Buffer,
  data: Buffer,
  limit: number,
  retention: "head" | "tail",
): Buffer => {
  if (limit === 0 || (retention === "head" && captured.length >= limit)) return captured;
  if (retention === "head") {
    return Buffer.concat([captured, data.subarray(0, limit - captured.length)]);
  }
  return appendTail(captured, data, limit);
};

/** Drain, count, spool, and preview one raw process stream. */
const readSpooledStream = async (
  stream: NodeJS.ReadableStream,
  spool: FileHandle,
  maxPreviewBytes: number,
  legacyRetention: "head" | "tail",
  reserveRetention: (data: Buffer) => Buffer,
  onOutput?: (text: string) => void,
): Promise<SpooledStreamResult> => {
  const decoder = new TextDecoder();
  const limit = Math.max(0, maxPreviewBytes);
  const preview = createStreamPreview(limit);
  let bytes = 0;
  let captured: Buffer = Buffer.alloc(0);
  let lastByte: number | undefined;
  let lineBreaks = 0;
  let retainedBytes = 0;
  for await (const chunk of stream) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    lastByte = data.at(-1);
    for (const byte of data) {
      if (byte === 0x0a) lineBreaks += 1;
    }
    appendPreview(preview, data);
    captured = appendLegacyCapture(captured, data, limit, legacyRetention);
    const retained = reserveRetention(data);
    if (retained.length > 0) {
      await spool.write(retained);
      retainedBytes += retained.length;
    }
    const decoded = decoder.decode(data, { stream: true });
    if (decoded) onOutput?.(decoded);
  }
  const finalText = decoder.decode();
  if (finalText) onOutput?.(finalText);
  const lines = bytes === 0 ? 0 : lineBreaks + (lastByte === 0x0a ? 0 : 1);
  const text = decodePreviewPart(captured, legacyRetention);
  return {
    bytes,
    endsWithNewline: lastByte === 0x0a,
    lines,
    preview: finishPreview(preview),
    retainedBytes,
    text,
    truncated: captured.length < bytes,
  };
};

export interface SandboxRunnerOptions {
  uvCommand?: string;
}

export class SandboxRunner {
  private readonly activeRuns = new Map<Promise<RunResult>, AbortController>();
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly uvCommand: string;

  constructor(options: SandboxRunnerOptions | string = {}) {
    this.uvCommand =
      typeof options === "string"
        ? options
        : (options.uvCommand ?? process.env.PI_CODE_EXECUTION_UV ?? PYTHON_COMMAND);
  }

  run(
    code: string,
    tools: HostFunctionsInput = {},
    onOutput?: OutputCallback,
    options: RunnerOptions = {},
  ): Promise<RunResult> {
    if (this.closed) {
      return Promise.reject(new Error("code execution runner is closed"));
    }
    const controller = new AbortController();
    const result = this.execute(code, tools, onOutput, options, controller);
    this.activeRuns.set(result, controller);
    void result.then(
      () => this.activeRuns.delete(result),
      () => this.activeRuns.delete(result),
    );
    return result;
  }

  private async execute(
    code: string,
    toolsInput: HostFunctionsInput,
    onOutput: OutputCallback | undefined,
    options: RunnerOptions,
    controller: AbortController,
  ): Promise<RunResult> {
    const startedAt = performance.now();
    const timeoutSecs = options.timeoutSecs ?? DEFAULT_TIMEOUT_SECS;
    const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
    const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    const maxRetainedOutputBytes = Math.max(
      0,
      options.maxRetainedOutputBytes ?? DEFAULT_MAX_RETAINED_OUTPUT_BYTES,
    );
    let timedOut = false;
    const timeoutError = new Error(
      `The run exceeded its ${timeoutSecs}s deadline and was stopped.`,
    );
    const cancelError = new Error("code execution was cancelled");
    const onCallerAbort = (): void => controller.abort(options.signal?.reason ?? cancelError);
    options.signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (options.signal?.aborted) {
      onCallerAbort();
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
    }, timeoutSecs * 1000);
    const signal = controller.signal;
    const throwIfAborted = (): void => {
      if (signal.aborted) {
        throw timedOut ? timeoutError : cancelError;
      }
    };
    let directory: string | undefined;
    let server: DispatchServer | undefined;
    let stopChild: (() => Promise<void>) | undefined;
    let stderr = "";
    let stderrBytes = 0;
    let stderrEndsWithNewline = false;
    let stderrLines = 0;
    let stderrPath: string | undefined;
    let stderrPreview: OutputStreamPreview = {
      head: "",
      tail: "",
      truncated: false,
    };
    let stderrRetainedBytes = 0;
    let stderrSpool: FileHandle | undefined;
    let stderrTruncated = false;
    let stdout = "";
    let stdoutBytes = 0;
    let stdoutEndsWithNewline = false;
    let stdoutLines = 0;
    let stdoutPath: string | undefined;
    let stdoutPreview: OutputStreamPreview = {
      head: "",
      tail: "",
      truncated: false,
    };
    let stdoutRetainedBytes = 0;
    let stdoutSpool: FileHandle | undefined;
    let stdoutTruncated = false;
    let retainedOutputBytes = 0;
    let outputRetentionTruncated = false;
    let processExit: ProcessExit = {};
    let streamError: unknown;
    const outcome = (status: RunStatus, diagnostic?: string): RunResult => ({
      ...(diagnostic ? { diagnostic } : {}),
      durationMs: performance.now() - startedAt,
      ...processExit,
      outputPreview: { stderr: stderrPreview, stdout: stdoutPreview },
      outputRetentionTruncated,
      retainedOutputBytes,
      status,
      ...(stderr ? { stderr } : {}),
      stderrBytes,
      stderrLines,
      stderrTruncated,
      stdout,
      stdoutBytes,
      stdoutEndsWithNewline,
      stdoutLines,
      stdoutTruncated,
    });

    try {
      throwIfAborted();
      const tools = typeof toolsInput === "function" ? toolsInput(signal) : toolsInput;
      throwIfAborted();
      directory = await mkdtemp(path.join(tmpdir(), "pi-code-"));
      throwIfAborted();
      const scriptPath = path.join(directory, USER_SCRIPT_NAME);
      const launcherPath = path.join(directory, "_pi_launcher.py");
      const setupMarkerPath = path.join(directory, "setup-complete");
      const watchdogPath = path.join(directory, "watchdog-expired");
      stdoutPath = path.join(directory, "stdout.spool");
      stderrPath = path.join(directory, "stderr.spool");
      stdoutSpool = await open(stdoutPath, "wx", 0o600);
      stderrSpool = await open(stderrPath, "wx", 0o600);
      const token = randomBytes(32).toString("base64url");
      await writeFile(scriptPath, code, "utf-8");
      await writeFile(launcherPath, buildLauncher(code), "utf-8");
      throwIfAborted();
      server = await startDispatchServer(token, tools, signal);
      const child = await spawnPython({
        cwd: options.cwd,
        env: {
          ...options.env,
          PI_DEADLINE_SECS: String(timeoutSecs),
          PI_HOST_PORT: String(server.port),
          PI_HOST_TOKEN: token,
          PI_SETUP_MARKER: setupMarkerPath,
          PI_TOOL_NAMES: JSON.stringify(Object.keys(tools)),
          PI_TOOL_SIGNATURES: JSON.stringify(options.toolSignatures ?? {}),
          PI_WATCHDOG_PATH: watchdogPath,
        },
        launcherPath,
        scriptPath,
        uvCommand: this.uvCommand,
      });
      const exit = waitForExit(child);
      let stopping: Promise<void> | undefined;
      stopChild = (): Promise<void> => {
        stopping ??= terminateProcessTree(child);
        return stopping;
      };
      const onRunAbort = (): void => {
        void stopChild?.();
      };
      signal.addEventListener("abort", onRunAbort, { once: true });
      if (signal.aborted) {
        onRunAbort();
      }

      const reserveRetention = (data: Buffer): Buffer => {
        const remaining = maxRetainedOutputBytes - retainedOutputBytes;
        const retained = data.subarray(0, Math.max(0, remaining));
        retainedOutputBytes += retained.length;
        if (retained.length < data.length) outputRetentionTruncated = true;
        return retained;
      };
      const collectStdout = async (): Promise<void> => {
        if (!stdoutSpool) throw new Error("stdout spool is unavailable");
        const captured = await readSpooledStream(
          child.stdout,
          stdoutSpool,
          maxStdoutBytes,
          "head",
          reserveRetention,
          (text) => onOutput?.({ stream: "stdout", text }),
        );
        ({
          bytes: stdoutBytes,
          endsWithNewline: stdoutEndsWithNewline,
          lines: stdoutLines,
          preview: stdoutPreview,
          retainedBytes: stdoutRetainedBytes,
          text: stdout,
          truncated: stdoutTruncated,
        } = captured);
      };
      const collectStderr = async (): Promise<void> => {
        if (!stderrSpool) throw new Error("stderr spool is unavailable");
        const captured = await readSpooledStream(
          child.stderr,
          stderrSpool,
          maxStderrBytes,
          "tail",
          reserveRetention,
          (text) => onOutput?.({ stream: "stderr", text }),
        );
        ({
          bytes: stderrBytes,
          endsWithNewline: stderrEndsWithNewline,
          lines: stderrLines,
          preview: stderrPreview,
          retainedBytes: stderrRetainedBytes,
          text: stderr,
          truncated: stderrTruncated,
        } = captured);
      };
      const drained = Promise.all([collectStdout(), collectStderr()]).catch((error: unknown) => {
        if (!signal.aborted) {
          streamError = error;
          controller.abort(error);
        }
      });
      processExit = await exit;
      // uv can exit before a subprocess. On POSIX, terminate its group so a
      // descendant cannot keep the output pipes open. Windows is direct-child only.
      const cleanedUp = stopChild();
      const fullyDrained = await Promise.race([
        drained.then(() => true),
        delay(DRAIN_GRACE_MS).then(() => false),
      ]);
      if (!fullyDrained) {
        child.stdout.destroy();
        child.stderr.destroy();
        await Promise.allSettled([drained]);
      }
      await cleanedUp;
      signal.removeEventListener("abort", onRunAbort);

      if (streamError !== undefined) {
        throw streamError;
      }
      const watchdogTimedOut = await stat(watchdogPath).then(
        (metadata) => metadata.isFile(),
        () => false,
      );
      if (stdoutTruncated) {
        stdout = `[stdout truncated: showing the first ${Buffer.byteLength(stdout, "utf-8")} of ${stdoutBytes} bytes]\n${stdout}`;
      }
      if (stderrTruncated) {
        stderr = `[stderr truncated: showing the last ${Buffer.byteLength(stderr, "utf-8")} of ${stderrBytes} bytes]\n${stderr}`;
      }
      if (timedOut || watchdogTimedOut) {
        return outcome("timeout", explainSandboxError(timeoutError.message, code));
      }
      if (signal.aborted) {
        return outcome("cancelled", cancelError.message);
      }
      const policyError = server.policyError();
      if (policyError) {
        return outcome("policy_error", policyError.message);
      }

      const setupComplete = await stat(setupMarkerPath).then(
        (metadata) => metadata.isFile(),
        () => false,
      );
      if (processExit.exitCode !== 0 || processExit.signal) {
        const processMessage = processExit.signal
          ? `uv terminated by ${processExit.signal}`
          : `uv exited with ${String(processExit.exitCode)}`;
        const diagnostic = explainSandboxError(stderr.trim() || processMessage, code);
        return outcome(setupComplete ? "runtime_error" : "setup_error", diagnostic);
      }
      return outcome("success");
    } catch (error) {
      if (streamError !== undefined) {
        throw streamError;
      }
      if (timedOut) {
        return outcome("timeout", explainSandboxError(timeoutError.message, code));
      }
      if (signal.aborted) {
        return outcome("cancelled", cancelError.message);
      }
      const diagnostic = error instanceof Error ? error.message : String(error);
      return outcome("setup_error", explainSandboxError(diagnostic, code));
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onCallerAbort);
      try {
        await stopChild?.();
        await server?.stop();
        await Promise.all([stdoutSpool?.close(), stderrSpool?.close()]);
        if (
          options.outputSpoolConsumer &&
          stdoutPath &&
          stderrPath
        ) {
          await options.outputSpoolConsumer({
            retainedBytes: retainedOutputBytes,
            retentionLimitBytes: maxRetainedOutputBytes,
            retentionTruncated: outputRetentionTruncated,
            stderr: {
              emittedBytes: stderrBytes,
              emittedLines: stderrLines,
              endsWithNewline: stderrEndsWithNewline,
              path: stderrPath,
              retainedBytes: stderrRetainedBytes,
            },
            stdout: {
              emittedBytes: stdoutBytes,
              emittedLines: stdoutLines,
              endsWithNewline: stdoutEndsWithNewline,
              path: stdoutPath,
              retainedBytes: stdoutRetainedBytes,
            },
          });
        }
      } finally {
        if (directory) {
          await rm(directory, { force: true, recursive: true });
        }
      }
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      for (const controller of this.activeRuns.values()) {
        controller.abort(new Error("code execution runner is closed"));
      }
      this.closePromise = Promise.allSettled([...this.activeRuns.keys()]).then(() => undefined);
    }
    return this.closePromise;
  }
}
