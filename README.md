# Pi Code Execution

A Pi extension that runs short CPython scripts as the `code_execution` tool.
It is useful for data transformation, dependent operations, and filtering large
intermediate results before they enter model context.

## Install

This package supports POSIX systems. Install
[`uv`](https://docs.astral.sh/uv/getting-started/installation/), then install
the package:

```bash
pi install git:github.com/jawfish/pi-code-execution
```

Pi loads `index.ts` from the package manifest. To try a checkout without
installing it:

```bash
pi --no-extensions -e .
```

## Features

- Runs full CPython in a fresh process for each call.
- Supports top-level `await`.
- Resolves relative paths and local imports from the Pi session directory.
- Installs script dependencies declared with
  [PEP 723](https://peps.python.org/pep-0723/) through `uv`.
- Streams stdout and stderr while the script runs, keeps bounded live and final
  previews, and retains up to 64 MiB in a verified output artifact.
- Runs sequentially with sibling calls in the same Pi tool batch, so they cannot
  race with the script's filesystem or subprocess work.
- Keeps explicit concurrency inside one script: bridged calls passed to
  `asyncio.gather()` may still run at the same time.
- Applies a configurable deadline to dependency installation, Python, and
  bridged tool calls.
- Stores older script sources as verified content-addressed artifacts, then
  replaces them with structured `sourceRef` values in model context.
- Replays an exact saved script from its verified `sourceRef`.
- Reads saved source without execution through `code_execution_source`.
- Recovers retained output without rerunning side effects through
  `code_execution_output`.
- Lets trusted Pi extensions explicitly expose selected tools to Python.

Example with a third-party dependency:

```python
# /// script
# dependencies = ["httpx"]
# ///

import httpx

response = httpx.get("https://example.com")
print(response.status_code)
```

Set `PI_CODE_EXECUTION_UV` to use a specific `uv` executable:

```bash
PI_CODE_EXECUTION_UV=/opt/uv/bin/uv pi
```

## Saved source references

The extension keeps the latest script visible to the model. It replaces older
completed scripts with a structured `sourceRef` after it has saved their source.
The reference contains a full SHA-256 digest, line count, content-addressed
artifact ID, and optional original tool-call ID.

The model can pass the `sourceRef` unchanged to `code_execution` to rerun the
exact verified script. It can call `code_execution_source` first to inspect the
source without running it. The reader supports `offset` and `limit` for long
scripts and caps each source chunk at 20 KiB.

Legacy path-bearing and XML-like references remain readable for resumed
sessions. New references contain no machine-specific absolute path. A final
execution result rebuilds the reference from the exact loaded source, keeps the
verified artifact ID, and records the current outer tool-call ID.

## Saved output references

A run with nonempty output stores a canonical stdout-then-stderr transcript.
The transcript uses `[stderr]` as its channel boundary. Successful and expected
failure details include a portable reference when the artifact was saved:

```typescript
type OutputArtifactReference = {
  artifactId: string;
  sha256: string;
  emittedBytes: number;
  lines: number;
  retainedBytes: number;
  retainedLines: number;
  truncated: boolean;
  toolCallId: string;
};
```

The extension retains at most 64 MiB per run. It continues to drain and count
output after that ceiling. The final result stays within 20 KiB and shows a
head-tail preview with exact emitted and omitted counts. It also states whether
all retained output is recoverable or whether the artifact itself was
truncated.

Pass the complete `outputRef` unchanged to `code_execution_output`. The reader
accepts optional UTF-8 byte `offset` and `limit` values, caps each page at 20
KiB, never splits a UTF-8 character, and returns the next stable byte offset.
It verifies the reference, content digest, metadata, permissions, and
regular-file boundary before every read. References contain no absolute paths.

## Execution outcomes

Completed expected runs return structured details instead of throwing away
process state:

```typescript
type CodeExecutionFinalDetails = {
  status:
    | "success"
    | "runtime_error"
    | "setup_error"
    | "timeout"
    | "cancelled"
    | "policy_error";
  exitCode?: number;
  signal?: string;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  sourceRef: CodeArtifactReference;
  outputRef?: OutputArtifactReference;
  nestedCalls: NestedToolCallRecord[];
};
```

`runtime_error` means CPython reached the user-code milestone and then failed.
`setup_error` covers failures before that milestone, including `uv`, dependency,
working-directory, and unavailable-source failures. The other statuses identify
deadlines, caller cancellation, and blocked nested calls directly.

While a script is running, partial updates use a smaller shape:

```typescript
type CodeExecutionRunningDetails = {
  status: "running";
  sourceRef: CodeArtifactReference;
};
```

Expected non-success results keep their details and retained output, then the
extension marks them as Pi tool errors. Invalid inputs, corrupt artifacts,
stream callback defects, and other internal extension errors still throw.
`outputRef` is absent for empty output or when no artifact was persisted.
`nestedCalls` is empty until those records exist.

## Tool bridge

No unrelated tools are built in. Another trusted extension can expose one of
its tool definitions through the shared `code_execution:collect_tools` event.
The tool must also be active in Pi for the current session.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CodeExecutionToolCollection } from "@jawfish/pi-code-execution/host";

import { issueSearchTool } from "./issue-search.ts";

export default function (pi: ExtensionAPI): void {
  pi.registerTool(issueSearchTool);
  pi.events.on("code_execution:collect_tools", (event) => {
    (event as CodeExecutionToolCollection).add(issueSearchTool);
  });
}
```

Python receives normalized callable names. `available_tools()` returns their
signatures:

```python
print(available_tools())
result = await search_issues(query="startup failure")
print(result)
```

Calls are schema-validated in the Pi process. Bridged tool output is returned
as text. If a Pi tool stored a larger truncated result, code execution can
recover up to 5 MiB from that tool's output artifact.

Policy extensions can inspect or block nested calls through the
`code_execution:tool_call` event. Its mutable event object contains `toolName`,
`input`, `cwd`, and optional `block` and `reason` fields.

## Security model

`code_execution` is not a sandbox. Generated Python runs with the same user
permissions as Pi and inherits its environment. It can read and write files,
start subprocesses, access the network, and install packages. Only install this
extension and PEP 723 dependencies from sources you trust.

Bridged tools can also have side effects. Cancellation stops waiting for a
bridged call, but it cannot undo effects that already happened.

Tool dispatch uses an authenticated per-run loopback connection. This prevents
an unrelated local process from accidentally calling the bridge, but it is not
a boundary against the Python process itself.

Cancellation uses a POSIX process group and escalates from `SIGTERM` to
`SIGKILL`. Deliberately detached descendants can escape that group. Windows is
not supported because Node does not provide equivalent process-tree
containment without an additional native job-object implementation.

Older sources are stored under Pi's agent directory in `code-execution/`.
Retained transcripts are stored in `code-execution-output/`. Directories and
files use private POSIX modes where supported. Artifacts remain until the user
removes them, and any process running as the same user may read them. Session
references contain artifact IDs, not machine-specific absolute paths.

## Development

```bash
bun install
bun run test
bun run typecheck
PI_SKIP_VERSION_CHECK=1 pi --no-extensions -e . --list-models
```

The test suite requires `uv` and a platform with POSIX process groups.

## License

MIT
