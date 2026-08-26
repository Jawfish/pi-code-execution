/**
 * CPython's own errors are precise about *what* failed but say nothing about
 * how this sandbox expects the script to be written. Each hint below names the
 * concrete fix so the next attempt succeeds.
 */

const PEP_723_HINT = [
  "Declare third-party packages in a PEP 723 header at the top of the script:",
  "# /// script",
  '# dependencies = ["httpx", "pandas"]',
  "# ///",
].join("\n");

interface Diagnostic {
  hint: string;
  pattern: RegExp;
}

const DIAGNOSTICS: Diagnostic[] = [
  {
    hint: `The module was not found. If it is a third-party package, declare it in a PEP 723 header. If it is local code, check its name and that it is under the session working directory.\n\n${PEP_723_HINT}`,
    pattern: /ModuleNotFoundError|No module named/u,
  },
  {
    hint: "uv could not resolve the dependencies. Check the package names and version constraints in the PEP 723 header.",
    pattern: /No solution found|was not found in the package registry/u,
  },
  {
    hint: "Tools are async: assign with `result = await tool(...)`. A coroutine value means the await is missing.",
    pattern: /'coroutine' object|coroutine .+ was never awaited/u,
  },
  {
    hint: "Tools return plain strings, never objects or dicts. Parse the text yourself (json.loads, splitlines, re).",
    pattern: /'str' object has no attribute '(?:get|items|keys|values|content|text)'/u,
  },
  {
    hint: "Pass tool arguments as keywords, e.g. tool_name(query='value').",
    pattern: /\(\) takes keyword arguments only/u,
  },
  {
    hint: "The run hit its deadline. Raise timeout (max 300s), narrow the work, or split it across calls.",
    pattern: /deadline|timed out/iu,
  },
  {
    hint: "The agent tool dispatch closed early, which usually means the run was cancelled or the process exited while a tool call was in flight.",
    pattern: /tool dispatch closed unexpectedly/u,
  },
];

export const sandboxHints = (message: string): string[] => {
  for (const { hint, pattern } of DIAGNOSTICS) {
    if (pattern.test(message)) {
      return [hint];
    }
  }
  return [];
};

/** Appends the actionable follow-up the raw traceback leaves out. */
export const explainSandboxError = (message: string, _code = ""): string => {
  const hints = sandboxHints(message);
  if (hints.length === 0) {
    return message;
  }
  return `${message}\n\nHint: ${hints.join("\nHint: ")}`;
};
