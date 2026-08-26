import { describe, expect, test } from "bun:test";

import { explainSandboxError, sandboxHints } from "./diagnostics.ts";

describe("sandboxHints", () => {
  test("points a missing package at the PEP 723 header", () => {
    const hint = sandboxHints("ModuleNotFoundError: No module named 'pandas'")[0];
    expect(hint).toContain("# /// script");
    expect(hint).toContain("dependencies");
  });

  test("distinguishes a resolver failure from a missing import", () => {
    expect(
      sandboxHints("error: No solution found when resolving script dependencies")[0],
    ).toContain("resolve");
  });

  test("explains sandbox conventions in terms of the fix", () => {
    expect(
      sandboxHints("AttributeError: 'coroutine' object has no attribute 'strip'")[0],
    ).toContain("await");
    expect(sandboxHints("AttributeError: 'str' object has no attribute 'get'")[0]).toContain(
      "plain strings",
    );
    expect(sandboxHints("TypeError: search_issues() takes keyword arguments only")[0]).toContain(
      "keywords",
    );
  });

  test("returns nothing for errors the model can already act on", () => {
    expect(sandboxHints("ZeroDivisionError: division by zero")).toEqual([]);
    expect(sandboxHints("TypeError: local() missing 1 required positional argument")).toEqual([]);
    expect(sandboxHints('  File "your_code.py", line 2\nSyntaxError: invalid syntax')).toEqual([]);
  });
});

describe("explainSandboxError", () => {
  test("appends hints below the original traceback", () => {
    const message = explainSandboxError(
      "File \"your_code.py\", line 1\nModuleNotFoundError: No module named 'httpx'",
      "import httpx",
    );
    expect(message).toContain('File "your_code.py", line 1');
    expect(message).toContain("Hint: The module was not found");
  });

  test("leaves ordinary failures unchanged", () => {
    expect(explainSandboxError("ValueError: boom", "raise ValueError('boom')")).toBe(
      "ValueError: boom",
    );
  });
});
