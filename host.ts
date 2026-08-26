import { open } from "node:fs/promises";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

import type { HostFunctions } from "./runner.ts";

// Tool definitions are intentionally heterogeneous at this dispatch boundary.
// oxlint-disable-next-line typescript/no-explicit-any
export type AnyToolDefinition = ToolDefinition<TSchema, any, any>;

export const MAX_RECOVERED_TOOL_OUTPUT_BYTES = 5 * 1024 * 1024;

export interface NestedToolCall {
  cwd: string;
  input: Record<string, unknown>;
  toolName: string;
}

export type NestedToolCallPreflight = (event: NestedToolCall) => void | Promise<void>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const flattenedContent = (result: { content?: { type: string; text?: string }[] }): string =>
  (result.content ?? [])
    .map((item) =>
      item.type === "text"
        ? (item.text ?? "")
        : "(image pixels are not visible from code_execution)",
    )
    .filter(Boolean)
    .join("\n");

const recoverFullOutput = async (
  path: string,
  toolName: string,
  maxBytes: number,
): Promise<string> => {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    if (size > maxBytes) {
      throw new Error(
        `Nested ${toolName} output is ${size} bytes, exceeding code_execution's ${maxBytes}-byte recovery limit. Filter the output at the source before returning it.`,
      );
    }
    const data = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(data, offset, size - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return data.subarray(0, offset).toString("utf-8");
  } finally {
    await file.close();
  }
};

export const flattenToolResult = async (
  result: {
    content?: { type: string; text?: string }[];
    details?: unknown;
  },
  toolName = "tool",
  maxRecoveredBytes = MAX_RECOVERED_TOOL_OUTPUT_BYTES,
): Promise<string> => {
  if (isObject(result.details)) {
    const { fullOutputPath, truncation } = result.details;
    if (
      typeof fullOutputPath === "string" &&
      isObject(truncation) &&
      truncation.truncated === true
    ) {
      return await recoverFullOutput(fullOutputPath, toolName, maxRecoveredBytes);
    }
  }
  return flattenedContent(result);
};

const PYTHON_TYPES: Record<string, string> = {
  array: "list",
  boolean: "bool",
  integer: "int",
  number: "float",
  object: "dict",
  string: "str",
};

const schemaType = (schema: Record<string, unknown>): string => {
  const { type } = schema;
  if (typeof type === "string") {
    return PYTHON_TYPES[type] ?? "any";
  }
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) {
    const types = variants
      .map((variant) => (isObject(variant) ? schemaType(variant) : "any"))
      .filter((item, index, all) => all.indexOf(item) === index);
    return types.join(" | ") || "any";
  }
  return "any";
};

const PYTHON_KEYWORDS = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "false",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "none",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "true",
  "try",
  "while",
  "with",
  "yield",
]);

/**
 * Tools are injected into `builtins`, so a tool whose name collides with a
 * real builtin would silently break ordinary Python. Rename those instead.
 */
// CPython 3.13's builtins, plus the extension's own available_tools helper.
// This is deliberately more complete than the handful of names tools normally
// use: a dynamically registered `__import__` or `Exception` tool must not
// alter how ordinary Python code imports modules or handles errors.
const RESERVED_PYTHON_NAMES = new Set([
  "ArithmeticError",
  "AssertionError",
  "AttributeError",
  "BaseException",
  "BaseExceptionGroup",
  "BlockingIOError",
  "BrokenPipeError",
  "BufferError",
  "BytesWarning",
  "ChildProcessError",
  "ConnectionAbortedError",
  "ConnectionError",
  "ConnectionRefusedError",
  "ConnectionResetError",
  "DeprecationWarning",
  "EOFError",
  "Ellipsis",
  "EncodingWarning",
  "EnvironmentError",
  "Exception",
  "ExceptionGroup",
  "FileExistsError",
  "FileNotFoundError",
  "FloatingPointError",
  "FutureWarning",
  "GeneratorExit",
  "IOError",
  "ImportError",
  "ImportWarning",
  "IndentationError",
  "IndexError",
  "InterruptedError",
  "IsADirectoryError",
  "KeyError",
  "KeyboardInterrupt",
  "LookupError",
  "MemoryError",
  "ModuleNotFoundError",
  "NameError",
  "NotADirectoryError",
  "NotImplemented",
  "NotImplementedError",
  "OSError",
  "OverflowError",
  "PendingDeprecationWarning",
  "PermissionError",
  "ProcessLookupError",
  "PythonFinalizationError",
  "RecursionError",
  "ReferenceError",
  "ResourceWarning",
  "RuntimeError",
  "RuntimeWarning",
  "StopAsyncIteration",
  "StopIteration",
  "SyntaxError",
  "SyntaxWarning",
  "SystemError",
  "SystemExit",
  "TabError",
  "TimeoutError",
  "TypeError",
  "UnboundLocalError",
  "UnicodeDecodeError",
  "UnicodeEncodeError",
  "UnicodeError",
  "UnicodeTranslateError",
  "UnicodeWarning",
  "UserWarning",
  "ValueError",
  "Warning",
  "ZeroDivisionError",
  "_IncompleteInputError",
  "abs",
  "aiter",
  "all",
  "anext",
  "any",
  "ascii",
  "available_tools",
  "bin",
  "bool",
  "breakpoint",
  "bytearray",
  "bytes",
  "callable",
  "chr",
  "classmethod",
  "compile",
  "complex",
  "copyright",
  "credits",
  "delattr",
  "dict",
  "dir",
  "divmod",
  "enumerate",
  "eval",
  "exec",
  "exit",
  "filter",
  "float",
  "format",
  "frozenset",
  "getattr",
  "globals",
  "hasattr",
  "hash",
  "help",
  "hex",
  "id",
  "input",
  "int",
  "isinstance",
  "issubclass",
  "iter",
  "len",
  "license",
  "list",
  "locals",
  "map",
  "max",
  "memoryview",
  "min",
  "next",
  "object",
  "oct",
  "open",
  "ord",
  "pow",
  "print",
  "property",
  "quit",
  "range",
  "repr",
  "reversed",
  "round",
  "set",
  "setattr",
  "slice",
  "sorted",
  "staticmethod",
  "str",
  "sum",
  "super",
  "tuple",
  "type",
  "vars",
  "zip",
]);

const pythonToolName = (name: string): string => {
  let result = name.replaceAll(/\W/gu, "_");
  if (!/^[A-Za-z_]/u.test(result)) {
    result = `_${result}`;
  }
  if (
    PYTHON_KEYWORDS.has(result.toLowerCase()) ||
    RESERVED_PYTHON_NAMES.has(result) ||
    (result.startsWith("__") && result.endsWith("__"))
  ) {
    result = `tool_${result}`;
  }
  return result;
};

export const createPythonDefinitions = (definitions: AnyToolDefinition[]): AnyToolDefinition[] => {
  const used = new Set<string>();
  return definitions.map((definition) => {
    const base = pythonToolName(definition.name);
    let name = base;
    let suffix = 2;
    while (used.has(name)) {
      name = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(name);
    return name === definition.name ? definition : { ...definition, name };
  });
};

export const renderToolSignature = (
  tool: Pick<AnyToolDefinition, "name" | "parameters">,
): string => {
  const schema = tool.parameters as TSchema & {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const properties = schema.properties ?? {};
  const required = new Set<string>(schema.required ?? []);
  const names = Object.keys(properties).toSorted((left, right) => {
    const requiredOrder = Number(required.has(right)) - Number(required.has(left));
    return requiredOrder || left.localeCompare(right);
  });
  const params = names.map((name) => {
    const rendered = `${name}: ${schemaType(properties[name] ?? {})}`;
    return required.has(name) ? rendered : `[${rendered}]`;
  });
  return `- ${tool.name}(${params.join(", ")}) -> str`;
};

/** Shared event used by trusted extensions to expose tool definitions. */
export const CODE_EXECUTION_COLLECT_TOOLS_EVENT = "code_execution:collect_tools";

export interface CodeExecutionToolCollection {
  add: (...definitions: AnyToolDefinition[]) => void;
  definitions: AnyToolDefinition[];
}

export const createToolCollection = (): CodeExecutionToolCollection => {
  const definitions: AnyToolDefinition[] = [];
  return {
    add: (...items) => definitions.push(...items),
    definitions,
  };
};

/**
 * Code execution does not assume that unrelated tools exist. Trusted
 * extensions may opt definitions into the bridge through the shared event.
 * Local filesystem and shell work should stay in the Python standard library.
 */
export const createBridgedDefinitions = (
  additional: AnyToolDefinition[] = [],
): AnyToolDefinition[] => {
  const seen = new Set<string>();
  return additional.filter((definition) => {
    if (seen.has(definition.name)) return false;
    seen.add(definition.name);
    return true;
  });
};

const withAbort = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) {
    return promise;
  }
  signal.throwIfAborted();
  const { promise: aborted, reject: rejectAbort } = Promise.withResolvers<never>();
  const onAbort = (): void => {
    const reason = signal.reason instanceof Error ? signal.reason.message : signal.reason;
    rejectAbort(new Error(`operation aborted: ${String(reason ?? "cancelled")}`));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

export const prepareAndValidateInput = (
  definition: AnyToolDefinition,
  input: Record<string, unknown>,
): unknown => {
  const prepared = definition.prepareArguments ? definition.prepareArguments(input) : input;
  const schema = definition.parameters as TSchema & {
    properties?: Record<string, unknown>;
  };
  const allowed = new Set(Object.keys(schema.properties ?? {}));
  const unknown = isObject(prepared)
    ? Object.keys(prepared).filter((name) => !allowed.has(name))
    : [];
  if (unknown.length > 0) {
    throw new TypeError(
      `Invalid arguments for ${definition.name}: unknown ${unknown.length === 1 ? "property" : "properties"} ${unknown.join(", ")}`,
    );
  }
  if (!Check(schema, prepared)) {
    const messages = [...Errors(schema, prepared)].map((error) => error.message);
    throw new TypeError(`Invalid arguments for ${definition.name}: ${messages.join("; ")}`);
  }
  return prepared;
};

export const createHostFunctions = (
  definitions: AnyToolDefinition[],
  ctx: ExtensionContext,
  signal?: AbortSignal,
  preflight?: NestedToolCallPreflight,
): HostFunctions =>
  Object.fromEntries(
    definitions.map((definition) => [
      definition.name,
      async (input: Record<string, unknown>) => {
        signal?.throwIfAborted();
        const prepared = prepareAndValidateInput(definition, input);
        await preflight?.({
          cwd: ctx.cwd,
          input: prepared as Record<string, unknown>,
          toolName: definition.name,
        });
        const result = await withAbort(
          definition.execute(crypto.randomUUID(), prepared, signal, undefined, ctx),
          signal,
        );
        return await flattenToolResult(result, definition.name);
      },
    ]),
  );
