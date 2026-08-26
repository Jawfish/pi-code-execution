import type {
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
import { assembleOutput, truncateOutput } from "./core.ts";
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

const parameters = Type.Object(
  {
    code: Type.String({
      description:
        "Python code to execute. Full CPython with the standard library; declare third-party packages in a PEP 723 header. Agent tools are async functions returning strings, so you MUST await every tool call and parse the text yourself. Top-level await is allowed. Always filter or summarize tool and subprocess output before printing; print only the final relevant result.",
      maxLength: 200_000,
    }),
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

export type CodeExecutionInput = Static<typeof parameters>;

export interface CodeExecutionDetails {
  artifactId: string;
  output: string;
}

const UNAVAILABLE_ARTIFACT_OUTPUT =
  "Historical code source is unavailable. Do not retry this reference. Write and execute a fresh script instead.";

export const NESTED_TOOL_CALL_EVENT = "code_execution:tool_call";

export interface NestedToolCallInterception {
  block?: boolean;
  cwd: string;
  input: Record<string, unknown>;
  reason?: string;
  toolName: string;
}

const recoverArtifactSource = (
  reference: CodeArtifactReference,
  ctx: ExtensionContext,
): string | undefined => {
  const candidates: { code: string; id: string }[] = [];
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }
    for (const block of entry.message.content) {
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

Environment: runs with your full privileges in the session working directory (relative paths resolve there) with network access, as a fresh process each call with no state persisting between runs. Default deadline is 30 seconds (maximum 300), covering dependency installation and tool calls. Never pass a \`<code_execution_source_redacted ...>\` reference back as code; it represents historical context, not Python source, so write a fresh script instead.`;

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
    let { code } = input;
    const reference = parseCodeArtifactReference(code);
    let artifactId: string;
    if (reference) {
      try {
        const artifact = await loadArtifact(reference);
        ({ artifactId, code } = artifact);
      } catch (error) {
        if (!(error instanceof CodeArtifactUnavailableError)) {
          throw error;
        }
        const recovered = recoverArtifactSource(reference, ctx);
        if (!recovered) {
          return {
            content: [{ text: UNAVAILABLE_ARTIFACT_OUTPUT, type: "text" }],
            details: {
              artifactId: reference.artifactId,
              output: UNAVAILABLE_ARTIFACT_OUTPUT,
            },
          };
        }
        code = recovered;
        artifactId = await saveArtifact(code);
      }
      // Show the human the source that is actually replayed, not its compact reference.
      input.code = code;
    } else {
      if (isRedactedCodePlaceholder(code)) {
        throw new Error(
          "Cannot replay this legacy code_execution placeholder because its artifact ID is unavailable. Write a new script instead.",
        );
      }
      artifactId = await saveArtifact(code);
    }
    let streamed = "";
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
      (line) => {
        streamed += line;
        onUpdate?.({
          content: [{ text: truncateOutput(streamed), type: "text" }],
          details: { artifactId, output: streamed },
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
  ],
  promptSnippet:
    "Run a CPython script (stdlib plus PEP 723 dependencies) for filtering, transformation, and dependent workflows",
  renderCall(input, theme, context) {
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
