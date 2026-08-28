import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  createBridgedDefinitions,
  createHostFunctions,
  createPythonDefinitions,
  createPythonRegistrations,
  createToolCollection,
  flattenToolResult,
  renderToolSignature,
} from "./host.ts";
import type { AnyToolDefinition } from "./host.ts";
import { buildLauncher, extractScriptBlock } from "./launcher.ts";
import { NestedToolPolicyError } from "./runner.ts";

const definition = (
  name: string,
  parameters = Type.Object({ query: Type.String() }),
): AnyToolDefinition =>
  ({
    description: name,
    execute: (_id: string, input: { query?: string }) =>
      Promise.resolve({
        content: [{ text: `${name}:${input.query ?? ""}`, type: "text" }],
        details: {},
      }),
    label: name,
    name,
    parameters,
  }) as AnyToolDefinition;

describe("bridged definitions", () => {
  test("starts empty and includes only explicitly supplied tools", () => {
    expect(createBridgedDefinitions()).toEqual([]);
    const search = definition("search");
    const names = createBridgedDefinitions([search, search]).map((tool) => tool.name);
    expect(names).toEqual(["search"]);
  });

  test("collects definitions exposed by trusted extensions", () => {
    const collection = createToolCollection();
    collection.add(definition("issues"), definition("weather"));
    expect(collection.definitions.map(({ name }) => name)).toEqual(["issues", "weather"]);
  });
});

describe("createPythonDefinitions", () => {
  test("renames tools that would shadow a Python builtin or keyword", () => {
    const renamed = createPythonDefinitions([
      definition("open"),
      definition("print"),
      definition("class"),
      definition("available_tools"),
      definition("__import__"),
      definition("Exception"),
      definition("help"),
    ]).map((tool) => tool.name);
    expect(renamed).toEqual([
      "tool_open",
      "tool_print",
      "tool_class",
      "tool_available_tools",
      "tool___import__",
      "tool_Exception",
      "tool_help",
    ]);
  });

  test("makes non-identifier names callable and keeps them unique", () => {
    const definitions = [
      definition("Kagi/search"),
      definition("Kagi.search"),
      definition("2fast"),
    ];
    const registrations = createPythonRegistrations(definitions);
    expect(
      registrations.map(({ pythonName, registeredName }) => ({ pythonName, registeredName })),
    ).toEqual([
      { pythonName: "Kagi_search", registeredName: "Kagi/search" },
      { pythonName: "Kagi_search_2", registeredName: "Kagi.search" },
      { pythonName: "_2fast", registeredName: "2fast" },
    ]);
    expect(registrations.map(({ definition: item }) => item)).toEqual(definitions);
    expect(createPythonDefinitions(definitions).map((tool) => tool.name)).toEqual([
      "Kagi_search",
      "Kagi_search_2",
      "_2fast",
    ]);
  });
});

describe("renderToolSignature", () => {
  test("renders required parameters first with Python types", () => {
    expect(
      renderToolSignature({
        name: "search",
        parameters: Type.Object({
          count: Type.Optional(Type.Integer()),
          query: Type.String(),
          tags: Type.Optional(Type.Array(Type.String())),
        }),
      }),
    ).toBe("- search(query: str, [count: int], [tags: list]) -> str");
  });
});

describe("flattenToolResult", () => {
  test("joins text content and names unusable image blocks", async () => {
    expect(
      await flattenToolResult({
        content: [
          { text: "first", type: "text" },
          { type: "image" },
          { text: "second", type: "text" },
        ],
      }),
    ).toBe("first\n(image pixels are not visible from code_execution)\nsecond");
  });

  test("recovers full output that Pi truncated for display", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-host-"));
    try {
      const file = path.join(dir, "full.txt");
      await writeFile(file, "x".repeat(9000));
      const recovered = await flattenToolResult({
        content: [{ text: "truncated preview", type: "text" }],
        details: { fullOutputPath: file, truncation: { truncated: true } },
      });
      expect(recovered.length).toBe(9000);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("refuses to inline a recovery larger than the limit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-host-"));
    try {
      const file = path.join(dir, "full.txt");
      await writeFile(file, "x".repeat(2048));
      await expect(
        flattenToolResult(
          {
            content: [{ text: "preview", type: "text" }],
            details: { fullOutputPath: file, truncation: { truncated: true } },
          },
          "grep",
          1024,
        ),
      ).rejects.toThrow(/exceeding code_execution's 1024-byte recovery limit/u);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("createHostFunctions", () => {
  const ctx = { cwd: tmpdir() } as ExtensionContext;

  test("validates arguments against the tool schema before executing", async () => {
    const hosts = createHostFunctions([definition("search")], ctx);
    expect(await hosts.search?.({ query: "ok" })).toBe("search:ok");
    await expect(hosts.search?.({ query: 7 })).rejects.toThrow(/Invalid arguments for search/u);
    await expect(hosts.search?.({ nope: "x", query: "y" })).rejects.toThrow(
      /unknown property nope/u,
    );
  });

  test("allocates stable identities before validation and policy", async () => {
    const search = definition("Kagi/search");
    let executedId: string | undefined;
    search.execute = ((id: string, input: { query: string }) => {
      executedId = id;
      return Promise.resolve({
        content: [{ text: input.query, type: "text" }],
        details: {},
      });
    }) as AnyToolDefinition["execute"];
    const [registration] = createPythonRegistrations([search]);
    if (!registration) throw new Error("expected registration");
    const attempts: Array<{
      childToolCallId: string;
      parentToolCallId: string;
      pythonName: string;
      registeredName: string;
    }> = [];
    const policies: typeof attempts = [];
    const hosts = createHostFunctions(
      [registration],
      ctx,
      undefined,
      (call) => {
        policies.push(call);
      },
      {
        onCall: (call) => attempts.push(call),
        parentToolCallId: "outer-call",
      },
    );

    await expect(hosts.Kagi_search?.({ query: 7 })).rejects.toThrow(
      /Invalid arguments for Kagi\/search/u,
    );
    expect(attempts).toHaveLength(1);
    expect(policies).toHaveLength(0);

    expect(await hosts.Kagi_search?.({ query: "ok" })).toBe("ok");
    expect(attempts).toHaveLength(2);
    expect(policies).toEqual([
      expect.objectContaining(attempts[1] ?? {}),
    ]);
    const invalidAttempt = attempts[0];
    const validAttempt = attempts[1];
    if (!invalidAttempt || !validAttempt) throw new Error("expected attempts");
    expect(validAttempt).toMatchObject({
      parentToolCallId: "outer-call",
      pythonName: "Kagi_search",
      registeredName: "Kagi/search",
    });
    if (!executedId) throw new Error("expected executed child ID");
    expect(validAttempt.childToolCallId).toBe(executedId);
    expect(invalidAttempt.childToolCallId).not.toBe(validAttempt.childToolCallId);
  });

  test("runs the preflight hook and lets it block the call", async () => {
    const seen: string[] = [];
    const hosts = createHostFunctions([definition("search")], ctx, undefined, (call) => {
      seen.push(call.toolName);
      throw new Error("blocked by policy");
    });
    const error = await Promise.resolve(hosts.search?.({ query: "x" })).catch(
      (cause: Error) => cause,
    );
    expect(error).toBeInstanceOf(NestedToolPolicyError);
    expect((error as Error).message).toBe("blocked by policy");
    expect(seen).toEqual(["search"]);
  });

  test("refuses to start once the run is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const hosts = createHostFunctions([definition("search")], ctx, controller.signal);
    await expect(hosts.search?.({ query: "x" })).rejects.toThrow();
  });
});

describe("buildLauncher", () => {
  test("copies the model's PEP 723 block so uv resolves its dependencies", () => {
    const code = ["# /// script", '# dependencies = ["httpx"]', "# ///", "import httpx"].join("\n");
    expect(extractScriptBlock(code)).toBe(
      ["# /// script", '# dependencies = ["httpx"]', "# ///"].join("\n"),
    );
    expect(buildLauncher(code)).toStartWith(
      ["# /// script", '# dependencies = ["httpx"]', "# ///"].join("\n"),
    );
  });

  test("always emits a block so a nearby pyproject cannot capture the run", () => {
    expect(extractScriptBlock("print(1)")).toBeUndefined();
    expect(buildLauncher("print(1)")).toStartWith(
      ["# /// script", "# dependencies = []", "# ///"].join("\n"),
    );
  });
});
