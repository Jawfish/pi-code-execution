import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { codeArtifactId, codeDigest, loadCodeArtifact, saveCodeArtifact } from "./artifacts.ts";
import { codeSourceReference } from "./context.ts";
import {
  appendLiveOutputTail,
  assembleOutput,
  formatHeadTailOutput,
  NO_OUTPUT,
  truncateFailureOutput,
  truncateOutput,
} from "./core.ts";
import type { AnyToolDefinition, NestedToolCall } from "./host.ts";
import {
  codeExecutionResultOverride,
  createCodeExecutionOutputTool,
  createCodeExecutionSourceTool,
  createCodeExecutionTool as createProductionCodeExecutionTool,
  executeForTest,
  NESTED_TOOL_FINISH_EVENT,
  NESTED_TOOL_START_EVENT,
  readOutputForTest,
  readSourceForTest,
} from "./index.ts";
import type {
  CodeExecutionDetails,
  CodeExecutionFinalDetails,
  CodeExecutionInput,
  NestedToolLifecycleObserver,
} from "./index.ts";
import { loadOutputArtifact, saveOutputArtifact } from "./output-artifacts.ts";
import type { OutputArtifactReference } from "./output-artifacts.ts";
import { SandboxRunner } from "./runner.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

const tempDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-code-execution-index-"));
  dirs.push(dir);
  return dir;
};

const retainOutput = async (
  root: string,
  code: string,
  toolCallId = "retained-output",
): Promise<OutputArtifactReference> => {
  const runner = new SandboxRunner();
  let outputRef: OutputArtifactReference | undefined;
  try {
    await runner.run(code, {}, undefined, {
      outputSpoolConsumer: async (spool) => {
        outputRef = await saveOutputArtifact(spool, toolCallId, root);
      },
    });
  } finally {
    await runner.close();
  }
  if (!outputRef) throw new Error("expected retained output");
  return outputRef;
};

const artifactId = "0123456789abcdef.py";
const saveTestArtifact = (code: string): Promise<string> => Promise.resolve(codeArtifactId(code));

type CreateToolParameters = Parameters<typeof createProductionCodeExecutionTool>;
const createCodeExecutionTool = (
  runner: CreateToolParameters[0],
  saveArtifact: CreateToolParameters[1] = saveTestArtifact,
  getActiveToolNames?: CreateToolParameters[2],
  loadArtifact?: CreateToolParameters[3],
  preflight?: CreateToolParameters[4],
  getDefinitions?: CreateToolParameters[5],
  lifecycleObserver?: NestedToolLifecycleObserver,
) =>
  createProductionCodeExecutionTool(
    runner,
    saveArtifact,
    getActiveToolNames,
    loadArtifact,
    preflight,
    getDefinitions,
    () => Promise.resolve(undefined),
    lifecycleObserver,
  );

const createArtifactCodeExecutionTool = (
  runner: SandboxRunner,
  sourceRoot: string,
  outputRoot: string,
  getActiveToolNames?: CreateToolParameters[2],
  preflight?: CreateToolParameters[4],
  getDefinitions?: CreateToolParameters[5],
) =>
  createProductionCodeExecutionTool(
    runner,
    (code) => saveCodeArtifact(code, sourceRoot),
    getActiveToolNames,
    (reference) => loadCodeArtifact(reference, sourceRoot),
    preflight,
    getDefinitions,
    (spool, toolCallId) => saveOutputArtifact(spool, toolCallId, outputRoot),
  );

const expectFinalDetails = (details: CodeExecutionDetails): CodeExecutionFinalDetails => {
  expect(details.status).not.toBe("running");
  if (details.status === "running") throw new Error("expected final code execution details");
  return details;
};

const definition = (name: string): AnyToolDefinition =>
  ({
    description: name,
    execute: (_id: string, input: { query: string }) =>
      Promise.resolve({
        content: [{ text: `${name}:${input.query}`, type: "text" }],
        details: {},
      }),
    label: name,
    name,
    parameters: Type.Object({ query: Type.String() }),
  }) as AnyToolDefinition;

describe("output formatting", () => {
  test("returns stdout and successful stderr", () => {
    expect(assembleOutput("hello\n")).toBe("hello");
    expect(assembleOutput("", "warning\n")).toBe("[stderr]\nwarning");
    expect(assembleOutput("hello\n", "warning\n")).toBe("hello\n[stderr]\nwarning");
    expect(assembleOutput("")).toBe(NO_OUTPUT);
  });

  test("truncates oversized output", () => {
    const output = truncateOutput(`${"line\n".repeat(2100)}end`);
    expect(output).toContain("[Output truncated:");
    expect(output).not.toContain("end");
  });

  test("keeps a preview when the first line exceeds the byte limit", () => {
    const output = truncateOutput("x".repeat(60_000));
    expect(output.startsWith("x".repeat(100))).toBeTrue();
    expect(output).toContain("showing the first 20480 of 60000 bytes");
  });

  test("keeps a bounded UTF-8 live tail", () => {
    const output = appendLiveOutputTail("alpha\nbeta\n", "gamma\ndelta\n", 14);
    expect(Buffer.byteLength(output, "utf-8")).toBeLessThanOrEqual(14);
    expect(output).toEndWith("gamma\ndelta\n");
    expect(output).not.toContain("alpha");
  });

  test("renders bounded head-tail metadata and artifact recovery", () => {
    const output = formatHeadTailOutput({
      artifactTruncated: true,
      diagnostic: "RuntimeError: tail-visible",
      emittedBytes: 100_000,
      emittedLines: 200,
      head: "head\n".repeat(3000),
      retainedBytes: 64_000,
      tail: "tail\n".repeat(3000),
    });
    expect(Buffer.byteLength(output, "utf-8")).toBeLessThanOrEqual(20 * 1024);
    expect(output).toStartWith("head");
    expect(output).toContain("omitted");
    expect(output).toContain("100000 emitted bytes across 200 lines");
    expect(output).toContain("64000 of 100000 emitted bytes");
    expect(output).toContain("36000 bytes cannot be recovered");
    expect(output).toEndWith("RuntimeError: tail-visible");
  });

  test("keeps both failure output and its diagnostic tail", () => {
    const output = truncateFailureOutput(
      `${"stdout-line\n".repeat(3000)}[stderr]\nRuntimeError: tail-visible`,
    );
    expect(Buffer.byteLength(output, "utf-8")).toBeLessThanOrEqual(20 * 1024);
    expect(output).toStartWith("stdout-line");
    expect(output).toContain("[Output truncated:");
    expect(output).toEndWith("RuntimeError: tail-visible");
  });
});

describe("code_execution tool", () => {
  test("advertises CPython and optional tool guidance", () => {
    const runner = new SandboxRunner();
    const tool = createCodeExecutionTool(runner);
    expect(tool.executionMode).toBe("sequential");
    expect(tool.description).toContain("Trusted Pi extensions can opt tools");
    expect(tool.description).toContain("empty when no extension has exposed tools");
    // Filesystem and shell work is done with the standard library instead.
    expect(tool.description).not.toContain("- read(");
    expect(tool.description).not.toContain("- bash(");
    expect(tool.description).toContain("Full CPython");
    expect(tool.description).toContain("PEP 723");
    expect(tool.description).toContain("# /// script");
    expect(tool.description).toContain("Top-level `await` is allowed");
    expect(tool.description).toContain("subprocess.run");
    expect(tool.description).toContain("await asyncio.gather");
    expect(tool.description).toContain("available_tools()");
    expect(tool.description).not.toContain("MCP");
    expect(tool.description).toContain(
      "Always filter or summarize tool and subprocess output before printing",
    );
    expect(tool.description).toContain("recovered automatically up to 5MB");
    expect(tool.description).toContain("structured `sourceRef`");
    expect(tool.description).toContain("Never put a legacy");
    expect(tool.description).toContain("`outputRef`");
    expect(tool.description).toContain("without rerunning side effects");
    expect(tool.description).not.toContain("Typical pattern:");
    expect(tool.description).toContain("reason in your response text");
    expect(tool.promptGuidelines).toEqual([
      expect.stringContaining("use a direct tool call for one untransformed result"),
      expect.stringContaining("filter or summarize"),
      expect.stringContaining("sourceRef unchanged"),
      expect.stringContaining("unchanged outputRef"),
    ]);
    void runner.close();
  });

  test("assembles bounded live updates from both output channels", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    const tool = createCodeExecutionTool(runner, saveTestArtifact);
    const code = [
      "import sys",
      "print('out', flush=True)",
      "print('warning', file=sys.stderr, flush=True)",
    ].join("\n");
    const updates: string[] = [];
    const updateDetails: CodeExecutionDetails[] = [];
    try {
      const result = await tool.execute(
        "live-output",
        { code },
        undefined,
        (update) => {
          const text = update.content.find((item) => item.type === "text")?.text;
          if (text) updates.push(text);
          updateDetails.push(update.details);
        },
        { cwd: dir } as ExtensionContext,
      );
      expect(result.content[0]).toEqual({ text: "out\n[stderr]\nwarning", type: "text" });
      expect(updates.some((output) => output === "out\n[stderr]\nwarning")).toBeTrue();
      expect(updates.every((output) => Buffer.byteLength(output) <= 20 * 1024)).toBeTrue();
      expect(updateDetails.length).toBeGreaterThan(0);
      expect(
        updateDetails.every(
          (details) =>
            details.status === "running" &&
            details.sourceRef.toolCallId === "live-output" &&
            !("output" in details),
        ),
      ).toBeTrue();
      expect(expectFinalDetails(result.details)).toEqual({
        durationMs: expect.any(Number),
        exitCode: 0,
        nestedCalls: [],
        sourceRef: codeSourceReference(code, "live-output"),
        status: "success",
        stderrBytes: 8,
        stderrTruncated: false,
        stdoutBytes: 4,
        stdoutTruncated: false,
      });
      expect("artifactId" in result.details).toBeFalse();
      expect("output" in result.details).toBeFalse();
    } finally {
      await runner.close();
    }
  });

  test("keeps live updates rolling after final stdout capture fills", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    const tool = createCodeExecutionTool(runner, saveTestArtifact);
    const updates: string[] = [];
    try {
      await tool.execute(
        "rolling-output",
        {
          code: [
            "import sys",
            "for index in range(3000):",
            "    print(f'line-{index:04}')",
            "print('warning', file=sys.stderr, flush=True)",
          ].join("\n"),
        },
        undefined,
        (update) => {
          const text = update.content.find((item) => item.type === "text")?.text;
          if (text) updates.push(text);
        },
        { cwd: dir } as ExtensionContext,
      );
      expect(updates.every((output) => Buffer.byteLength(output) <= 20 * 1024)).toBeTrue();
      expect(updates.some((output) => output.includes("line-2999"))).toBeTrue();
      expect(updates.some((output) => output.includes("[stderr]\nwarning"))).toBeTrue();
    } finally {
      await runner.close();
    }
  });

  test("exposes only active tools and reports their signatures", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    const search = definition("search_issues");
    try {
      const inactiveTool = createCodeExecutionTool(
        runner,
        saveTestArtifact,
        () => [],
        undefined,
        undefined,
        () => [search],
      );
      const inactive = await executeForTest(
        inactiveTool,
        {
          code: [
            "print(available_tools())",
            "try:",
            "    await search_issues(query='bug')",
            "except NameError:",
            "    print('disabled')",
          ].join("\n"),
        },
        { cwd: dir } as ExtensionContext,
      );
      expect(inactive.content[0]).toEqual({
        text: "{}\ndisabled",
        type: "text",
      });

      const activeTool = createCodeExecutionTool(
        runner,
        saveTestArtifact,
        () => ["search_issues"],
        undefined,
        undefined,
        () => [search],
      );
      const active = await executeForTest(
        activeTool,
        {
          code: [
            "print(available_tools()['search_issues'])",
            "print(await search_issues(query='bug'))",
          ].join("\n"),
        },
        { cwd: dir } as ExtensionContext,
      );
      expect(active.content[0]).toEqual({
        text: "search_issues(query: str) -> str\nsearch_issues:bug",
        type: "text",
      });
    } finally {
      await runner.close();
    }
  });

  test("keeps parent, child, registered, and Python tool identities", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    const executed = new Map<string, string>();
    const policyCalls: NestedToolCall[] = [];
    const nestedDefinition = (name: string, delayMs: number): AnyToolDefinition =>
      ({
        description: name,
        execute: async (id: string, input: { query: string }) => {
          executed.set(name, id);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return {
            content: [{ text: `${name}:${input.query}`, type: "text" }],
            details: {},
          };
        },
        label: name,
        name,
        parameters: Type.Object({ query: Type.String() }),
      }) as AnyToolDefinition;
    const definitions = [
      nestedDefinition("Kagi/search", 40),
      nestedDefinition("Kagi.search", 5),
      nestedDefinition("open", 1),
    ];
    const tool = createCodeExecutionTool(
      runner,
      saveTestArtifact,
      () => definitions.map(({ name }) => name),
      undefined,
      (call) => {
        policyCalls.push(call);
      },
      () => definitions,
    );
    try {
      const result = await tool.execute(
        "identity-parent",
        {
          code: [
            "import asyncio",
            "values = await asyncio.gather(",
            "    Kagi_search(query='slow'),",
            "    Kagi_search_2(query='fast'),",
            "    tool_open(query='reserved'),",
            ")",
            "print('|'.join(values))",
          ].join("\n"),
        },
        undefined,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      expect(result.content[0]).toEqual({
        text: "Kagi/search:slow|Kagi.search:fast|open:reserved",
        type: "text",
      });
      const nestedCalls = expectFinalDetails(result.details).nestedCalls;
      expect(nestedCalls.map(({ registeredName }) => registeredName)).toEqual([
        "Kagi/search",
        "Kagi.search",
        "open",
      ]);
      expect(nestedCalls.map(({ pythonName }) => pythonName)).toEqual([
        "Kagi_search",
        "Kagi_search_2",
        "tool_open",
      ]);
      expect(nestedCalls.every(({ parentToolCallId }) => parentToolCallId === "identity-parent"))
        .toBeTrue();
      expect(new Set(nestedCalls.map(({ childToolCallId }) => childToolCallId)).size).toBe(3);
      for (const call of nestedCalls) {
        const executedId = executed.get(call.registeredName);
        if (!executedId) throw new Error(`missing execution ID for ${call.registeredName}`);
        expect(call.childToolCallId).toBe(executedId);
      }
      expect(
        policyCalls.map(
          ({ childToolCallId, parentToolCallId, pythonName, registeredName, toolName }) => ({
            childToolCallId,
            parentToolCallId,
            pythonName,
            registeredName,
            toolName,
          }),
        ),
      ).toEqual(
        nestedCalls.map(
          ({ childToolCallId, parentToolCallId, pythonName, registeredName }) => ({
            childToolCallId,
            parentToolCallId,
            pythonName,
            registeredName,
            toolName: registeredName,
          }),
        ),
      );
    } finally {
      await runner.close();
    }
  });

  test("emits bounded nested start and finish observations", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    const search = definition("Kagi/search");
    const starts: Parameters<NonNullable<NestedToolLifecycleObserver["onStart"]>>[0][] = [];
    const finishes: Parameters<NonNullable<NestedToolLifecycleObserver["onFinish"]>>[0][] = [];
    const tool = createCodeExecutionTool(
      runner,
      saveTestArtifact,
      () => ["Kagi/search"],
      undefined,
      undefined,
      () => [search],
      {
        onFinish: (record) => finishes.push(record),
        onStart: (record) => starts.push(record),
      },
    );
    try {
      const result = await tool.execute(
        "observed-parent",
        { code: "print(await Kagi_search(query='🙂' * 2000))" },
        undefined,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      expect(NESTED_TOOL_START_EVENT).toBe("code_execution:nested_tool_start");
      expect(NESTED_TOOL_FINISH_EVENT).toBe("code_execution:nested_tool_finish");
      expect(starts).toHaveLength(1);
      expect(finishes).toHaveLength(1);
      const start = starts[0];
      const finish = finishes[0];
      if (!start || !finish) throw new Error("expected lifecycle observations");
      expect(start).toMatchObject({
        inputPreview: { truncated: true },
        parentToolCallId: "observed-parent",
        pythonName: "Kagi_search",
        registeredName: "Kagi/search",
      });
      expect(finish).toMatchObject({
        parentToolCallId: "observed-parent",
        resultPreview: { truncated: true },
        status: "success",
      });
      expect(start.childToolCallId).toBe(finish.childToolCallId);
      expect(Buffer.byteLength(start.inputPreview.text, "utf-8")).toBeLessThanOrEqual(4096);
      expect(Buffer.byteLength(finish.resultPreview?.text ?? "", "utf-8"))
        .toBeLessThanOrEqual(4096);
      expect("input" in start).toBeFalse();
      expect("result" in finish).toBeFalse();
      expect(expectFinalDetails(result.details).nestedCalls).toEqual(finishes);
    } finally {
      await runner.close();
    }
  });

  test("records bounded nested outcomes and aggregates usage once", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    const approvals: string[] = [];
    const sideEffects: string[] = [];
    const usage = (factor: number) => ({
      cacheRead: 3 * factor,
      cacheWrite: 4 * factor,
      cacheWrite1h: 5 * factor,
      cost: {
        cacheRead: 0.03 * factor,
        cacheWrite: 0.04 * factor,
        input: 0.01 * factor,
        output: 0.02 * factor,
        total: 0.1 * factor,
      },
      input: factor,
      output: 2 * factor,
      reasoning: 6 * factor,
      totalTokens: 10 * factor,
    });
    const nestedDefinition = (
      name: string,
      delayMs: number,
      execute: (input: { payload: string }) => Promise<string>,
      nestedUsage?: ReturnType<typeof usage>,
    ): AnyToolDefinition =>
      ({
        description: name,
        execute: async (_id: string, input: { payload: string }) => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          const text = await execute(input);
          return {
            content: [{ text, type: "text" }],
            details: {},
            ...(nestedUsage ? { usage: nestedUsage } : {}),
          };
        },
        label: name,
        name,
        parameters: Type.Object({ payload: Type.String() }),
      }) as AnyToolDefinition;
    const definitions = [
      nestedDefinition(
        "mutate",
        30,
        async ({ payload }) => {
          sideEffects.push("mutated");
          return `mutated:${payload}`;
        },
        usage(1),
      ),
      nestedDefinition("meter", 5, async ({ payload }) => `metered:${payload}`, usage(2)),
      nestedDefinition("fail", 1, async ({ payload }) => {
        throw new Error(`nested failure:${payload}`);
      }),
    ];
    const tool = createCodeExecutionTool(
      runner,
      saveTestArtifact,
      () => definitions.map(({ name }) => name),
      undefined,
      undefined,
      () =>
        definitions.map((nestedDefinition) => ({
          before: async (call: NestedToolCall) => {
            await Promise.resolve();
            approvals.push(call.registeredName);
          },
          definition: nestedDefinition,
        })),
    );
    try {
      const result = await tool.execute(
        "nested-outcomes",
        {
          code: [
            "import asyncio",
            "payload = '🙂' * 2000",
            "await asyncio.gather(",
            "    mutate(payload=payload),",
            "    meter(payload=payload),",
            ")",
            "try:",
            "    await meter(payload=7)",
            "except RuntimeError:",
            "    pass",
            "try:",
            "    await fail(payload='z' * 5000)",
            "except RuntimeError:",
            "    pass",
            "raise RuntimeError('outer failure after side effects')",
          ].join("\n"),
        },
        undefined,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      expect(expectFinalDetails(result.details).status).toBe("runtime_error");
      expect(approvals).toEqual(["mutate", "meter", "fail"]);
      expect(sideEffects).toEqual(["mutated"]);
      const calls = expectFinalDetails(result.details).nestedCalls;
      expect(calls.map(({ registeredName }) => registeredName)).toEqual([
        "mutate",
        "meter",
        "meter",
        "fail",
      ]);
      expect(calls.map(({ status }) => status)).toEqual([
        "success",
        "success",
        "validation_error",
        "failed",
      ]);
      expect(calls.every(({ durationMs }) => durationMs >= 0 && Number.isFinite(durationMs)))
        .toBeTrue();
      expect(calls.every(({ startedAt }) => !Number.isNaN(Date.parse(startedAt)))).toBeTrue();
      expect(calls[0]?.inputPreview).toMatchObject({ truncated: true });
      expect(calls[0]?.resultPreview).toMatchObject({ truncated: true });
      expect(calls[3]?.errorPreview).toMatchObject({ truncated: true });
      for (const call of calls) {
        expect(Buffer.byteLength(call.inputPreview.text, "utf-8")).toBeLessThanOrEqual(4096);
        if (call.resultPreview) {
          expect(Buffer.byteLength(call.resultPreview.text, "utf-8")).toBeLessThanOrEqual(4096);
        }
        if (call.errorPreview) {
          expect(Buffer.byteLength(call.errorPreview.text, "utf-8")).toBeLessThanOrEqual(4096);
        }
      }
      expect(calls[0]?.usage).toEqual(usage(1));
      expect(calls[1]?.usage).toEqual(usage(2));
      expect(calls[2]?.usage).toBeUndefined();
      expect(calls[3]?.usage).toBeUndefined();
      expect(result.usage).toEqual(usage(3));
    } finally {
      await runner.close();
    }
  });

  test("keeps active nested records on timeout and cancellation", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    let started: (() => void) | undefined;
    let nestedStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const quick = definition("quick");
    const slow = {
      ...definition("slow"),
      execute: (() => {
        started?.();
        return new Promise(() => undefined);
      }) as AnyToolDefinition["execute"],
    } as AnyToolDefinition;
    const tool = createCodeExecutionTool(
      runner,
      saveTestArtifact,
      () => ["quick", "slow"],
      undefined,
      undefined,
      () => [quick, slow],
    );
    try {
      const timeout = await tool.execute(
        "nested-timeout",
        {
          code: "await quick(query='done')\nawait slow(query='wait')",
          timeout: 1,
        },
        undefined,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      expect(expectFinalDetails(timeout.details)).toMatchObject({
        nestedCalls: [
          {
            parentToolCallId: "nested-timeout",
            registeredName: "quick",
            status: "success",
          },
          {
            parentToolCallId: "nested-timeout",
            registeredName: "slow",
            status: "cancelled",
          },
        ],
        status: "timeout",
      });

      started = undefined;
      nestedStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const controller = new AbortController();
      const cancelledPromise = tool.execute(
        "nested-cancelled",
        {
          code: "await quick(query='done')\nawait slow(query='wait')",
          timeout: 30,
        },
        controller.signal,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      await nestedStarted;
      controller.abort(new Error("cancel nested integration"));
      const cancelled = await cancelledPromise;
      expect(expectFinalDetails(cancelled.details)).toMatchObject({
        nestedCalls: [
          {
            parentToolCallId: "nested-cancelled",
            registeredName: "quick",
            status: "success",
          },
          {
            parentToolCallId: "nested-cancelled",
            registeredName: "slow",
            status: "cancelled",
          },
        ],
        status: "cancelled",
      });
    } finally {
      await runner.close();
    }
  });

  test("replays verified current and path-bearing legacy artifacts", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    const source = "print('restored-source')";
    const savedArtifactId = await saveCodeArtifact(source, dir);
    const file = path.join(dir, savedArtifactId);
    const digest = codeDigest(source);
    let saveCalls = 0;
    try {
      const tool = createCodeExecutionTool(
        runner,
        () => {
          saveCalls += 1;
          return Promise.resolve(artifactId);
        },
        undefined,
        (reference) => loadCodeArtifact(reference, dir),
      );
      const inputs = [
        {
          code: `<code_execution_source_redacted artifact="${savedArtifactId}" lines="1" sha256="${digest}">`,
        },
        {
          code: `# previous code_execution source saved to ${file} (1 lines, sha256:${digest.slice(0, 12)})`,
        },
      ];
      for (const input of inputs) {
        const result = await executeForTest(tool, input, {
          cwd: dir,
        } as ExtensionContext);
        const [text] = result.content;
        expect(text?.type === "text" && text.text).toBe("restored-source");
        expect(input.code).toBe(source);
      }
      expect(saveCalls).toBe(0);
    } finally {
      await runner.close();
    }
  });

  test("replays a structured sourceRef as exact verified source", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    const source = "print('structured-reference')";
    await saveCodeArtifact(source, dir);
    const input: CodeExecutionInput = { sourceRef: codeSourceReference(source, "original") };
    try {
      const tool = createCodeExecutionTool(
        runner,
        undefined,
        undefined,
        (reference) => loadCodeArtifact(reference, dir),
      );
      const result = await tool.execute(
        "replay-call",
        input,
        undefined,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      const [text] = result.content;
      expect(text?.type === "text" && text.text).toBe("structured-reference");
      expect(expectFinalDetails(result.details).sourceRef).toEqual(
        codeSourceReference(source, "replay-call"),
      );
      expect(input.code).toBe(source);
      expect(input.sourceRef).toBeUndefined();
    } finally {
      await runner.close();
    }
  });

  test("requires exactly one inline source or sourceRef", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    const tool = createCodeExecutionTool(runner, saveTestArtifact);
    const sourceRef = codeSourceReference("print('old')");
    try {
      await expect(
        executeForTest(tool, {}, { cwd: dir } as ExtensionContext),
      ).rejects.toThrow(/exactly one/iu);
      await expect(
        executeForTest(tool, { code: "print('new')", sourceRef }, {
          cwd: dir,
        } as ExtensionContext),
      ).rejects.toThrow(/exactly one/iu);
    } finally {
      await runner.close();
    }
  });

  test("still throws internal artifact failures", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    const tool = createCodeExecutionTool(runner, () =>
      Promise.reject(new Error("artifact store failed")),
    );
    try {
      await expect(
        executeForTest(tool, { code: "print('never')" }, {
          cwd: dir,
        } as ExtensionContext),
      ).rejects.toThrow("artifact store failed");
    } finally {
      await runner.close();
    }
  });

  test("recovers a missing artifact from its original session tool call", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    const source = "print('recovered-from-session')";
    const reference = `<code_execution_source_redacted artifact="${codeArtifactId(source)}" tool_call_id="original" lines="1" sha256="${codeDigest(source)}">`;
    try {
      const tool = createCodeExecutionTool(
        runner,
        (code) => saveCodeArtifact(code, dir),
        undefined,
        (artifact) => loadCodeArtifact(artifact, dir),
      );
      const result = await executeForTest(tool, { code: reference }, {
        cwd: dir,
        sessionManager: {
          getEntries: () => [
            {
              message: {
                content: [
                  {
                    arguments: { code: source },
                    id: "original",
                    name: "code_execution",
                    type: "toolCall",
                  },
                ],
                role: "assistant",
              },
              type: "message",
            },
          ],
        },
      } as unknown as ExtensionContext);
      const [text] = result.content;
      expect(text?.type === "text" && text.text).toBe("recovered-from-session");
    } finally {
      await runner.close();
    }
  });

  test("returns structured setup details for an unavailable source", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    try {
      const tool = createCodeExecutionTool(runner, undefined, undefined, (reference) =>
        loadCodeArtifact(reference, dir),
      );
      const sourceRef = {
        artifactId: `${"0".repeat(16)}.py`,
        lines: 1,
        sha256: "0".repeat(64),
      };
      const result = await tool.execute(
        "missing-call",
        { sourceRef },
        undefined,
        undefined,
        {
          cwd: dir,
          sessionManager: { getEntries: () => [] },
        } as unknown as ExtensionContext,
      );
      const [text] = result.content;
      expect(text?.type === "text" && text.text).toContain("Do not retry");
      expect(expectFinalDetails(result.details)).toEqual({
        durationMs: expect.any(Number),
        nestedCalls: [],
        sourceRef: { ...sourceRef, toolCallId: "missing-call" },
        status: "setup_error",
        stderrBytes: 0,
        stderrTruncated: false,
        stdoutBytes: 0,
        stdoutTruncated: false,
      });

      await expect(
        executeForTest(
          tool,
          {
            code: "# code omitted after execution (1 lines, sha256:abc123)",
          },
          { cwd: dir } as ExtensionContext,
        ),
      ).rejects.toThrow(/artifact ID is unavailable/iu);
    } finally {
      await runner.close();
    }
  });

  test("allows ordinary scripts that mention placeholder text", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    try {
      const tool = createCodeExecutionTool(runner, saveTestArtifact);
      const result = await executeForTest(
        tool,
        {
          code: `print("# previous code_execution source saved to /old/machine/old.py (1 lines, sha256:abc123)")`,
        },
        { cwd: dir } as ExtensionContext,
      );
      const [text] = result.content;
      expect(text?.type === "text" && text.text).toContain("previous code_execution source");
    } finally {
      await runner.close();
    }
  });

  test("filters files with the standard library and returns only the result", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "a.txt"), "keep alpha\ndrop beta");
    await writeFile(path.join(dir, "b.txt"), "drop gamma\nkeep delta");
    const runner = new SandboxRunner();
    try {
      const tool = createCodeExecutionTool(runner, saveTestArtifact);
      const result = await executeForTest(
        tool,
        {
          code: [
            "import pathlib",
            "",
            "for file in sorted(pathlib.Path('.').glob('*.txt')):",
            "    for line in file.read_text().splitlines():",
            "        if line.startswith('keep'):",
            "            print(line)",
          ].join("\n"),
        },
        { cwd: dir } as ExtensionContext,
      );
      const [text] = result.content;
      expect(text?.type).toBe("text");
      if (text?.type === "text") {
        expect(text.text).toBe("keep alpha\nkeep delta");
        expect(text.text).not.toContain("drop");
      }
    } finally {
      await runner.close();
    }
  });

  test("processes subprocess output far beyond the display limit", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    try {
      const tool = createCodeExecutionTool(runner, saveTestArtifact);
      const result = await executeForTest(
        tool,
        {
          code: [
            "import subprocess, sys",
            "",
            "out = subprocess.run(",
            "    [sys.executable, '-c', \"import sys; sys.stdout.buffer.write(b'x' * 60000)\"],",
            "    capture_output=True,",
            ").stdout",
            "print(len(out))",
          ].join("\n"),
        },
        { cwd: dir } as ExtensionContext,
      );
      const [text] = result.content;
      expect(text?.type === "text" && text.text).toBe("60000");
    } finally {
      await runner.close();
    }
  });

  test("preserves the true size when direct output is truncated twice", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    try {
      const tool = createCodeExecutionTool(runner, saveTestArtifact);
      const result = await executeForTest(tool, { code: "print('x' * 60000)" }, {
        cwd: dir,
      } as ExtensionContext);
      const [text] = result.content;
      expect(text?.type === "text" && text.text).toContain(
        "showing the first 20480 of 60001 bytes",
      );
    } finally {
      await runner.close();
    }
  });

  test("attaches output artifacts and reconstructs mixed output exactly", async () => {
    const dir = await tempDir();
    const sourceRoot = path.join(dir, "sources");
    const outputRoot = path.join(dir, "outputs");
    const runner = new SandboxRunner();
    const tool = createArtifactCodeExecutionTool(runner, sourceRoot, outputRoot);
    const stdout = `HEAD-${"x".repeat(30_000)}-STDOUT-TAIL\n`;
    const stderr = "STDERR-TAIL\n";
    const code = [
      "import sys",
      `sys.stdout.write(${JSON.stringify(stdout)})`,
      "sys.stdout.flush()",
      `sys.stderr.write(${JSON.stringify(stderr)})`,
      "sys.stderr.flush()",
    ].join("\n");
    try {
      const result = await tool.execute(
        "mixed-artifact",
        { code },
        undefined,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      const details = expectFinalDetails(result.details);
      const outputRef = details.outputRef;
      expect(outputRef).toBeDefined();
      if (!outputRef) throw new Error("expected outputRef");
      const expected = `${stdout}[stderr]\n${stderr}`;
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(20 * 1024);
      expect(text).toStartWith("HEAD-");
      expect(text).toContain("STDERR-TAIL");
      expect(text).toContain(
        `${Buffer.byteLength(expected, "utf-8")} emitted bytes across 3 lines`,
      );
      expect(text).toContain("code_execution_output using outputRef");
      expect(details).toMatchObject({
        outputRef: {
          emittedBytes: Buffer.byteLength(expected, "utf-8"),
          lines: 3,
          retainedBytes: Buffer.byteLength(expected, "utf-8"),
          toolCallId: "mixed-artifact",
          truncated: false,
        },
        sourceRef: codeSourceReference(code, "mixed-artifact"),
        status: "success",
      });
      expect(JSON.stringify(details)).not.toContain(dir);

      const outputTool = createCodeExecutionOutputTool((reference) =>
        loadOutputArtifact(reference, outputRoot),
      );
      const chunks: string[] = [];
      let offset = 0;
      for (;;) {
        const page = await readOutputForTest(
          outputTool,
          { offset, outputRef },
          { cwd: dir } as ExtensionContext,
        );
        chunks.push(page.details?.chunk ?? "");
        if (page.details?.nextOffset === undefined) break;
        offset = page.details.nextOffset;
      }
      expect(chunks.join("")).toBe(expected);

      await rm(path.join(outputRoot, outputRef.artifactId));
      const replay = await tool.execute(
        "mixed-replay",
        { sourceRef: details.sourceRef },
        undefined,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      expect(expectFinalDetails(replay.details)).toMatchObject({
        outputRef: { toolCallId: "mixed-replay" },
        sourceRef: { toolCallId: "mixed-replay" },
        status: "success",
      });

      const empty = await tool.execute(
        "empty-output",
        { code: "value = 1" },
        undefined,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      expect(empty.content[0]).toEqual({ text: NO_OUTPUT, type: "text" });
      expect(expectFinalDetails(empty.details).outputRef).toBeUndefined();

      const stderrOnly = await tool.execute(
        "stderr-only",
        { code: "import sys\nprint('warning only', file=sys.stderr)" },
        undefined,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      const stderrOnlyRef = expectFinalDetails(stderrOnly.details).outputRef;
      if (!stderrOnlyRef) throw new Error("expected stderr outputRef");
      const stderrArtifact = await loadOutputArtifact(stderrOnlyRef, outputRoot);
      try {
        expect(await stderrArtifact.handle.readFile("utf-8")).toBe(
          "[stderr]\nwarning only\n",
        );
      } finally {
        await stderrArtifact.handle.close();
      }
    } finally {
      await runner.close();
    }
  });

  test("attaches output artifacts to expected failures", async () => {
    const dir = await tempDir();
    const sourceRoot = path.join(dir, "sources");
    const outputRoot = path.join(dir, "outputs");
    const runner = new SandboxRunner();
    const tool = createArtifactCodeExecutionTool(runner, sourceRoot, outputRoot);
    try {
      const runtime = await tool.execute(
        "artifact-runtime",
        { code: "print('before failure', flush=True)\nraise RuntimeError('boom')" },
        undefined,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      expect(expectFinalDetails(runtime.details)).toMatchObject({
        outputRef: { toolCallId: "artifact-runtime" },
        status: "runtime_error",
      });
      expect(runtime.content[0]?.type === "text" && runtime.content[0].text).toContain(
        "RuntimeError: boom",
      );

      const timeout = await tool.execute(
        "artifact-timeout",
        { code: "print('before timeout', flush=True)\nwhile True:\n    pass", timeout: 1 },
        undefined,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      expect(expectFinalDetails(timeout.details)).toMatchObject({
        outputRef: { toolCallId: "artifact-timeout" },
        status: "timeout",
      });

      const controller = new AbortController();
      const cancelled = await tool.execute(
        "artifact-cancelled",
        { code: "import time\nprint('before cancel', flush=True)\ntime.sleep(30)" },
        controller.signal,
        (update) => {
          if (
            update.content.some(
              (item) => item.type === "text" && item.text.includes("before cancel"),
            )
          ) {
            controller.abort(new Error("cancel artifact test"));
          }
        },
        { cwd: dir } as ExtensionContext,
      );
      expect(expectFinalDetails(cancelled.details)).toMatchObject({
        outputRef: { toolCallId: "artifact-cancelled" },
        status: "cancelled",
      });
    } finally {
      await runner.close();
    }
  });

  test("marks output beyond the default retention ceiling", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    const tool = createArtifactCodeExecutionTool(
      runner,
      path.join(dir, "sources"),
      path.join(dir, "outputs"),
    );
    const emittedBytes = 64 * 1024 * 1024 + 1;
    try {
      const result = await tool.execute(
        "artifact-ceiling",
        {
          code: `import sys\nsys.stdout.buffer.write(b'x' * ${emittedBytes})\nsys.stdout.flush()`,
          timeout: 30,
        },
        undefined,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      const details = expectFinalDetails(result.details);
      expect(details.outputRef).toMatchObject({
        emittedBytes,
        retainedBytes: 64 * 1024 * 1024,
        toolCallId: "artifact-ceiling",
        truncated: true,
      });
      if (!details.outputRef) throw new Error("expected ceiling outputRef");
      expect((await stat(path.join(dir, "outputs", details.outputRef.artifactId))).size).toBe(
        64 * 1024 * 1024,
      );
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(20 * 1024);
      expect(text).toContain("Output artifact truncated");
      expect(text).toContain("1 bytes cannot be recovered");
    } finally {
      await runner.close();
    }
  }, 40_000);

  test("returns retained output and complete runtime details", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    const tool = createCodeExecutionTool(runner, saveTestArtifact);
    const code = "print('important stdout', flush=True)\nraise RuntimeError('boom')";
    try {
      const result = await tool.execute(
        "runtime-call",
        { code },
        undefined,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      const text = result.content.find((item) => item.type === "text")?.text ?? "";
      expect(text).toContain("important stdout");
      expect(text).toContain("[stderr]\nTraceback");
      expect(text).toContain("RuntimeError: boom");
      expect(expectFinalDetails(result.details)).toMatchObject({
        durationMs: expect.any(Number),
        exitCode: 1,
        nestedCalls: [],
        sourceRef: codeSourceReference(code, "runtime-call"),
        status: "runtime_error",
        stderrTruncated: false,
        stdoutBytes: 17,
        stdoutTruncated: false,
      });

      const syntax = await tool.execute(
        "syntax-call",
        { code: "def" },
        undefined,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      expect(expectFinalDetails(syntax.details).status).toBe("runtime_error");
      expect(syntax.content[0]?.type === "text" && syntax.content[0].text).toContain(
        "SyntaxError",
      );
    } finally {
      await runner.close();
    }
  });

  test("keeps failure diagnostics when retained output is truncated", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    const tool = createCodeExecutionTool(runner, saveTestArtifact);
    try {
      const result = await executeForTest(
        tool,
        { code: "print('x' * 60000, flush=True)\nraise RuntimeError('tail-visible')" },
        { cwd: dir } as ExtensionContext,
      );
      const text = result.content.find((item) => item.type === "text")?.text ?? "";
      expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(20 * 1024);
      expect(text).toContain("[Output truncated:");
      expect(text).toContain("RuntimeError: tail-visible");
      expect(expectFinalDetails(result.details)).toMatchObject({
        status: "runtime_error",
        stdoutBytes: 60_001,
        stdoutTruncated: true,
      });
    } finally {
      await runner.close();
    }
  });

  test("returns complete setup details for spawn and dependency failures", async () => {
    const dir = await tempDir();
    const missingRunner = new SandboxRunner("pi-code-execution-no-such-uv");
    const dependencyRunner = new SandboxRunner();
    try {
      const missingTool = createCodeExecutionTool(missingRunner, saveTestArtifact);
      const missing = await missingTool.execute(
        "missing-uv",
        { code: "print('never')" },
        undefined,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      expect(expectFinalDetails(missing.details)).toEqual({
        durationMs: expect.any(Number),
        nestedCalls: [],
        sourceRef: codeSourceReference("print('never')", "missing-uv"),
        status: "setup_error",
        stderrBytes: 0,
        stderrTruncated: false,
        stdoutBytes: 0,
        stdoutTruncated: false,
      });
      expect(missing.content[0]?.type === "text" && missing.content[0].text).toContain(
        "needs the `pi-code-execution-no-such-uv` command",
      );

      const dependencyCode = [
        "# /// script",
        '# dependencies = ["pi-code-execution-no-such-package-4d7f22"]',
        "# ///",
        "print('never')",
      ].join("\n");
      const dependencyTool = createCodeExecutionTool(dependencyRunner, saveTestArtifact);
      const dependency = await dependencyTool.execute(
        "dependency-error",
        { code: dependencyCode, timeout: 15 },
        undefined,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      expect(expectFinalDetails(dependency.details)).toMatchObject({
        exitCode: 1,
        sourceRef: codeSourceReference(dependencyCode, "dependency-error"),
        status: "setup_error",
        stdoutBytes: 0,
        stdoutTruncated: false,
      });
      expect(
        dependency.content[0]?.type === "text" && dependency.content[0].text,
      ).toContain("could not resolve the dependencies");
    } finally {
      await Promise.all([missingRunner.close(), dependencyRunner.close()]);
    }
  });

  test("returns complete cancellation details with retained output", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    const tool = createCodeExecutionTool(runner, saveTestArtifact);
    const controller = new AbortController();
    const code = "import time\nprint('ready', flush=True)\ntime.sleep(30)";
    try {
      const result = await tool.execute(
        "cancel-call",
        { code },
        controller.signal,
        (update) => {
          if (
            !controller.signal.aborted &&
            update.content.some((item) => item.type === "text" && item.text.includes("ready"))
          ) {
            controller.abort(new Error("test cancellation"));
          }
        },
        { cwd: dir } as ExtensionContext,
      );
      const text = result.content.find((item) => item.type === "text")?.text ?? "";
      expect(text).toContain("ready");
      expect(text).toContain("cancelled");
      expect(expectFinalDetails(result.details)).toMatchObject({
        exitCode: 143,
        sourceRef: codeSourceReference(code, "cancel-call"),
        status: "cancelled",
        stdoutBytes: 6,
        stdoutTruncated: false,
      });
    } finally {
      await runner.close();
    }
  });

  test("returns policy details when nested preflight blocks a call", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    const search = definition("search_issues");
    const tool = createCodeExecutionTool(
      runner,
      saveTestArtifact,
      () => ["search_issues"],
      undefined,
      () => {
        throw new Error("blocked by test policy");
      },
      () => [search],
    );
    try {
      const result = await tool.execute(
        "policy-call",
        { code: "await search_issues(query='x')" },
        undefined,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      expect(expectFinalDetails(result.details)).toMatchObject({
        nestedCalls: [
          {
            parentToolCallId: "policy-call",
            registeredName: "search_issues",
            status: "blocked",
          },
        ],
        status: "policy_error",
        stderrTruncated: false,
        stdoutBytes: 0,
        stdoutTruncated: false,
      });
      expect(result.content[0]?.type === "text" && result.content[0].text).toContain(
        "blocked by test policy",
      );
    } finally {
      await runner.close();
    }
  });

  test("keeps Python-specific hints in structured failure output", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    const search = definition("search_issues");
    const tool = createCodeExecutionTool(
      runner,
      saveTestArtifact,
      () => ["search_issues"],
      undefined,
      undefined,
      () => [search],
    );
    try {
      const result = await executeForTest(
        tool,
        {
          code: "value = search_issues(query='x')\nprint(value.get('items'))",
        },
        { cwd: dir } as ExtensionContext,
      );
      expect(expectFinalDetails(result.details).status).toBe("runtime_error");
      expect(result.content[0]?.type === "text" && result.content[0].text).toContain(
        "Tools are async",
      );
    } finally {
      await runner.close();
    }
  });

  test("returns timeout details instead of throwing them away", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    const code = "import time\ntime.sleep(30)";
    try {
      const tool = createCodeExecutionTool(runner, saveTestArtifact);
      const result = await tool.execute(
        "timeout-call",
        { code, timeout: 1 },
        undefined,
        undefined,
        { cwd: dir } as ExtensionContext,
      );
      expect(expectFinalDetails(result.details)).toMatchObject({
        sourceRef: codeSourceReference(code, "timeout-call"),
        status: "timeout",
        stderrTruncated: false,
        stdoutTruncated: false,
      });
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(text).toMatch(/deadline/iu);
      expect(text).toContain("Raise timeout");
    } finally {
      await runner.close();
    }
  });

  test("marks only final non-success code execution results as errors", () => {
    for (const status of [
      "cancelled",
      "policy_error",
      "runtime_error",
      "setup_error",
      "timeout",
    ]) {
      expect(codeExecutionResultOverride("code_execution", { status })).toEqual({
        isError: true,
      });
    }
    expect(codeExecutionResultOverride("code_execution", { status: "success" })).toBeUndefined();
    expect(codeExecutionResultOverride("code_execution", { status: "running" })).toBeUndefined();
    expect(codeExecutionResultOverride("read", { status: "runtime_error" })).toBeUndefined();
  });
});

describe("code_execution_output tool", () => {
  test("recovers paged UTF-8 output byte-for-byte", async () => {
    const dir = await tempDir();
    const root = path.join(dir, "output-artifacts");
    const expected = "abcé🙂tail\n";
    const outputRef = await retainOutput(
      root,
      `import sys\nsys.stdout.write(${JSON.stringify(expected)})\nsys.stdout.flush()`,
    );
    const tool = createCodeExecutionOutputTool((reference) =>
      loadOutputArtifact(reference, root),
    );
    const chunks: string[] = [];
    const offsets: number[] = [];
    let offset = 0;
    for (;;) {
      const result = await readOutputForTest(
        tool,
        { limit: 4, offset, outputRef },
        { cwd: dir } as ExtensionContext,
      );
      const chunk = result.details?.chunk ?? "";
      chunks.push(chunk);
      offsets.push(result.details?.offset ?? -1);
      expect(Buffer.byteLength(chunk, "utf-8")).toBeLessThanOrEqual(4);
      expect(result.content[0]).toEqual({ text: chunk, type: "text" });
      expect(result.details).toMatchObject({
        artifactId: outputRef.artifactId,
        emittedBytes: outputRef.emittedBytes,
        lines: outputRef.lines,
        retainedBytes: outputRef.retainedBytes,
        retainedLines: outputRef.retainedLines,
        truncated: false,
      });
      const nextOffset = result.details?.nextOffset;
      if (nextOffset === undefined) break;
      expect(nextOffset).toBeGreaterThan(offset);
      expect(result.content[1]).toEqual({
        text: `Output continues at byte offset ${nextOffset} of ${outputRef.retainedBytes}`,
        type: "text",
      });
      offset = nextOffset;
    }
    expect(chunks.join("")).toBe(expected);
    expect(Buffer.from(chunks.join(""), "utf-8")).toEqual(Buffer.from(expected, "utf-8"));
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
  });

  test("rejects unsafe ranges and changed references", async () => {
    const dir = await tempDir();
    const root = path.join(dir, "output-artifacts");
    const outputRef = await retainOutput(
      root,
      "import sys\nsys.stdout.write('abcé🙂')\nsys.stdout.flush()",
    );
    const tool = createCodeExecutionOutputTool((reference) =>
      loadOutputArtifact(reference, root),
    );
    const context = { cwd: dir } as ExtensionContext;

    await expect(
      readOutputForTest(tool, { limit: 4, offset: 4, outputRef }, context),
    ).rejects.toThrow(/inside a UTF-8 character/iu);
    await expect(
      readOutputForTest(
        tool,
        { offset: outputRef.retainedBytes + 1, outputRef },
        context,
      ),
    ).rejects.toThrow(/exceeds/iu);
    await expect(
      readOutputForTest(tool, { limit: 3, outputRef }, context),
    ).rejects.toThrow(/between 4 and 20480/iu);
    await expect(
      readOutputForTest(
        tool,
        {
          outputRef: {
            ...outputRef,
            emittedBytes: outputRef.emittedBytes + 1,
            truncated: true,
          },
        },
        context,
      ),
    ).rejects.toThrow(/invalid, corrupt, or does not match/iu);
  });

  test("distinguishes unavailable and corrupt output artifacts", async () => {
    const dir = await tempDir();
    const root = path.join(dir, "output-artifacts");
    const unavailableRef = await retainOutput(root, "print('unavailable')", "missing-call");
    const tool = createCodeExecutionOutputTool((reference) =>
      loadOutputArtifact(reference, root),
    );
    await rm(path.join(root, unavailableRef.artifactId));
    const unavailable = await readOutputForTest(
      tool,
      { outputRef: unavailableRef },
      { cwd: dir } as ExtensionContext,
    );
    expect(unavailable.content[0]?.type === "text" && unavailable.content[0].text).toContain(
      "unavailable",
    );
    expect(unavailable.content[0]?.type === "text" && unavailable.content[0].text).toContain(
      "Do not retry",
    );
    expect(unavailable.details?.unavailable).toBeTrue();

    const corruptRef = await retainOutput(root, "print('corrupt')", "corrupt-call");
    await writeFile(path.join(root, corruptRef.artifactId), "changed");
    await expect(
      readOutputForTest(
        tool,
        { outputRef: corruptRef },
        { cwd: dir } as ExtensionContext,
      ),
    ).rejects.toThrow(/invalid, corrupt, or does not match/iu);
  });

  test("advertises recovery and ships its public artifact module", async () => {
    const tool = createCodeExecutionOutputTool();
    expect(tool.name).toBe("code_execution_output");
    expect(tool.description).toContain("Pass the outputRef unchanged");
    expect(tool.description).toContain("continuation offset");
    expect(tool.promptGuidelines).toEqual([
      expect.stringContaining("without rerunning side effects"),
    ]);
    expect(typeof tool.renderCall).toBe("function");
    expect(typeof tool.renderResult).toBe("function");

    const manifest = JSON.parse(await readFile("package.json", "utf-8")) as {
      exports: Record<string, string>;
      files: string[];
    };
    expect(manifest.files).toContain("output-artifacts.ts");
    expect(manifest.exports["./output-artifacts"]).toBe("./output-artifacts.ts");
  });
});

describe("code_execution_source tool", () => {
  test("reads verified saved source without executing it", async () => {
    const dir = await tempDir();
    const source = "raise RuntimeError('must not run')\r\nprint('second')";
    await saveCodeArtifact(source, dir);
    const tool = createCodeExecutionSourceTool(
      (code) => saveCodeArtifact(code, dir),
      (reference) => loadCodeArtifact(reference, dir),
    );
    const result = await readSourceForTest(
      tool,
      { sourceRef: codeSourceReference(source) },
      { cwd: dir } as ExtensionContext,
    );
    expect(result.content[0]).toEqual({ text: source, type: "text" });
    expect(result.details?.source).toBe(source);
  });

  test("reads saved source in exact UTF-8 byte ranges", async () => {
    const dir = await tempDir();
    const source = "abcéd";
    await saveCodeArtifact(source, dir);
    const tool = createCodeExecutionSourceTool(
      (code) => saveCodeArtifact(code, dir),
      (reference) => loadCodeArtifact(reference, dir),
    );
    const sourceRef = codeSourceReference(source);
    const first = await readSourceForTest(
      tool,
      { limit: 4, sourceRef },
      { cwd: dir } as ExtensionContext,
    );
    expect(first.content).toEqual([
      { text: "abc", type: "text" },
      { text: "Source continues at byte offset 3 of 6", type: "text" },
    ]);
    expect(first.details?.nextOffset).toBe(3);

    const second = await readSourceForTest(
      tool,
      { offset: first.details?.nextOffset, sourceRef },
      { cwd: dir } as ExtensionContext,
    );
    expect(second.content[0]).toEqual({ text: "éd", type: "text" });

    await expect(
      readSourceForTest(tool, { offset: 4, sourceRef }, {
        cwd: dir,
      } as ExtensionContext),
    ).rejects.toThrow(/inside a UTF-8 character/iu);
    await expect(
      readSourceForTest(tool, { limit: 3, sourceRef }, {
        cwd: dir,
      } as ExtensionContext),
    ).rejects.toThrow(/at least 4 UTF-8 bytes/iu);
  });

  test("reports a missing saved source once", async () => {
    const dir = await tempDir();
    const sourceRef = {
      artifactId: `${"0".repeat(64)}.py`,
      lines: 1,
      sha256: "0".repeat(64),
    };
    const tool = createCodeExecutionSourceTool(undefined, (reference) =>
      loadCodeArtifact(reference, dir),
    );
    const result = await readSourceForTest(tool, { sourceRef }, {
      cwd: dir,
      sessionManager: { getEntries: () => [] },
    } as unknown as ExtensionContext);
    const [text] = result.content;
    expect(text?.type === "text" && text.text).toContain("Do not retry");
  });
});
