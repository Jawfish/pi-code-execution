import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { codeArtifactId, codeDigest, loadCodeArtifact, saveCodeArtifact } from "./artifacts.ts";
import { codeSourceReference } from "./context.ts";
import { assembleOutput, NO_OUTPUT, truncateOutput } from "./core.ts";
import type { AnyToolDefinition } from "./host.ts";
import {
  createCodeExecutionSourceTool,
  createCodeExecutionTool,
  executeForTest,
  readSourceForTest,
} from "./index.ts";
import type { CodeExecutionInput } from "./index.ts";
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
const saveTestArtifact = (): Promise<string> => Promise.resolve(artifactId);

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
});

describe("code_execution tool", () => {
  test("advertises CPython and optional tool guidance", () => {
    const runner = new SandboxRunner();
    const tool = createCodeExecutionTool(runner);
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
      const result = await executeForTest(tool, input, { cwd: dir } as ExtensionContext);
      const [text] = result.content;
      expect(text?.type === "text" && text.text).toBe("structured-reference");
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

  test("handles missing artifacts without a tool error", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    try {
      const tool = createCodeExecutionTool(runner, undefined, undefined, (reference) =>
        loadCodeArtifact(reference, dir),
      );
      const result = await executeForTest(
        tool,
        {
          code: `<code_execution_source_redacted artifact="${"0".repeat(16)}.py" lines="1" sha256="${"0".repeat(64)}">`,
        },
        {
          cwd: dir,
          sessionManager: { getEntries: () => [] },
        } as unknown as ExtensionContext,
      );
      const [text] = result.content;
      expect(text?.type === "text" && text.text).toContain("Do not retry");

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

  test("stops a script that outlives its timeout", async () => {
    const dir = await tempDir();
    const runner = new SandboxRunner();
    try {
      const tool = createCodeExecutionTool(runner, saveTestArtifact);
      await expect(
        executeForTest(tool, { code: "import time\ntime.sleep(30)", timeout: 1 }, {
          cwd: dir,
        } as ExtensionContext),
      ).rejects.toThrow(/deadline/iu);
    } finally {
      await runner.close();
    }
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
