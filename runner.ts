import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
const WATCHDOG_MARKER_PREFIX = "__PI_CODE_EXECUTION_WATCHDOG_";

const missingUvMessage = (command: string): string =>
  `code_execution needs the \`${command}\` command, which is not on PATH.

uv runs the script's CPython interpreter and installs PEP 723 dependencies. Install it from https://docs.astral.sh/uv/getting-started/installation/ or set PI_CODE_EXECUTION_UV to the uv executable.`;

export const MISSING_UV_MESSAGE = missingUvMessage(PYTHON_COMMAND);

const isMissingExecutable = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

export interface RunnerOptions {
  cwd?: string;
  env?: Record<string, string>;
  maxStderrBytes?: number;
  maxStdoutBytes?: number;
  signal?: AbortSignal;
  timeoutSecs?: number;
  toolSignatures?: Record<string, string>;
}

export interface RunResult {
  stderr?: string;
  stderrBytes?: number;
  stderrTruncated?: boolean;
  stdout: string;
  stdoutBytes?: number;
  stdoutTruncated?: boolean;
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
  return { port: address.port, stop };
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

const waitForExit = (child: PythonProcess): Promise<number> =>
  new Promise((resolve, reject) => {
    const onExit = (code: number | null): void => {
      child.off("error", onError);
      resolve(code ?? -1);
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

interface CappedStream {
  bytes: number;
  text: string;
  truncated: boolean;
}

/** Read a stream without retaining unbounded stderr in the extension process. */
const readCappedStream = async (
  stream: NodeJS.ReadableStream,
  maxBytes: number,
  onOutput?: (text: string) => void,
): Promise<CappedStream> => {
  const limit = Math.max(0, maxBytes);
  const decoder = new TextDecoder();
  let captured: Buffer = Buffer.alloc(0);
  let bytes = 0;
  for await (const chunk of stream) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    const decoded = decoder.decode(data, { stream: true });
    if (decoded) onOutput?.(decoded);
    if (limit === 0) continue;
    if (data.length >= limit) {
      captured = data.subarray(data.length - limit);
      continue;
    }
    captured = Buffer.concat([captured, data]);
    if (captured.length > limit) {
      captured = captured.subarray(captured.length - limit);
    }
  }
  const finalText = decoder.decode();
  if (finalText) onOutput?.(finalText);
  const truncated = captured.length < bytes;
  const text = captured.toString("utf-8").replace(/^\uFFFD/u, "");
  return { bytes, text, truncated };
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
    const timeoutSecs = options.timeoutSecs ?? DEFAULT_TIMEOUT_SECS;
    const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
    const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
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

    try {
      throwIfAborted();
      const tools = typeof toolsInput === "function" ? toolsInput(signal) : toolsInput;
      throwIfAborted();
      directory = await mkdtemp(path.join(tmpdir(), "pi-code-"));
      throwIfAborted();
      const scriptPath = path.join(directory, USER_SCRIPT_NAME);
      const launcherPath = path.join(directory, "_pi_launcher.py");
      const token = randomBytes(32).toString("base64url");
      const watchdogMarker = `${WATCHDOG_MARKER_PREFIX}${randomBytes(16).toString("hex")}__`;
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
          PI_TOOL_NAMES: JSON.stringify(Object.keys(tools)),
          PI_TOOL_SIGNATURES: JSON.stringify(options.toolSignatures ?? {}),
          PI_WATCHDOG_MARKER: watchdogMarker,
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

      let stdout = "";
      let stdoutBytes = 0;
      let stdoutTruncated = false;
      const collectStdout = async (): Promise<void> => {
        const decoder = new TextDecoder();
        for await (const chunk of child.stdout) {
          const text = decoder.decode(chunk, { stream: true });
          if (!text) continue;
          stdoutBytes += Buffer.byteLength(text, "utf-8");
          const remaining = maxStdoutBytes - Buffer.byteLength(stdout, "utf-8");
          if (remaining <= 0) {
            stdoutTruncated = true;
          } else {
            const accepted = Buffer.from(text)
              .subarray(0, remaining)
              .toString("utf-8")
              .replace(/\uFFFD$/u, "");
            stdout += accepted;
            stdoutTruncated ||=
              Buffer.byteLength(accepted, "utf-8") < Buffer.byteLength(text, "utf-8");
          }
          onOutput?.({ stream: "stdout", text });
        }
        const finalText = decoder.decode();
        if (finalText) {
          stdoutBytes += Buffer.byteLength(finalText, "utf-8");
          const remaining = maxStdoutBytes - Buffer.byteLength(stdout, "utf-8");
          const accepted = Buffer.from(finalText)
            .subarray(0, Math.max(remaining, 0))
            .toString("utf-8")
            .replace(/\uFFFD$/u, "");
          stdout += accepted;
          stdoutTruncated ||=
            Buffer.byteLength(accepted, "utf-8") < Buffer.byteLength(finalText, "utf-8");
          onOutput?.({ stream: "stdout", text: finalText });
        }
      };
      let stderr = "";
      let stderrBytes = 0;
      let stderrTruncated = false;
      const collectStderr = async (): Promise<void> => {
        const captured = await readCappedStream(child.stderr, maxStderrBytes, (text) =>
          onOutput?.({ stream: "stderr", text }),
        );
        ({ bytes: stderrBytes, text: stderr, truncated: stderrTruncated } = captured);
      };
      let streamError: unknown;
      const drained = Promise.all([collectStdout(), collectStderr()]).catch((error: unknown) => {
        if (!signal.aborted) {
          streamError = error;
          controller.abort(error);
        }
      });
      const exitCode = await exit;
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

      if (timedOut || stderr.includes(watchdogMarker)) {
        throw new Error(explainSandboxError(timeoutError.message, code));
      }
      if (streamError !== undefined) {
        throw streamError;
      }
      if (signal.aborted) {
        throw cancelError;
      }
      if (stdoutTruncated) {
        stdout = `[stdout truncated: showing the first ${Buffer.byteLength(stdout, "utf-8")} of ${stdoutBytes} bytes]\n${stdout}`;
      }
      if (stderrTruncated) {
        stderr = `[stderr truncated: showing the last ${Buffer.byteLength(stderr, "utf-8")} of ${stderrBytes} bytes]\n${stderr}`;
      }
      // Exit 124 is a normal user-controlled exit status. Only our random
      // watchdog marker or explicit timeout state represents a timeout.
      if (exitCode !== 0) {
        throw new Error(explainSandboxError(stderr.trim() || `uv exited with ${exitCode}`, code));
      }
      return {
        ...(stderr
          ? { stderr, ...(stderrTruncated ? { stderrBytes, stderrTruncated: true } : {}) }
          : {}),
        stdout,
        ...(stdoutTruncated ? { stdoutBytes, stdoutTruncated: true } : {}),
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onCallerAbort);
      await stopChild?.();
      await server?.stop();
      if (directory) {
        await rm(directory, { force: true, recursive: true });
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
