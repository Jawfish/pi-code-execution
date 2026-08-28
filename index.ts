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
  isRedactedCodePlaceholder,
  parseCodeArtifactReference,
  redactCompletedCodeExecutions,
  saveContextCodeArtifacts,
} from "./context.ts";
import {
  appendLiveOutputTail,
  assembleOutput,
  MAX_CODE_EXECUTION_OUTPUT_BYTES,
  truncateOutput,
} from "./core.ts";
import {
  CODE_EXECUTION_COLLECT_TOOLS_EVENT,
  createBridgedDefinitions,
  createHostFunctions,
  createPythonDefinitions,
  createToolCollection,
  MAX_RECOVERED_TOOL_OUTPUT_BYTES,
  renderToolSignature,
} from "./host.ts";
import type { AnyToolDefinition, NestedToolCallPreflight } from "./host.ts";
import { renderOutputText, renderScriptText } from "./rendering.ts";
import { DEFAULT_TIMEOUT_SECS, SandboxRunner } from "./runner.ts";

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
export type CodeExecutionSourceInput = Static<typeof sourceParameters>;

export interface CodeExecutionDetails {
  artifactId: string;
  output: string;
}

export interface CodeExecutionSourceDetails extends CodeExecutionDetails {
  nextOffset?: number;
  offset: number;
  source?: string;
  totalBytes?: number;
  totalLines: number;
}

const UNAVAILABLE_ARTIFACT_OUTPUT =
  "Historical code source is unavailable. Do not retry this reference. Write and execute a fresh script instead.";
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

Environment: runs with your full privileges in the session working directory (relative paths resolve there) with network access, as a fresh process each call with no state persisting between runs. Default deadline is 30 seconds (maximum 300), covering dependency installation and tool calls.`;

export const createCodeExecutionTool = (
  runner: SandboxRunner,
  saveArtifact: (code: string) => Promise<string> = saveCodeArtifact,
  getActiveToolNames?: () => string[],
  loadArtifact: (
    reference: CodeArtifactReference,
  ) => Promise<LoadedCodeArtifact> = loadCodeArtifact,
  preflight?: NestedToolCallPreflight,
  getDefinitions: () => AnyToolDefinition[] = () => [],
): ToolDefinition<typeof parameters, CodeExecutionDetails> => ({
  description: BASE_DESCRIPTION,
  async execute(_toolCallId, input, signal, onUpdate, ctx) {
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
        return {
          content: [{ text: UNAVAILABLE_ARTIFACT_OUTPUT, type: "text" }],
          details: {
            artifactId: reference.artifactId,
            output: UNAVAILABLE_ARTIFACT_OUTPUT,
          },
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
    let streamedStdout = "";
    let streamedStderr = "";
    const timeoutSecs = input.timeout ?? DEFAULT_TIMEOUT_SECS;
    const runtimeDefinitions = createBridgedDefinitions(getDefinitions());
    const activeToolNames = new Set(
      getActiveToolNames?.() ?? runtimeDefinitions.map(({ name }) => name),
    );
    const activeDefinitions = createPythonDefinitions(runtimeDefinitions).filter(
      (_definition, index) => activeToolNames.has(runtimeDefinitions[index]?.name ?? ""),
    );
    const toolSignatures = Object.fromEntries(
      activeDefinitions.map((definition) => [
        definition.name,
        renderToolSignature(definition).replace(/^- /u, ""),
      ]),
    );
    const result = await runner.run(
      code,
      (runSignal) => createHostFunctions(activeDefinitions, ctx, runSignal, preflight),
      ({ stream, text }) => {
        if (stream === "stdout") {
          streamedStdout = appendLiveOutputTail(streamedStdout, text, MAX_LIVE_STREAM_BYTES);
        } else {
          streamedStderr = appendLiveOutputTail(streamedStderr, text, MAX_LIVE_STREAM_BYTES);
        }
        const liveOutput = assembleOutput(streamedStdout, streamedStderr);
        onUpdate?.({
          content: [{ text: liveOutput, type: "text" }],
          details: { artifactId, output: liveOutput },
        });
      },
      { cwd: ctx.cwd, signal, timeoutSecs, toolSignatures },
    );
    const output = truncateOutput(assembleOutput(result.stdout, result.stderr));
    return {
      content: [{ text: output, type: "text" }],
      details: { artifactId, output },
    };
  },
  label: "Code Execution",
  name: "code_execution",
  parameters,
  promptGuidelines: [
    "Use code_execution for dependent or chained tool calls, or to filter and process verbose intermediate output before it enters context; use a direct tool call for one untransformed result.",
    "Always filter or summarize code_execution tool and subprocess output before printing; print only the final relevant result.",
    "Pass a code_execution sourceRef unchanged only to rerun its exact saved script; use code_execution_source before modifying saved source.",
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
      renderOutputText(text, options.expanded, theme, context.isError, options.isPartial),
      0,
      0,
    );
  },
});

const SOURCE_DEFAULT_LIMIT = MAX_CODE_EXECUTION_OUTPUT_BYTES;
const isUtf8ContinuationByte = (byte: number | undefined): boolean =>
  byte !== undefined && byte >= 0x80 && byte <= 0xbf;

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
  const getDefinitions = (): AnyToolDefinition[] => {
    const collection = createToolCollection();
    pi.events.emit(CODE_EXECUTION_COLLECT_TOOLS_EVENT, collection);
    return collection.definitions;
  };
  pi.registerTool(
    createCodeExecutionTool(
      runner,
      saveCodeArtifact,
      () => pi.getActiveTools(),
      loadCodeArtifact,
      preflight,
      getDefinitions,
    ),
  );
  pi.registerTool(createCodeExecutionSourceTool(saveCodeArtifact, loadCodeArtifact));
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

export const readSourceForTest = (
  tool: ToolDefinition<typeof sourceParameters, CodeExecutionSourceDetails>,
  input: CodeExecutionSourceInput,
  ctx: ExtensionContext,
) => tool.execute(crypto.randomUUID(), input, undefined, undefined, ctx);
