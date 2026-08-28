import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";

import {
  codeDigest,
  CodeArtifactUnavailableError,
  loadCodeArtifact,
  saveCodeArtifact,
} from "./artifacts.ts";
import type { CodeArtifactReference, LoadedCodeArtifact } from "./artifacts.ts";
import {
  codeSourceReference,
  isRedactedCodePlaceholder,
  parseCodeArtifactReference,
  redactCompletedCodeExecutions,
  saveContextCodeArtifacts,
} from "./context.ts";
import {
  appendLiveOutputTail,
  assembleOutput,
  formatHeadTailOutput,
  MAX_CODE_EXECUTION_OUTPUT_BYTES,
  truncateFailureOutput,
  truncateOutput,
} from "./core.ts";
import {
  aggregateNestedToolUsage,
  CODE_EXECUTION_COLLECT_TOOLS_EVENT,
  createBridgedRegistrations,
  createHostFunctions,
  createNestedToolCallRecord,
  createPythonRegistrations,
  createToolCollection,
  MAX_RECOVERED_TOOL_OUTPUT_BYTES,
  renderToolSignature,
} from "./host.ts";
import type {
  NestedToolCallIdentity,
  NestedToolCallOutcome,
  NestedToolCallPreflight,
  NestedToolCallRecord as HostNestedToolCallRecord,
  NestedToolRegistrationInput,
} from "./host.ts";
import {
  loadOutputArtifact,
  OutputArtifactUnavailableError,
  saveOutputArtifact,
} from "./output-artifacts.ts";
import type {
  LoadedOutputArtifact,
  OutputArtifactReference,
} from "./output-artifacts.ts";
import { renderOutputText, renderScriptText } from "./rendering.ts";
import { DEFAULT_TIMEOUT_SECS, SandboxRunner } from "./runner.ts";
import type { OutputSpool, RunResult, RunStatus } from "./runner.ts";

export {
  loadOutputArtifact,
  OutputArtifactUnavailableError,
  saveOutputArtifact,
} from "./output-artifacts.ts";
export type {
  LoadedOutputArtifact,
  OutputArtifactIdentity,
  OutputArtifactReference,
} from "./output-artifacts.ts";

const sourceReferenceParameters = Type.Object(
  {
    artifactId: Type.String({
      description: "Content-addressed Python artifact ID",
      pattern: "^(?:[a-f\\d]{16}|[a-f\\d]{64})\\.py$",
    }),
    lines: Type.Integer({
      description: "Exact source line count",
      minimum: 1,
    }),
    sha256: Type.String({
      description: "Full SHA-256 digest, or a legacy digest prefix",
      pattern: "^[a-f\\d]{12,64}$",
    }),
    toolCallId: Type.Optional(
      Type.String({ description: "Original code_execution call ID used for recovery" }),
    ),
  },
  {
    additionalProperties: false,
    description: "Verified reference to a saved code_execution source",
  },
);

const outputReferenceParameters = Type.Object(
  {
    artifactId: Type.String({
      description: "Metadata-bound output artifact ID",
      pattern: "^[a-f\\d]{64}\\.out$",
    }),
    emittedBytes: Type.Integer({
      description: "Exact UTF-8 bytes emitted by the canonical transcript",
      minimum: 1,
    }),
    lines: Type.Integer({
      description: "Exact lines emitted by the canonical transcript",
      minimum: 1,
    }),
    retainedBytes: Type.Integer({
      description: "Exact UTF-8 bytes retained in the artifact",
      minimum: 1,
    }),
    retainedLines: Type.Integer({
      description: "Exact lines retained in the artifact",
      minimum: 1,
    }),
    sha256: Type.String({
      description: "SHA-256 digest of the retained canonical transcript",
      pattern: "^[a-f\\d]{64}$",
    }),
    toolCallId: Type.String({
      description: "Original code_execution call ID",
      minLength: 1,
    }),
    truncated: Type.Boolean({
      description: "Whether artifact retention omitted emitted output",
    }),
  },
  {
    additionalProperties: false,
    description: "Portable verified reference to retained code execution output",
  },
);

const parameters = Type.Object(
  {
    code: Type.Optional(
      Type.String({
        description:
          "Fresh Python code to execute. Supply either code or sourceRef, never both. Full CPython and PEP 723 dependencies are supported.",
        maxLength: 200_000,
      }),
    ),
    sourceRef: Type.Optional(sourceReferenceParameters),
    timeout: Type.Optional(
      Type.Integer({
        description: "Script execution timeout in seconds (default 30)",
        maximum: 300,
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

const outputParameters = Type.Object(
  {
    outputRef: outputReferenceParameters,
    offset: Type.Optional(
      Type.Integer({
        description: "UTF-8 byte offset to start reading from (default 0)",
        minimum: 0,
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: "Maximum UTF-8 output bytes to return (default 20480, minimum 4)",
        maximum: MAX_CODE_EXECUTION_OUTPUT_BYTES,
        minimum: 4,
      }),
    ),
  },
  { additionalProperties: false },
);

const sourceParameters = Type.Object(
  {
    sourceRef: sourceReferenceParameters,
    offset: Type.Optional(
      Type.Integer({
        description: "UTF-8 byte offset to start reading from (default 0)",
        minimum: 0,
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: "Maximum UTF-8 source bytes to return (default 20480, minimum 4)",
        maximum: MAX_CODE_EXECUTION_OUTPUT_BYTES,
        minimum: 4,
      }),
    ),
  },
  { additionalProperties: false },
);

export type CodeExecutionInput = Static<typeof parameters>;
export type CodeExecutionOutputInput = Static<typeof outputParameters>;
export type CodeExecutionSourceInput = Static<typeof sourceParameters>;

export type NestedToolCallRecord = HostNestedToolCallRecord;

export interface CodeExecutionFinalDetails {
  durationMs: number;
  exitCode?: number;
  nestedCalls: NestedToolCallRecord[];
  outputRef?: OutputArtifactReference;
  signal?: string;
  sourceRef: CodeArtifactReference;
  status: RunStatus;
  stderrBytes: number;
  stderrTruncated: boolean;
  stdoutBytes: number;
  stdoutTruncated: boolean;
}

export interface CodeExecutionRunningDetails {
  sourceRef: CodeArtifactReference;
  status: "running";
}

export type CodeExecutionDetails = CodeExecutionFinalDetails | CodeExecutionRunningDetails;

export interface CodeExecutionOutputDetails {
  artifactId: string;
  chunk?: string;
  emittedBytes: number;
  lines: number;
  nextOffset?: number;
  offset: number;
  output: string;
  retainedBytes: number;
  retainedLines: number;
  sha256: string;
  toolCallId: string;
  truncated: boolean;
  unavailable?: boolean;
}

export interface CodeExecutionSourceDetails {
  artifactId: string;
  nextOffset?: number;
  offset: number;
  output: string;
  source?: string;
  totalBytes?: number;
  totalLines: number;
}

const UNAVAILABLE_ARTIFACT_OUTPUT =
  "Historical code source is unavailable. Do not retry this reference. Write and execute a fresh script instead.";
const UNAVAILABLE_OUTPUT_ARTIFACT =
  "Historical code execution output is unavailable. Do not retry this reference. Rerun the source only if repeating its side effects is safe.";
const LIVE_STREAM_SEPARATOR_BYTES = Buffer.byteLength("\n[stderr]\n", "utf-8");
const MAX_LIVE_STREAM_BYTES = Math.floor(
  (MAX_CODE_EXECUTION_OUTPUT_BYTES - LIVE_STREAM_SEPARATOR_BYTES) / 2,
);

export const NESTED_TOOL_CALL_EVENT = "code_execution:tool_call";

export interface NestedToolCallInterception {
  block?: boolean;
  cwd: string;
  input: Record<string, unknown>;
  reason?: string;
  toolName: string;
}

type ContextMessage = ContextEvent["messages"][number];

const recoverArtifactSource = (
  reference: CodeArtifactReference,
  ctx: ExtensionContext,
): string | undefined => {
  const candidates: { code: string; id: string }[] = [];
  const collectCandidates = (messages: ContextMessage[]): void => {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const block of message.content) {
        if (
          block.type === "toolCall" &&
          block.name === "code_execution" &&
          typeof block.arguments.code === "string" &&
          !isRedactedCodePlaceholder(block.arguments.code)
        ) {
          candidates.push({ code: block.arguments.code, id: block.id });
        }
      }
    }
  };

  collectCandidates(
    ctx.sessionManager
      .getEntries()
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : [])) as ContextMessage[],
  );

  const ordered = reference.toolCallId
    ? [
        ...candidates.filter(({ id }) => id === reference.toolCallId),
        ...candidates.filter(({ id }) => id !== reference.toolCallId),
      ]
    : candidates;
  return ordered.find(({ code }) => {
    const lines = code.split(/\r?\n/u).length;
    return lines === reference.lines && codeDigest(code).startsWith(reference.sha256);
  })?.code;
};

const resolveArtifactSource = async (
  reference: CodeArtifactReference,
  ctx: ExtensionContext,
  saveArtifact: (code: string) => Promise<string>,
  loadArtifact: (reference: CodeArtifactReference) => Promise<LoadedCodeArtifact>,
): Promise<LoadedCodeArtifact | undefined> => {
  try {
    return await loadArtifact(reference);
  } catch (error) {
    if (!(error instanceof CodeArtifactUnavailableError)) throw error;
    const code = recoverArtifactSource(reference, ctx);
    if (code === undefined) return undefined;
    return { artifactId: await saveArtifact(code), code };
  }
};

const BASE_DESCRIPTION = `Execute a Python script and return what it prints.

Use code_execution for chained or dependent work, for filtering verbose output before it enters context, and for anything a real programming language handles better than a shell pipeline. Skip it when one direct tool call needs no transformation, and never use it as a thinking scratchpad; reason in your response text.

Python
- Full CPython with the complete standard library: subprocess, pathlib, re, json, hashlib, sqlite3, urllib, csv, itertools, dataclasses, and the rest. Generators, classes, inheritance, and every formatting style work.
- Top-level \`await\` is allowed; the script runs inside an event loop.
- Do local work directly in Python rather than through agent tools: \`open()\` and \`pathlib\` for files, \`glob\`/\`re\` for searching, and \`subprocess.run([...], capture_output=True, text=True)\` for commands.
- Output is whatever the script prints. There is no implicit result value. Always filter or summarize tool and subprocess output before printing; print only the final relevant result.

Third-party packages
- Declare them in a PEP 723 header at the very top of the script and uv installs them before the run:
\`\`\`python
# /// script
# dependencies = ["httpx", "pandas"]
# ///
\`\`\`
- Cached dependency sets add about 50ms. A set that has never been used costs a download, so raise timeout when pulling something large for the first time.

Agent tools
- Trusted Pi extensions can opt tools into this runner. Each exposed tool is an async function that returns a string: \`result = await tool_name(argument='value')\`. Parse the text yourself.
- Pass arguments as keywords, never positionally.
- Run independent calls concurrently with \`await asyncio.gather(...)\`.
- \`available_tools()\` returns a mapping of callable names to signatures. It is empty when no extension has exposed tools.
- Tool output that Pi truncates for display is recovered automatically up to ${MAX_RECOVERED_TOOL_OUTPUT_BYTES / 1024 / 1024}MB. Larger results fail; filter them at the source.

Saved sources
- Older completed scripts appear in context as a structured \`sourceRef\` instead of repeated source text.
- Pass a \`sourceRef\` unchanged to rerun that exact verified script. Use \`code_execution_source\` first if you need to inspect or modify it.
- Never put a legacy \`<code_execution_source_redacted ...>\` marker in \`code\`; use its structured replacement or write a fresh script.

Saved output
- A completed result can include an \`outputRef\` for retained output omitted from its preview.
- Pass an \`outputRef\` unchanged to \`code_execution_output\`; use its continuation offset to recover long output without rerunning side effects.

Environment: runs with your full privileges in the session working directory (relative paths resolve there) with network access, as a fresh process each call with no state persisting between runs. Default deadline is 30 seconds (maximum 300), covering dependency installation and tool calls.`;

interface NestedToolCallTracker {
  onCall: (identity: NestedToolCallIdentity) => void;
  onOutcome: (outcome: NestedToolCallOutcome) => void;
  records: () => NestedToolCallRecord[];
  waitForSettled: () => Promise<void>;
}

const createNestedToolCallTracker = (): NestedToolCallTracker => {
  const order: string[] = [];
  const records = new Map<string, NestedToolCallRecord>();
  const waiters = new Set<() => void>();
  let pending = 0;
  const settle = (): void => {
    if (pending !== 0) return;
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  return {
    onCall: ({ childToolCallId }) => {
      order.push(childToolCallId);
      pending += 1;
    },
    onOutcome: (outcome) => {
      if (records.has(outcome.childToolCallId)) return;
      records.set(outcome.childToolCallId, createNestedToolCallRecord(outcome));
      pending = Math.max(0, pending - 1);
      settle();
    },
    records: () => order.flatMap((id) => {
      const record = records.get(id);
      return record ? [record] : [];
    }),
    waitForSettled: () =>
      pending === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.add(resolve);
          }),
  };
};

const finalDetails = (
  result: RunResult,
  sourceRef: CodeArtifactReference,
  nestedCalls: NestedToolCallRecord[],
  outputRef?: OutputArtifactReference,
): CodeExecutionFinalDetails => ({
  durationMs: result.durationMs,
  ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
  nestedCalls,
  ...(outputRef ? { outputRef } : {}),
  ...(result.signal === undefined ? {} : { signal: result.signal }),
  sourceRef,
  status: result.status,
  stderrBytes: result.stderrBytes,
  stderrTruncated: result.stderrTruncated,
  stdoutBytes: result.stdoutBytes,
  stdoutTruncated: result.stdoutTruncated,
});

const failureDiagnostics = (result: RunResult): string => {
  const stderr = result.stderr?.trim();
  const diagnostic = result.diagnostic?.trim();
  if (!diagnostic) return stderr ?? `code execution ended with ${result.status}`;
  if (!stderr || diagnostic.includes(stderr)) return diagnostic;
  return `${stderr}\n\n${diagnostic}`;
};

const diagnosticSupplement = (result: RunResult): string | undefined => {
  const diagnostic = result.diagnostic?.trim();
  if (!diagnostic) return undefined;
  const stderr = result.stderr?.trim();
  if (!stderr || !diagnostic.includes(stderr)) return diagnostic;
  const supplement = diagnostic.replace(stderr, "").trim();
  return supplement || undefined;
};

const stderrMarker = (result: RunResult): string =>
  result.stdoutBytes > 0 && !result.stdoutEndsWithNewline
    ? "\n[stderr]\n"
    : "[stderr]\n";

const completeTranscript = (result: RunResult): string =>
  `${result.stdout}${result.stderrBytes > 0 ? stderrMarker(result) + (result.stderr ?? "") : ""}`;

const finalOutput = (
  result: RunResult,
  outputRef: OutputArtifactReference | undefined,
): string => {
  const diagnostics = result.status === "success" ? undefined : diagnosticSupplement(result);
  const exact =
    result.status === "success"
      ? assembleOutput(result.stdout, result.stderr)
      : assembleOutput(result.stdout, failureDiagnostics(result));
  const streamsTruncated =
    result.outputPreview.stdout.truncated || result.outputPreview.stderr.truncated;
  if (
    !streamsTruncated &&
    Buffer.byteLength(exact, "utf-8") <= MAX_CODE_EXECUTION_OUTPUT_BYTES
  ) {
    return exact;
  }
  if (!outputRef) {
    return result.status === "success" ? truncateOutput(exact) : truncateFailureOutput(exact);
  }

  const marker = stderrMarker(result);
  let head: string;
  let tail: string;
  let complete: string | undefined;
  if (!streamsTruncated) {
    complete = completeTranscript(result);
    head = complete;
    tail = complete;
  } else {
    const stdoutPreview = result.outputPreview.stdout;
    const stderrPreview = result.outputPreview.stderr;
    if (result.stderrBytes === 0) {
      head = stdoutPreview.head;
      tail = stdoutPreview.tail;
    } else {
      head =
        result.stdoutBytes === 0
          ? marker + stderrPreview.head
          : stdoutPreview.truncated
            ? stdoutPreview.head
            : result.stdout + marker + stderrPreview.head;
      tail = stderrPreview.truncated
        ? stderrPreview.tail
        : marker + stderrPreview.head;
    }
  }
  return formatHeadTailOutput({
    artifactTruncated: outputRef.truncated,
    ...(complete === undefined ? {} : { complete }),
    ...(diagnostics ? { diagnostic: diagnostics } : {}),
    emittedBytes: outputRef.emittedBytes,
    emittedLines: outputRef.lines,
    head,
    retainedBytes: outputRef.retainedBytes,
    tail,
  });
};

const unavailableDetails = (
  sourceRef: CodeArtifactReference,
  startedAt: number,
): CodeExecutionFinalDetails => ({
  durationMs: performance.now() - startedAt,
  nestedCalls: [],
  sourceRef,
  status: "setup_error",
  stderrBytes: 0,
  stderrTruncated: false,
  stdoutBytes: 0,
  stdoutTruncated: false,
});

const ERROR_STATUSES = new Set<RunStatus>([
  "cancelled",
  "policy_error",
  "runtime_error",
  "setup_error",
  "timeout",
]);

export const codeExecutionResultOverride = (
  toolName: string,
  details: unknown,
): { isError: true } | undefined => {
  if (
    toolName !== "code_execution" ||
    typeof details !== "object" ||
    details === null ||
    !("status" in details) ||
    !ERROR_STATUSES.has(details.status as RunStatus)
  ) {
    return undefined;
  }
  return { isError: true };
};

export const createCodeExecutionTool = (
  runner: SandboxRunner,
  saveArtifact: (code: string) => Promise<string> = saveCodeArtifact,
  getActiveToolNames?: () => string[],
  loadArtifact: (
    reference: CodeArtifactReference,
  ) => Promise<LoadedCodeArtifact> = loadCodeArtifact,
  preflight?: NestedToolCallPreflight,
  getDefinitions: () => NestedToolRegistrationInput[] = () => [],
  saveOutput: (
    spool: OutputSpool,
    toolCallId: string,
  ) => Promise<OutputArtifactReference | undefined> = saveOutputArtifact,
): ToolDefinition<typeof parameters, CodeExecutionDetails> => ({
  description: BASE_DESCRIPTION,
  async execute(toolCallId, input, signal, onUpdate, ctx) {
    const startedAt = performance.now();
    const hasCode = input.code !== undefined;
    const hasSourceRef = input.sourceRef !== undefined;
    if (hasCode === hasSourceRef) {
      throw new Error("Supply exactly one of code or sourceRef");
    }

    const legacyReference =
      typeof input.code === "string" ? parseCodeArtifactReference(input.code) : undefined;
    const reference = input.sourceRef ?? legacyReference;
    let artifactId: string;
    let code: string;
    if (reference) {
      const artifact = await resolveArtifactSource(reference, ctx, saveArtifact, loadArtifact);
      if (!artifact) {
        const sourceRef = { ...reference, toolCallId };
        return {
          content: [{ text: UNAVAILABLE_ARTIFACT_OUTPUT, type: "text" }],
          details: unavailableDetails(sourceRef, startedAt),
        };
      }
      ({ artifactId, code } = artifact);
      // Show the human the source that is actually replayed, not its compact reference.
      input.code = code;
      delete input.sourceRef;
    } else {
      const freshCode = input.code;
      if (freshCode === undefined) {
        throw new Error("Supply exactly one of code or sourceRef");
      }
      if (isRedactedCodePlaceholder(freshCode)) {
        throw new Error(
          "Cannot replay this legacy code_execution placeholder because its artifact ID is unavailable. Write a new script instead.",
        );
      }
      code = freshCode;
      artifactId = await saveArtifact(code);
    }
    const sourceRef = { ...codeSourceReference(code, toolCallId), artifactId };
    let outputRef: OutputArtifactReference | undefined;
    const nestedCallTracker = createNestedToolCallTracker();
    let streamedStdout = "";
    let streamedStderr = "";
    const timeoutSecs = input.timeout ?? DEFAULT_TIMEOUT_SECS;
    const runtimeRegistrations = createBridgedRegistrations(getDefinitions());
    const activeToolNames = new Set(
      getActiveToolNames?.() ??
        runtimeRegistrations.map(({ definition }) => definition.name),
    );
    const activeRegistrations = createPythonRegistrations(runtimeRegistrations).filter(
      ({ registeredName }) => activeToolNames.has(registeredName),
    );
    const toolSignatures = Object.fromEntries(
      activeRegistrations.map(({ definition, pythonName }) => [
        pythonName,
        renderToolSignature({ ...definition, name: pythonName }).replace(/^- /u, ""),
      ]),
    );
    const result = await runner.run(
      code,
      (runSignal) =>
        createHostFunctions(activeRegistrations, ctx, runSignal, preflight, {
          onCall: nestedCallTracker.onCall,
          onOutcome: nestedCallTracker.onOutcome,
          parentToolCallId: toolCallId,
        }),
      ({ stream, text }) => {
        if (stream === "stdout") {
          streamedStdout = appendLiveOutputTail(streamedStdout, text, MAX_LIVE_STREAM_BYTES);
        } else {
          streamedStderr = appendLiveOutputTail(streamedStderr, text, MAX_LIVE_STREAM_BYTES);
        }
        const liveOutput = assembleOutput(streamedStdout, streamedStderr);
        onUpdate?.({
          content: [{ text: liveOutput, type: "text" }],
          details: { sourceRef, status: "running" },
        });
      },
      {
        cwd: ctx.cwd,
        outputSpoolConsumer: async (spool) => {
          outputRef = await saveOutput(spool, toolCallId);
        },
        signal,
        timeoutSecs,
        toolSignatures,
      },
    );
    await nestedCallTracker.waitForSettled();
    const nestedCalls = nestedCallTracker.records();
    const nestedUsage = aggregateNestedToolUsage(nestedCalls);
    const output = finalOutput(result, outputRef);
    return {
      content: [{ text: output, type: "text" }],
      details: finalDetails(result, sourceRef, nestedCalls, outputRef),
      ...(nestedUsage ? { usage: nestedUsage } : {}),
    };
  },
  executionMode: "sequential",
  label: "Code Execution",
  name: "code_execution",
  parameters,
  promptGuidelines: [
    "Use code_execution for dependent or chained tool calls, or to filter and process verbose intermediate output before it enters context; use a direct tool call for one untransformed result.",
    "Always filter or summarize code_execution tool and subprocess output before printing; print only the final relevant result.",
    "Pass a code_execution sourceRef unchanged only to rerun its exact saved script; use code_execution_source before modifying saved source.",
    "Use code_execution_output with an unchanged outputRef to recover retained output without rerunning side effects.",
  ],
  promptSnippet:
    "Run a CPython script (stdlib plus PEP 723 dependencies) for filtering, transformation, and dependent workflows",
  renderCall(input, theme, context) {
    if (input.code === undefined) {
      const lines = input.sourceRef?.lines ?? 0;
      return new Text(
        `${theme.fg("toolTitle", theme.bold("Saved Python"))}${theme.fg(
          "dim",
          ` · ${lines} ${lines === 1 ? "line" : "lines"}`,
        )}`,
        0,
        0,
      );
    }
    return new Text(
      renderScriptText(
        input.code,
        context.expanded,
        theme,
        context.executionStarted && context.isPartial,
      ),
      0,
      0,
    );
  },
  renderResult(result, options, theme, context) {
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    return new Text(
      renderOutputText(
        text,
        options.expanded,
        theme,
        context.isError,
        options.isPartial,
        result.details.status,
      ),
      0,
      0,
    );
  },
});

const OUTPUT_DEFAULT_LIMIT = MAX_CODE_EXECUTION_OUTPUT_BYTES;
const SOURCE_DEFAULT_LIMIT = MAX_CODE_EXECUTION_OUTPUT_BYTES;
const isUtf8ContinuationByte = (byte: number | undefined): boolean =>
  byte !== undefined && byte >= 0x80 && byte <= 0xbf;

const readOutputBytes = async (
  artifact: LoadedOutputArtifact,
  offset: number,
  limit: number,
): Promise<{ bytes: Buffer; nextOffset?: number }> => {
  const totalBytes = artifact.reference.retainedBytes;
  const available = totalBytes - offset;
  const wanted = Math.min(available, limit + 4);
  const buffer = Buffer.alloc(wanted);
  let bytesRead = 0;
  while (bytesRead < wanted) {
    const result = await artifact.handle.read(
      buffer,
      bytesRead,
      wanted - bytesRead,
      offset + bytesRead,
    );
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  if (bytesRead !== wanted) {
    throw new Error("Output artifact ended before its verified retained byte count");
  }
  if (isUtf8ContinuationByte(buffer[0])) {
    throw new Error(
      `Output offset ${offset} is inside a UTF-8 character; use a continuation offset returned by this tool`,
    );
  }

  let length = Math.min(limit, buffer.length);
  while (
    length > 0 &&
    offset + length < totalBytes &&
    isUtf8ContinuationByte(buffer[length])
  ) {
    length -= 1;
  }
  if (length === 0 && offset < totalBytes) {
    length = 1;
    while (length < buffer.length && isUtf8ContinuationByte(buffer[length])) length += 1;
  }
  const end = offset + length;
  return {
    bytes: buffer.subarray(0, length),
    ...(end < totalBytes ? { nextOffset: end } : {}),
  };
};

export const createCodeExecutionOutputTool = (
  loadArtifact: (
    reference: OutputArtifactReference,
  ) => Promise<LoadedOutputArtifact> = loadOutputArtifact,
): ToolDefinition<typeof outputParameters, CodeExecutionOutputDetails> => ({
  description: `Read retained output from a completed code_execution result without rerunning it.

Pass the outputRef unchanged. Reads use UTF-8 byte offsets and return a stable continuation offset. Each chunk is capped at 20 KiB. An unavailable or invalid reference must not be retried; rerun the source only when repeating its side effects is safe.`,
  async execute(_toolCallId, input) {
    const { outputRef } = input;
    const offset = input.offset ?? 0;
    const limit = input.limit ?? OUTPUT_DEFAULT_LIMIT;
    if (limit < 4 || limit > MAX_CODE_EXECUTION_OUTPUT_BYTES) {
      throw new Error(
        `Output limit must be between 4 and ${MAX_CODE_EXECUTION_OUTPUT_BYTES} UTF-8 bytes`,
      );
    }

    let artifact: LoadedOutputArtifact;
    try {
      artifact = await loadArtifact(outputRef);
    } catch (error) {
      if (error instanceof OutputArtifactUnavailableError) {
        return {
          content: [{ text: UNAVAILABLE_OUTPUT_ARTIFACT, type: "text" }],
          details: {
            artifactId: outputRef.artifactId,
            emittedBytes: outputRef.emittedBytes,
            lines: outputRef.lines,
            offset,
            output: UNAVAILABLE_OUTPUT_ARTIFACT,
            retainedBytes: outputRef.retainedBytes,
            retainedLines: outputRef.retainedLines,
            sha256: outputRef.sha256,
            toolCallId: outputRef.toolCallId,
            truncated: outputRef.truncated,
            unavailable: true,
          },
        };
      }
      throw new Error(
        "Output artifact reference is invalid, corrupt, or does not match retained output. Do not retry this reference.",
        { cause: error },
      );
    }

    try {
      if (offset > outputRef.retainedBytes) {
        throw new Error(
          `Output offset ${offset} exceeds its ${outputRef.retainedBytes} retained UTF-8 bytes`,
        );
      }
      const range = await readOutputBytes(artifact, offset, limit);
      let chunk: string;
      try {
        chunk = new TextDecoder("utf-8", { fatal: true }).decode(range.bytes);
      } catch (error) {
        throw new Error(
          "Output artifact contains invalid UTF-8. Do not retry this reference.",
          { cause: error },
        );
      }
      const notice =
        range.nextOffset === undefined
          ? undefined
          : `Output continues at byte offset ${range.nextOffset} of ${outputRef.retainedBytes}`;
      const output = notice ? `${chunk}\n\n[${notice}]` : chunk;
      return {
        content: [
          { text: chunk, type: "text" },
          ...(notice ? [{ text: notice, type: "text" as const }] : []),
        ],
        details: {
          artifactId: outputRef.artifactId,
          chunk,
          emittedBytes: outputRef.emittedBytes,
          lines: outputRef.lines,
          ...(range.nextOffset === undefined ? {} : { nextOffset: range.nextOffset }),
          offset,
          output,
          retainedBytes: outputRef.retainedBytes,
          retainedLines: outputRef.retainedLines,
          sha256: outputRef.sha256,
          toolCallId: outputRef.toolCallId,
          truncated: outputRef.truncated,
        },
      };
    } finally {
      await artifact.handle.close();
    }
  },
  label: "Code Execution Output",
  name: "code_execution_output",
  parameters: outputParameters,
  promptGuidelines: [
    "Use code_execution_output to recover retained output from an outputRef without rerunning side effects; pass the reference unchanged and follow continuation offsets.",
  ],
  promptSnippet: "Read retained output from an earlier code_execution result without rerunning it",
  renderCall(input, theme) {
    const offset = input.offset ?? 0;
    return new Text(
      `${theme.fg("toolTitle", theme.bold("Saved output"))}${theme.fg(
        "dim",
        ` · byte ${offset} of ${input.outputRef.retainedBytes}`,
      )}`,
      0,
      0,
    );
  },
  renderResult(result, options, theme, context) {
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    return new Text(
      renderOutputText(text, options.expanded, theme, context.isError, options.isPartial),
      0,
      0,
    );
  },
});

export const createCodeExecutionSourceTool = (
  saveArtifact: (code: string) => Promise<string> = saveCodeArtifact,
  loadArtifact: (
    reference: CodeArtifactReference,
  ) => Promise<LoadedCodeArtifact> = loadCodeArtifact,
): ToolDefinition<typeof sourceParameters, CodeExecutionSourceDetails> => ({
  description: `Read the verified Python source behind an older code_execution sourceRef without executing it.

Use this before modifying saved source. Pass sourceRef unchanged. Each source chunk is capped at 20 KiB; use UTF-8 byte offset and limit to read a long script in exact sections. A continuation notice is separate from the returned source.`,
  async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
    const { sourceRef } = input;
    const offset = input.offset ?? 0;
    const artifact = await resolveArtifactSource(
      sourceRef,
      ctx,
      saveArtifact,
      loadArtifact,
    );
    if (!artifact) {
      return {
        content: [{ text: UNAVAILABLE_ARTIFACT_OUTPUT, type: "text" }],
        details: {
          artifactId: sourceRef.artifactId,
          offset,
          output: UNAVAILABLE_ARTIFACT_OUTPUT,
          totalLines: sourceRef.lines,
        },
      };
    }

    const bytes = Buffer.from(artifact.code, "utf-8");
    if (offset > bytes.length) {
      throw new Error(`Source offset ${offset} exceeds its ${bytes.length} UTF-8 bytes`);
    }
    if (isUtf8ContinuationByte(bytes[offset])) {
      throw new Error(
        `Source offset ${offset} is inside a UTF-8 character; use a continuation offset returned by this tool`,
      );
    }

    const limit = input.limit ?? SOURCE_DEFAULT_LIMIT;
    if (limit < 4) throw new Error("Source limit must be at least 4 UTF-8 bytes");
    let end = Math.min(offset + limit, bytes.length);
    while (end > offset && end < bytes.length && isUtf8ContinuationByte(bytes[end])) {
      end -= 1;
    }
    if (end === offset && end < bytes.length) {
      end += 1;
      while (end < bytes.length && isUtf8ContinuationByte(bytes[end])) end += 1;
    }

    const source = bytes.subarray(offset, end).toString("utf-8");
    const nextOffset = end < bytes.length ? end : undefined;
    const notice =
      nextOffset === undefined
        ? undefined
        : `Source continues at byte offset ${nextOffset} of ${bytes.length}`;
    const output = notice ? `${source}\n\n[${notice}]` : source;
    return {
      content: [
        { text: source, type: "text" },
        ...(notice ? [{ text: notice, type: "text" as const }] : []),
      ],
      details: {
        artifactId: artifact.artifactId,
        ...(nextOffset === undefined ? {} : { nextOffset }),
        offset,
        output,
        source,
        totalBytes: bytes.length,
        totalLines: artifact.code.split(/\r?\n/u).length,
      },
    };
  },
  label: "Code Execution Source",
  name: "code_execution_source",
  parameters: sourceParameters,
  promptGuidelines: [
    "Use code_execution_source to inspect a saved code_execution sourceRef before modifying it; pass the sourceRef unchanged.",
  ],
  promptSnippet: "Read verified source saved by an older code_execution call without running it",
  renderCall(input, theme) {
    const lines = input.sourceRef.lines;
    return new Text(
      `${theme.fg("toolTitle", theme.bold("Saved Python source"))}${theme.fg(
        "dim",
        ` · ${lines} ${lines === 1 ? "line" : "lines"}`,
      )}`,
      0,
      0,
    );
  },
  renderResult(result, options, theme, context) {
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    return new Text(
      renderOutputText(text, options.expanded, theme, context.isError, options.isPartial),
      0,
      0,
    );
  },
});

export default function codeExecutionExtension(pi: ExtensionAPI): void {
  const runner = new SandboxRunner();
  const preflight: NestedToolCallPreflight = (call) => {
    const event: NestedToolCallInterception = { ...call };
    pi.events.emit(NESTED_TOOL_CALL_EVENT, event);
    if (event.block) {
      throw new Error(event.reason ?? `Nested ${event.toolName} call blocked`);
    }
  };
  const getDefinitions = (): NestedToolRegistrationInput[] => {
    const collection = createToolCollection();
    pi.events.emit(CODE_EXECUTION_COLLECT_TOOLS_EVENT, collection);
    return collection.registrations;
  };
  pi.registerTool(
    createCodeExecutionTool(
      runner,
      saveCodeArtifact,
      () => pi.getActiveTools(),
      loadCodeArtifact,
      preflight,
      getDefinitions,
      saveOutputArtifact,
    ),
  );
  pi.registerTool(createCodeExecutionOutputTool(loadOutputArtifact));
  pi.registerTool(createCodeExecutionSourceTool(saveCodeArtifact, loadCodeArtifact));
  pi.on("tool_result", (event) => codeExecutionResultOverride(event.toolName, event.details));
  pi.on("context", async (event) => {
    await saveContextCodeArtifacts(event.messages);
    return { messages: redactCompletedCodeExecutions(event.messages) };
  });
  pi.on("session_shutdown", async () => {
    await runner.close();
  });
}

export const executeForTest = (
  tool: ToolDefinition<typeof parameters, CodeExecutionDetails>,
  input: CodeExecutionInput,
  ctx: ExtensionContext,
) => tool.execute(crypto.randomUUID(), input, undefined, undefined, ctx);

export const readOutputForTest = (
  tool: ToolDefinition<typeof outputParameters, CodeExecutionOutputDetails>,
  input: CodeExecutionOutputInput,
  ctx: ExtensionContext,
) => tool.execute(crypto.randomUUID(), input, undefined, undefined, ctx);

export const readSourceForTest = (
  tool: ToolDefinition<typeof sourceParameters, CodeExecutionSourceDetails>,
  input: CodeExecutionSourceInput,
  ctx: ExtensionContext,
) => tool.execute(crypto.randomUUID(), input, undefined, undefined, ctx);
