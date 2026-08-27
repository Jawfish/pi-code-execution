import { describe, expect, test } from "bun:test";

import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import {
  codePlaceholder,
  codeSourceReference,
  isRedactedCodePlaceholder,
  parseCodeArtifactReference,
  redactCompletedCodeExecutions,
} from "./context.ts";

type ContextMessages = ContextEvent["messages"];

const messages = (value: unknown[]): ContextMessages => value as ContextMessages;

const toolCall = (id: string, name: string, code: string) => ({
  arguments: { code },
  id,
  name,
  type: "toolCall",
});

const assistant = (...content: unknown[]) => ({ content, role: "assistant" });

const result = (id: string, details?: unknown) => ({
  content: [{ text: `result ${id}`, type: "text" }],
  details,
  isError: false,
  role: "toolResult",
  timestamp: 1,
  toolCallId: id,
  toolName: "code_execution",
});

const argumentsAt = (
  context: ContextMessages,
  messageIndex: number,
): Record<string, unknown> => {
  const message = context[messageIndex];
  if (message?.role !== "assistant") {
    throw new Error("expected assistant message");
  }
  const [block] = message.content;
  if (block?.type !== "toolCall") {
    throw new Error("expected tool call");
  }
  return block.arguments;
};

const codeAt = (context: ContextMessages, messageIndex: number): string =>
  String(argumentsAt(context, messageIndex).code);

describe("code execution context redaction", () => {
  test("keeps the latest script and redacts older completed scripts", () => {
    const original = messages([
      assistant(toolCall("old", "code_execution", "print('old')\n2 + 2")),
      result("old", {
        code: "print('old')\n2 + 2",
        codePath: "/old/machine/artifact.py",
        output: "4",
      }),
      assistant(toolCall("latest", "code_execution", "print('latest')")),
      result("latest", { code: "print('latest')", output: "latest" }),
    ]);

    const redacted = redactCompletedCodeExecutions(original);

    expect(argumentsAt(redacted, 0)).toEqual({
      sourceRef: codeSourceReference("print('old')\n2 + 2", "old"),
    });
    expect(codeAt(redacted, 2)).toBe("print('latest')");
    expect(codeAt(original, 0)).toBe("print('old')\n2 + 2");
    expect(redacted[1]?.role === "toolResult" && redacted[1].details).toEqual({
      output: "4",
    });
    expect(redacted[3]?.role === "toolResult" && redacted[3].details).toEqual({
      output: "latest",
    });
  });

  test("does not redact incomplete calls or other tools", () => {
    const original = messages([
      assistant(toolCall("pending", "code_execution", "print('pending')")),
      assistant(toolCall("read", "read", "not actually code")),
      result("different-id"),
    ]);

    const redacted = redactCompletedCodeExecutions(original);

    expect(codeAt(redacted, 0)).toBe("print('pending')");
    expect(codeAt(redacted, 1)).toBe("not actually code");
  });

  test("recognizes current and legacy placeholders only when they are the whole script", () => {
    const current = codePlaceholder("print('old')");
    const withCallId = codePlaceholder("print('old')", "call/one|two");
    expect(isRedactedCodePlaceholder(current)).toBeTrue();
    expect(parseCodeArtifactReference(withCallId)?.toolCallId).toBe("call/one|two");
    expect(parseCodeArtifactReference(current)).toEqual({
      artifactId: expect.stringMatching(/^[a-f\d]{64}\.py$/u),
      lines: 1,
      sha256: expect.stringMatching(/^[a-f\d]{64}$/u),
    });
    expect(
      isRedactedCodePlaceholder(
        "# previous code_execution source saved to /old/machine/a.py (1 lines, sha256:abc123abc123)",
      ),
    ).toBeTrue();
    for (const legacyPath of [
      "/old/machine/0123456789abcdef.py",
      "C:\\old\\machine\\0123456789abcdef.py",
    ]) {
      expect(
        parseCodeArtifactReference(
          `# previous code_execution source saved to ${legacyPath} (1 lines, sha256:0123456789abcdef)`,
        ),
      ).toEqual({
        artifactId: "0123456789abcdef.py",
        lines: 1,
        sha256: "0123456789abcdef",
      });
    }
    expect(
      isRedactedCodePlaceholder("# code omitted after execution (1 lines, sha256:abc123abc123)"),
    ).toBeTrue();
    expect(isRedactedCodePlaceholder(`print(${JSON.stringify(current)})`)).toBeFalse();
    expect(isRedactedCodePlaceholder(`${current}\nprint('new')`)).toBeFalse();
  });

  test("converts an existing placeholder to a structured source reference", () => {
    const placeholder = codePlaceholder("print('old')");
    const input = messages([
      assistant(toolCall("old", "code_execution", placeholder)),
      result("old"),
      assistant(toolCall("latest", "code_execution", "print('latest')")),
      result("latest"),
    ]);
    expect(argumentsAt(redactCompletedCodeExecutions(input), 0)).toEqual({
      sourceRef: codeSourceReference("print('old')", "old"),
    });
  });

  test("converts a legacy digest prefix to a compatible sourceRef", () => {
    const legacy =
      "# previous code_execution source saved to /old/machine/0123456789abcdef.py (1 lines, sha256:0123456789ab)";
    const input = messages([
      assistant(toolCall("old", "code_execution", legacy)),
      result("old"),
      assistant(toolCall("latest", "code_execution", "print('latest')")),
      result("latest"),
    ]);
    expect(argumentsAt(redactCompletedCodeExecutions(input), 0)).toEqual({
      sourceRef: {
        artifactId: "0123456789abcdef.py",
        lines: 1,
        sha256: "0123456789ab",
        toolCallId: "old",
      },
    });
  });

  test("uses a stable structured source reference", () => {
    const input = messages([
      assistant(toolCall("first", "code_execution", "print('same')")),
      result("first"),
      assistant(toolCall("latest", "code_execution", "print('latest')")),
      result("latest"),
    ]);
    expect(argumentsAt(redactCompletedCodeExecutions(input), 0)).toEqual(
      argumentsAt(redactCompletedCodeExecutions(input), 0),
    );
    expect(JSON.stringify(argumentsAt(redactCompletedCodeExecutions(input), 0))).not.toContain(
      "/home/",
    );
  });
});
