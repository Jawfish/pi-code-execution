import { open } from "node:fs/promises";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

import { NestedToolPolicyError } from "./runner.ts";
import type { HostFunctions } from "./runner.ts";

// Tool definitions are intentionally heterogeneous at this dispatch boundary.
// oxlint-disable-next-line typescript/no-explicit-any
export type AnyToolDefinition = ToolDefinition<TSchema, any, any>;

export const MAX_RECOVERED_TOOL_OUTPUT_BYTES = 5 * 1024 * 1024;
export const MAX_NESTED_TOOL_PREVIEW_BYTES = 4 * 1024;

export interface NestedToolCallIdentity {
  childToolCallId: string;
  parentToolCallId: string;
  pythonName: string;
  registeredName: string;
}

export interface NestedToolCall extends NestedToolCallIdentity {
  cwd: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
  startedAt: string;
  /** Legacy alias for the registered Pi tool name. */
  toolName: string;
}

export type NestedToolCallPreflight = (event: NestedToolCall) => void | Promise<void>;

export type NestedToolCallStatus =
  | "blocked"
  | "cancelled"
  | "failed"
  | "success"
  | "validation_error";

export interface NestedToolCallOutcome extends NestedToolCall {
  durationMs: number;
  error?: unknown;
  output?: string;
  result?: unknown;
  status: NestedToolCallStatus;
}

export interface NestedToolCallPreview {
  bytes: number;
  text: string;
  truncated: boolean;
}

export interface NestedToolUsage {
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  cost: {
    cacheRead: number;
    cacheWrite: number;
    input: number;
    output: number;
    total: number;
  };
  input: number;
  output: number;
  reasoning?: number;
  totalTokens: number;
}

export interface NestedToolCallStartRecord extends NestedToolCallIdentity {
  inputPreview: NestedToolCallPreview;
  startedAt: string;
}

export interface NestedToolCallRecord extends NestedToolCallIdentity {
  durationMs: number;
  errorPreview?: NestedToolCallPreview;
  inputPreview: NestedToolCallPreview;
  resultPreview?: NestedToolCallPreview;
  startedAt: string;
  status: NestedToolCallStatus;
  usage?: NestedToolUsage;
}

export type NestedToolBeforeHandler = (event: NestedToolCall) => void | Promise<void>;
export type NestedToolAfterHandler = (event: NestedToolCallOutcome) => void | Promise<void>;
export type NestedToolDispatchResult = Awaited<
  ReturnType<AnyToolDefinition["execute"]>
>;
export type NestedToolDispatcher = (
  event: NestedToolCall,
  definition: AnyToolDefinition,
  ctx: ExtensionContext,
) => NestedToolDispatchResult | Promise<NestedToolDispatchResult>;

export interface NestedToolRegistration {
  after?: NestedToolAfterHandler;
  before?: NestedToolBeforeHandler;
  definition: AnyToolDefinition;
  dispatch?: NestedToolDispatcher;
}

export type NestedToolRegistrationInput = AnyToolDefinition | NestedToolRegistration;

export interface PythonToolRegistration extends NestedToolRegistration {
  pythonName: string;
  registeredName: string;
}

export interface HostFunctionIdentityOptions {
  onCall?: (identity: NestedToolCallIdentity) => void;
  onOutcome?: (outcome: NestedToolCallOutcome) => void;
  onStart?: (started: NestedToolCallStartRecord) => void;
  parentToolCallId?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const utf8Preview = (
  text: string,
  maxBytes = MAX_NESTED_TOOL_PREVIEW_BYTES,
): NestedToolCallPreview => {
  const bytes = Buffer.from(text, "utf-8");
  if (bytes.length <= maxBytes) {
    return { bytes: bytes.length, text, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) <= 0xbf) {
    end -= 1;
  }
  return {
    bytes: bytes.length,
    text: bytes.subarray(0, end).toString("utf-8"),
    truncated: true,
  };
};

const jsonPreview = (value: unknown): NestedToolCallPreview => {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch (error) {
    text = `[input could not be serialized: ${error instanceof Error ? error.message : String(error)}]`;
  }
  return utf8Preview(text);
};

const errorPreview = (error: unknown): NestedToolCallPreview =>
  utf8Preview(error instanceof Error ? `${error.name}: ${error.message}` : String(error));

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const nestedUsage = (result: unknown): NestedToolUsage | undefined => {
  if (!isObject(result) || !isObject(result.usage) || !isObject(result.usage.cost)) {
    return undefined;
  }
  const usage = result.usage;
  const cost = usage.cost as Record<string, unknown>;
  if (
    !finiteNumber(usage.input) ||
    !finiteNumber(usage.output) ||
    !finiteNumber(usage.cacheRead) ||
    !finiteNumber(usage.cacheWrite) ||
    !finiteNumber(usage.totalTokens) ||
    (usage.cacheWrite1h !== undefined && !finiteNumber(usage.cacheWrite1h)) ||
    (usage.reasoning !== undefined && !finiteNumber(usage.reasoning)) ||
    !finiteNumber(cost.input) ||
    !finiteNumber(cost.output) ||
    !finiteNumber(cost.cacheRead) ||
    !finiteNumber(cost.cacheWrite) ||
    !finiteNumber(cost.total)
  ) {
    return undefined;
  }
  return {
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
    cost: {
      cacheRead: cost.cacheRead,
      cacheWrite: cost.cacheWrite,
      input: cost.input,
      output: cost.output,
      total: cost.total,
    },
    input: usage.input,
    output: usage.output,
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    totalTokens: usage.totalTokens,
  };
};

export const createNestedToolCallStartRecord = (
  call: NestedToolCall,
): NestedToolCallStartRecord => ({
  childToolCallId: call.childToolCallId,
  inputPreview: jsonPreview(call.input),
  parentToolCallId: call.parentToolCallId,
  pythonName: call.pythonName,
  registeredName: call.registeredName,
  startedAt: call.startedAt,
});

export const createNestedToolCallRecord = (
  outcome: NestedToolCallOutcome,
): NestedToolCallRecord => {
  const usage = nestedUsage(outcome.result);
  return {
    childToolCallId: outcome.childToolCallId,
    durationMs: outcome.durationMs,
    ...(outcome.error === undefined ? {} : { errorPreview: errorPreview(outcome.error) }),
    inputPreview: jsonPreview(outcome.input),
    parentToolCallId: outcome.parentToolCallId,
    pythonName: outcome.pythonName,
    registeredName: outcome.registeredName,
    ...(outcome.output === undefined ? {} : { resultPreview: utf8Preview(outcome.output) }),
    startedAt: outcome.startedAt,
    status: outcome.status,
    ...(usage ? { usage } : {}),
  };
};

export const aggregateNestedToolUsage = (
  records: NestedToolCallRecord[],
): NestedToolUsage | undefined => {
  const usages = records.flatMap(({ usage }) => (usage ? [usage] : []));
  if (usages.length === 0) return undefined;
  const cacheWrite1h = usages.some((usage) => usage.cacheWrite1h !== undefined)
    ? usages.reduce((total, usage) => total + (usage.cacheWrite1h ?? 0), 0)
    : undefined;
  const reasoning = usages.some((usage) => usage.reasoning !== undefined)
    ? usages.reduce((total, usage) => total + (usage.reasoning ?? 0), 0)
    : undefined;
  const total = usages.reduce<NestedToolUsage>(
    (total, usage) => ({
      cacheRead: total.cacheRead + usage.cacheRead,
      cacheWrite: total.cacheWrite + usage.cacheWrite,
      cost: {
        cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
        cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
        input: total.cost.input + usage.cost.input,
        output: total.cost.output + usage.cost.output,
        total: total.cost.total + usage.cost.total,
      },
      input: total.input + usage.input,
      output: total.output + usage.output,
      totalTokens: total.totalTokens + usage.totalTokens,
    }),
    {
      cacheRead: 0,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 0,
      output: 0,
      totalTokens: 0,
    },
  );
  return {
    ...total,
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
};

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

const isNestedToolRegistration = (
  value: NestedToolRegistrationInput,
): value is NestedToolRegistration => "definition" in value;

const normalizeNestedRegistration = (
  value: NestedToolRegistrationInput,
): NestedToolRegistration =>
  isNestedToolRegistration(value) ? value : { definition: value };

export const createPythonRegistrations = (
  registrations: NestedToolRegistrationInput[],
): PythonToolRegistration[] => {
  const used = new Set<string>();
  return registrations.map((item) => {
    const registration = normalizeNestedRegistration(item);
    const { definition } = registration;
    const base = pythonToolName(definition.name);
    let pythonName = base;
    let suffix = 2;
    while (used.has(pythonName)) {
      pythonName = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(pythonName);
    return {
      ...registration,
      pythonName,
      registeredName: definition.name,
    };
  });
};

/** Backward-compatible view for integrations that only need Python-safe definitions. */
export const createPythonDefinitions = (definitions: AnyToolDefinition[]): AnyToolDefinition[] =>
  createPythonRegistrations(definitions).map(({ definition, pythonName }) =>
    pythonName === definition.name ? definition : { ...definition, name: pythonName },
  );

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
  register: (
    definition: AnyToolDefinition,
    handlers?: Omit<NestedToolRegistration, "definition">,
  ) => void;
  registrations: NestedToolRegistration[];
}

export const createToolCollection = (): CodeExecutionToolCollection => {
  const definitions: AnyToolDefinition[] = [];
  const registrations: NestedToolRegistration[] = [];
  const register: CodeExecutionToolCollection["register"] = (definition, handlers = {}) => {
    definitions.push(definition);
    registrations.push({ ...handlers, definition });
  };
  return {
    add: (...items) => {
      for (const definition of items) register(definition);
    },
    definitions,
    register,
    registrations,
  };
};

/**
 * Code execution does not assume that unrelated tools exist. Trusted
 * extensions may opt definitions into the bridge through the shared event.
 * Local filesystem and shell work should stay in the Python standard library.
 */
export const createBridgedRegistrations = (
  additional: NestedToolRegistrationInput[] = [],
): NestedToolRegistration[] => {
  const seen = new Set<string>();
  return additional.map(normalizeNestedRegistration).filter(({ definition }) => {
    if (seen.has(definition.name)) return false;
    seen.add(definition.name);
    return true;
  });
};

export const createBridgedDefinitions = (
  additional: AnyToolDefinition[] = [],
): AnyToolDefinition[] =>
  createBridgedRegistrations(additional).map(({ definition }) => definition);

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
  registeredName = definition.name,
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
      `Invalid arguments for ${registeredName}: unknown ${unknown.length === 1 ? "property" : "properties"} ${unknown.join(", ")}`,
    );
  }
  if (!Check(schema, prepared)) {
    const messages = [...Errors(schema, prepared)].map((error) => error.message);
    throw new TypeError(`Invalid arguments for ${registeredName}: ${messages.join("; ")}`);
  }
  return prepared;
};

const isPythonToolRegistration = (
  value: AnyToolDefinition | PythonToolRegistration,
): value is PythonToolRegistration => "definition" in value && "pythonName" in value;

const normalizeRegistration = (
  value: AnyToolDefinition | PythonToolRegistration,
): PythonToolRegistration => {
  if (isPythonToolRegistration(value)) return value;
  return {
    definition: value,
    pythonName: value.name,
    registeredName: value.name,
  };
};

const lifecycleStatus = (
  error: unknown,
  signal: AbortSignal | undefined,
): Exclude<NestedToolCallStatus, "success"> => {
  if (signal?.aborted) return "cancelled";
  if (error instanceof NestedToolPolicyError) return "blocked";
  return "failed";
};

export const createHostFunctions = (
  definitions: Array<AnyToolDefinition | PythonToolRegistration>,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  preflight?: NestedToolCallPreflight,
  identityOptions: HostFunctionIdentityOptions = {},
): HostFunctions =>
  Object.fromEntries(
    definitions.map((item) => {
      const { after, before, definition, dispatch, pythonName, registeredName } =
        normalizeRegistration(item);
      return [
        pythonName,
        async (input: Record<string, unknown>) => {
          const started = performance.now();
          const startedAt = new Date().toISOString();
          const identity: NestedToolCallIdentity = {
            childToolCallId: crypto.randomUUID(),
            parentToolCallId: identityOptions.parentToolCallId ?? "untracked-code-execution",
            pythonName,
            registeredName,
          };
          identityOptions.onCall?.(identity);
          let call: NestedToolCall = {
            ...identity,
            cwd: ctx.cwd,
            input,
            ...(signal ? { signal } : {}),
            startedAt,
            toolName: registeredName,
          };
          identityOptions.onStart?.(createNestedToolCallStartRecord(call));
          let error: unknown;
          let output: string | undefined;
          let result: NestedToolDispatchResult | undefined;
          let status: NestedToolCallStatus = "failed";
          let validationFailed = false;
          try {
            signal?.throwIfAborted();
            let prepared: unknown;
            try {
              prepared = prepareAndValidateInput(definition, input, registeredName);
            } catch (cause) {
              validationFailed = true;
              throw cause;
            }
            call = { ...call, input: prepared as Record<string, unknown> };
            if (preflight) {
              try {
                await withAbort(Promise.resolve(preflight(call)), signal);
              } catch (cause) {
                if (signal?.aborted) throw cause;
                throw new NestedToolPolicyError(
                  cause instanceof Error ? cause.message : String(cause),
                  { cause },
                );
              }
            }
            if (before) {
              try {
                await withAbort(Promise.resolve(before(call)), signal);
              } catch (cause) {
                if (signal?.aborted) throw cause;
                throw new NestedToolPolicyError(
                  cause instanceof Error ? cause.message : String(cause),
                  { cause },
                );
              }
            }
            result = await withAbort(
              Promise.resolve(
                dispatch
                  ? dispatch(call, definition, ctx)
                  : definition.execute(
                      identity.childToolCallId,
                      prepared,
                      signal,
                      undefined,
                      ctx,
                    ),
              ),
              signal,
            );
            output = await flattenToolResult(result, registeredName);
            status = "success";
            return output;
          } catch (cause) {
            error = cause;
            status = validationFailed
              ? "validation_error"
              : lifecycleStatus(cause, signal);
            throw cause;
          } finally {
            const outcome: NestedToolCallOutcome = {
              ...call,
              durationMs: performance.now() - started,
              ...(error === undefined ? {} : { error }),
              ...(output === undefined ? {} : { output }),
              ...(result === undefined ? {} : { result }),
              status,
            };
            try {
              await after?.({ ...outcome });
            } finally {
              identityOptions.onOutcome?.({
                ...outcome,
                durationMs: performance.now() - started,
              });
            }
          }
        },
      ];
    }),
  );
