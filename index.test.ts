import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { codeArtifactId, codeDigest, loadCodeArtifact, saveCodeArtifact } from "./artifacts.ts";
import { codeSourceReference } from "./context.ts";
import {
  appendLiveOutputTail,
  assembleOutput,
  NO_OUTPUT,
  truncateFailureOutput,
  truncateOutput,
} from "./core.ts";
import type { AnyToolDefinition } from "./host.ts";
import {
  codeExecutionResultOverride,
  createCodeExecutionSourceTool,
  createCodeExecutionTool,
  executeForTest,
  readSourceForTest,
} from "./index.ts";
import type {
  CodeExecutionDetails,
  CodeExecutionFinalDetails,
  CodeExecutionInput,
} from "./index.ts";
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

const artifactId = "0123456789abcdef.py";
const saveTestArtifact = (code: string): Promise<string> => Promise.resolve(codeArtifactId(code));

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
    expect(tool.description).not.toContain("Typical pattern:");
    expect(tool.description).toContain("reason in your response text");
    expect(tool.promptGuidelines).toEqual([
      expect.stringContaining("use a direct tool call for one untransformed result"),
      expect.stringContaining("filter or summarize"),
      expect.stringContaining("sourceRef unchanged"),
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
