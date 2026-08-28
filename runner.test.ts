import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_MAX_RETAINED_OUTPUT_BYTES,
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  MISSING_UV_MESSAGE,
  NestedToolPolicyError,
  SandboxRunner,
} from "./runner.ts";
import type { RunResult } from "./runner.ts";

const fail = () => {
  throw new Error("boom");
};

const ok = () => "ok";

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const makeTempDir = () => mkdtemp(path.join(tmpdir(), "pi-code-test-"));

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForFile = async (file: string): Promise<void> => {
  for (let index = 0; index < 100; index += 1) {
    try {
      await readFile(file);
      return;
    } catch {
      await wait(10);
    }
  }
  throw new Error(`timed out waiting for ${file}`);
};

const waitForProcessExit = async (pid: number): Promise<void> => {
  for (let index = 0; index < 20; index += 1) {
    if (!processExists(pid)) return;
    await wait(50);
  }
  throw new Error(`process ${pid} did not exit`);
};

const withRunner = async (fn: (runner: SandboxRunner) => Promise<void>) => {
  const runner = new SandboxRunner();
  try {
    await fn(runner);
  } finally {
    await runner.close();
  }
};

const expectTimedOutcome = (result: RunResult): void => {
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(result.durationMs)).toBeTrue();
};

describe("SandboxRunner", () => {
  test("caps previews at 20 KiB and retained output at 64 MiB", () => {
    expect(DEFAULT_MAX_STDOUT_BYTES).toBe(20 * 1024);
    expect(DEFAULT_MAX_STDERR_BYTES).toBe(20 * 1024);
    expect(DEFAULT_MAX_RETAINED_OUTPUT_BYTES).toBe(64 * 1024 * 1024);
  });

  test("runs under Node, Pi's extension runtime", async () => {
    const moduleUrl = new URL("./runner.ts", import.meta.url).href;
    const script = [
      `import { SandboxRunner } from ${JSON.stringify(moduleUrl)};`,
      "const runner = new SandboxRunner();",
      "try {",
      "  console.log((await runner.run(\"print('node-runtime')\")).stdout.trim());",
      "} finally {",
      "  await runner.close();",
      "}",
    ].join("\n");
    const child = Bun.spawn(
      ["node", "--experimental-strip-types", "--input-type=module", "--eval", script],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe("node-runtime\n");
  });

  test("streams stdout and stderr with channel identities", async () => {
    await withRunner(async (runner) => {
      const streamed: Array<{ stream: string; text: string }> = [];
      const result = await runner.run(
        [
          "import sys",
          "print('hello', flush=True)",
          "print('warning', file=sys.stderr, flush=True)",
        ].join("\n"),
        {},
        (chunk) => streamed.push(chunk),
      );
      expect(result).toMatchObject({
        exitCode: 0,
        status: "success",
        stderr: "warning\n",
        stderrBytes: 8,
        stderrTruncated: false,
        stdout: "hello\n",
        stdoutBytes: 6,
        stdoutTruncated: false,
      });
      expectTimedOutcome(result);
      expect(streamed.filter(({ stream }) => stream === "stdout").map(({ text }) => text).join(""))
        .toBe("hello\n");
      expect(streamed.filter(({ stream }) => stream === "stderr").map(({ text }) => text).join(""))
        .toBe("warning\n");
    });
  });

  test("spools both streams from their first bytes with exact metadata", async () => {
    await withRunner(async (runner) => {
      const spoolPaths: string[] = [];
      let spooledStdout = Buffer.alloc(0);
      let spooledStderr = Buffer.alloc(0);
      const result = await runner.run(
        [
          "import sys",
          "sys.stdout.write('alpha\\nbeta')",
          "sys.stdout.flush()",
          "sys.stderr.write('warn\\nlast\\n')",
          "sys.stderr.flush()",
        ].join("\n"),
        {},
        undefined,
        {
          outputSpoolConsumer: async (spool) => {
            spoolPaths.push(spool.stdout.path, spool.stderr.path);
            spooledStdout = await readFile(spool.stdout.path);
            spooledStderr = await readFile(spool.stderr.path);
            expect(spool).toMatchObject({
              retainedBytes: 20,
              retentionTruncated: false,
              stderr: {
                emittedBytes: 10,
                emittedLines: 2,
                endsWithNewline: true,
                retainedBytes: 10,
              },
              stdout: {
                emittedBytes: 10,
                emittedLines: 2,
                endsWithNewline: false,
                retainedBytes: 10,
              },
            });
            if (process.platform !== "win32") {
              for (const file of spoolPaths) {
                const metadata = await stat(file);
                // File modes are represented as a bit mask.
                // oxlint-disable-next-line eslint/no-bitwise
                expect(metadata.mode & 0o777).toBe(0o600);
              }
            }
          },
        },
      );
      expect(spooledStdout.toString("utf-8")).toBe("alpha\nbeta");
      expect(spooledStderr.toString("utf-8")).toBe("warn\nlast\n");
      expect(result).toMatchObject({
        outputRetentionTruncated: false,
        retainedOutputBytes: 20,
        outputPreview: {
          stderr: { head: "warn\nlast\n", tail: "", truncated: false },
          stdout: { head: "alpha\nbeta", tail: "", truncated: false },
        },
        stderrBytes: 10,
        stderrLines: 2,
        stdoutBytes: 10,
        stdoutLines: 2,
      });
      for (const file of spoolPaths) {
        await expect(stat(file)).rejects.toThrow();
      }
    });
  });

  test("keeps a bounded head-tail preview beyond the spool ceiling", async () => {
    await withRunner(async (runner) => {
      const emitted = `HEAD-${"x".repeat(100)}-TAIL`;
      const emittedStderr = "second-stream";
      let retainedStdout = Buffer.alloc(0);
      let retainedStderr = Buffer.alloc(0);
      const result = await runner.run(
        [
          "import sys",
          `sys.stdout.write(${JSON.stringify(emitted)})`,
          "sys.stdout.flush()",
          `sys.stderr.write(${JSON.stringify(emittedStderr)})`,
          "sys.stderr.flush()",
        ].join("\n"),
        {},
        undefined,
        {
          maxRetainedOutputBytes: 24,
          maxStdoutBytes: 20,
          outputSpoolConsumer: async (spool) => {
            retainedStdout = await readFile(spool.stdout.path);
            retainedStderr = await readFile(spool.stderr.path);
            expect(spool.retainedBytes).toBe(24);
            expect(spool.retentionTruncated).toBeTrue();
          },
        },
      );
      expect(retainedStdout.length + retainedStderr.length).toBe(24);
      expect(emitted).toStartWith(retainedStdout.toString("utf-8"));
      expect(emittedStderr).toStartWith(retainedStderr.toString("utf-8"));
      expect(result).toMatchObject({
        outputRetentionTruncated: true,
        retainedOutputBytes: 24,
        stdoutBytes: 110,
        stdoutLines: 1,
        stdoutTruncated: true,
      });
      expect(result.outputPreview.stdout).toEqual({
        head: "HEAD-xxxxx",
        tail: "xxxxx-TAIL",
        truncated: true,
      });
      expect(
        Buffer.byteLength(
          result.outputPreview.stdout.head + result.outputPreview.stdout.tail,
          "utf-8",
        ),
      ).toBeLessThanOrEqual(20);
    });
  });

  test("retains successful stderr", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run(
        "import sys\nprint('out')\nprint('warning', file=sys.stderr)",
      );
      expect(result).toMatchObject({
        exitCode: 0,
        status: "success",
        stderr: "warning\n",
        stderrBytes: 8,
        stderrTruncated: false,
        stdout: "out\n",
        stdoutBytes: 4,
        stdoutTruncated: false,
      });
    });
  });

  test("bounds captured stderr", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run(
        "import sys\nprint('e' * 100, file=sys.stderr)",
        {},
        undefined,
        { maxStderrBytes: 20 },
      );
      expect(result.stderr).toContain("stderr truncated");
      expect(result.stderrBytes).toBe(101);
      expect(result.stderrTruncated).toBeTrue();
    });
  });

  test("keeps a truncated failing traceback and reports the true size", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run(
        "import sys\nprint('x' * 30000, file=sys.stderr)\nraise RuntimeError('tail-visible')",
      );
      expect(result.status).toBe("runtime_error");
      expect(result.stderr).toContain("stderr truncated");
      expect(result.stderr).toMatch(/showing the last 20480 of 30\d{3} bytes/u);
      expect(result.stderr).toContain("RuntimeError: tail-visible");
      expect(result.stderrBytes).toBeGreaterThan(30_000);
      expect(result.stderrTruncated).toBeTrue();
      expect(result.diagnostic).toContain("RuntimeError: tail-visible");
    });
  });

  test("bounds captured stdout", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run("print('x' * 100)", {}, undefined, {
        maxStdoutBytes: 20,
      });
      expect(result.stdout).toContain("stdout truncated");
      expect(result.stdoutBytes).toBe(101);
      expect(result.stdoutTruncated).toBeTrue();
    });
  });

  test("classifies syntax and runtime errors", async () => {
    await withRunner(async (runner) => {
      const syntax = await runner.run("def");
      const runtime = await runner.run("1 / 0");
      expect(syntax.status).toBe("runtime_error");
      expect(syntax.diagnostic).toContain("SyntaxError");
      expect(runtime.status).toBe("runtime_error");
      expect(runtime.diagnostic).toContain("ZeroDivisionError");
    });
  });

  test("retains stdout when user code fails", async () => {
    await withRunner(async (runner) => {
      const spoolPaths: string[] = [];
      const result = await runner.run(
        "print('important stdout', flush=True)\nraise RuntimeError('boom')",
        {},
        undefined,
        {
          outputSpoolConsumer: (spool) => {
            spoolPaths.push(spool.stdout.path, spool.stderr.path);
          },
        },
      );
      expect(result).toMatchObject({
        exitCode: 1,
        status: "runtime_error",
        stderrTruncated: false,
        stdout: "important stdout\n",
        stdoutBytes: 17,
        stdoutTruncated: false,
      });
      expect(result.stderrBytes).toBeGreaterThan(0);
      expect(result.diagnostic).toContain("RuntimeError: boom");
      for (const file of spoolPaths) {
        await expect(stat(file)).rejects.toThrow();
      }
    });
  });

  test("tracebacks use the model's own line numbers and hide the launcher", async () => {
    await withRunner(async (runner) => {
      const code = ["x = 1", "y = 2", "raise ValueError('line-check')"].join("\n");
      const result = await runner.run(code);
      expect(result.status).toBe("runtime_error");
      const message = result.diagnostic ?? "";
      expect(message).toContain('File "your_code.py", line 3');
      expect(message).toContain("raise ValueError('line-check')");
      expect(message).not.toContain("_pi_launcher");
      expect(message).not.toContain("asyncio.run");
    });
  });

  test("runs the full CPython standard library", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run(
        [
          "import hashlib, subprocess, pathlib, random, sys, tempfile",
          "print(hashlib.sha256(b'a').hexdigest()[:8])",
          "print(subprocess.run([sys.executable, '-c', \"print('shelled')\"], capture_output=True, text=True).stdout.strip())",
          "print(pathlib.Path(tempfile.gettempdir()).is_dir())",
          "print(type(random.random()).__name__)",
        ].join("\n"),
      );
      expect(result.stdout).toBe("ca978112\nshelled\nTrue\nfloat\n");
    });
  });

  test("supports generators, classes, and inheritance", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run(
        [
          "class Boom(RuntimeError):",
          "    pass",
          "",
          "def squares(n):",
          "    for i in range(n):",
          "        yield i * i",
          "",
          "print(list(squares(4)))",
          "try:",
          "    raise Boom('custom')",
          "except Boom as error:",
          "    print('caught', error)",
        ].join("\n"),
      );
      expect(result.stdout).toBe("[0, 1, 4, 9]\ncaught custom\n");
    });
  });

  test("installs third-party packages from a PEP 723 header", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run(
        [
          "# /// script",
          '# dependencies = ["tabulate"]',
          "# ///",
          "import tabulate",
          "print(tabulate.tabulate([['a', 1]], headers=['k', 'v']))",
        ].join("\n"),
        {},
        undefined,
        { timeoutSecs: 120 },
      );
      expect(result.stdout).toContain("k");
      expect(result.stdout).toContain("a");
    });
  });

  test("classifies dependency resolution before the setup milestone", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run(
        [
          "# /// script",
          '# dependencies = ["pi-code-execution-no-such-package-4d7f22"]',
          "# ///",
          "print('never started')",
        ].join("\n"),
        {},
        undefined,
        { timeoutSecs: 15 },
      );
      expect(result).toMatchObject({
        exitCode: 1,
        status: "setup_error",
        stderrTruncated: false,
        stdout: "",
        stdoutBytes: 0,
        stdoutTruncated: false,
      });
      expect(result.stderrBytes).toBeGreaterThan(0);
      expect(result.diagnostic).toContain("could not resolve the dependencies");
      expect(result.stdout).not.toContain("never started");
    });
  });

  test("reports a missing working directory instead of a missing uv executable", async () => {
    await withRunner(async (runner) => {
      const directory = await makeTempDir();
      await rm(directory, { recursive: true });
      const result = await runner.run("print(1)", {}, undefined, { cwd: directory });
      expect(result.status).toBe("setup_error");
      expect(result.diagnostic).toContain("Python working directory is unavailable");
      expect(result.diagnostic).not.toContain("Install it");
      expect(result.stdoutBytes).toBe(0);
      expect(result.stderrBytes).toBe(0);
    });
  });

  test("resolves relative paths against the working directory", async () => {
    await withRunner(async (runner) => {
      const directory = await makeTempDir();
      await writeFile(path.join(directory, "lines.txt"), "alpha\nbeta\n");
      try {
        const result = await runner.run(
          [
            "with open('lines.txt') as handle:",
            "    for line in handle:",
            "        print(line.strip())",
          ].join("\n"),
          {},
          undefined,
          { cwd: directory },
        );
        expect(result.stdout).toBe("alpha\nbeta\n");
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    });
  });

  test("uses the session working directory for local imports and argv", async () => {
    await withRunner(async (runner) => {
      const directory = await makeTempDir();
      await writeFile(path.join(directory, "local_module.py"), "VALUE = 'from cwd'\n");
      try {
        const result = await runner.run(
          [
            "import local_module, sys",
            "print(local_module.VALUE)",
            "print(sys.argv)",
            "print(sys.path[0])",
          ].join("\n"),
          {},
          undefined,
          { cwd: directory },
        );
        expect(result.stdout).toBe(`from cwd\n['your_code.py']\n${directory}\n`);
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    });
  });

  test("lets ordinary scripts manage their own event loop", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run(
        [
          "import asyncio",
          "async def main():",
          "    await asyncio.sleep(0.01)",
          "    return 'managed'",
          "print(asyncio.run(main()))",
        ].join("\n"),
      );
      expect(result.stdout).toBe("managed\n");
    });
  });

  test("allows top-level await", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run("import asyncio\nawait asyncio.sleep(0.01)\nprint('slept')");
      expect(result.stdout).toBe("slept\n");
    });
  });

  test("dispatches host tools and gathers them concurrently", async () => {
    await withRunner(async (runner) => {
      let active = 0;
      let maxActive = 0;
      const slow = async (args: Record<string, unknown>) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await wait(80);
        active -= 1;
        return String(args.value);
      };
      const result = await runner.run(
        [
          "import asyncio",
          "values = await asyncio.gather(slow(value='a'), slow(value='b'))",
          "print(values)",
        ].join("\n"),
        { slow },
      );
      expect(result.stdout).toBe("['a', 'b']\n");
      expect(maxActive).toBe(2);
    });
  });

  test("passes multi-megabyte tool output through the socket", async () => {
    await withRunner(async (runner) => {
      // NUL needs six bytes when JSON-escaped, so this sends over 6 MiB in one
      // response and exercises the frame-size headroom above the 5 MiB limit.
      const payload = "\0".repeat(1024 * 1024);
      const result = await runner.run(
        "value = await large()\nprint(len(value), ord(value[0]), ord(value[-1]))",
        { large: () => payload },
        undefined,
        { timeoutSecs: 10 },
      );
      expect(result.stdout).toBe("1048576 0 0\n");
    });
  });

  test("rejects non-finite tool arguments instead of hanging", async () => {
    await withRunner(async (runner) => {
      let calls = 0;
      const result = await runner.run(
        [
          "try:",
          "    await echo(value=float('nan'))",
          "except ValueError as error:",
          "    print('rejected', 'Out of range' in str(error))",
        ].join("\n"),
        {
          echo: () => {
            calls += 1;
            return "unexpected";
          },
        },
      );
      expect(result.stdout).toBe("rejected True\n");
      expect(result.stderr).toBeUndefined();
      expect(calls).toBe(0);
    });
  });

  test("lists callable tools without shadowing real builtins", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run(
        [
          "print(sorted(available_tools()))",
          "print(len(globals()) >= 0, isinstance(open, type(print)) or callable(open))",
        ].join("\n"),
        { ok },
      );
      expect(result.stdout).toBe("['ok']\nTrue True\n");
    });
  });

  test("host errors are catchable in Python", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run(
        ["try:", "    await fail()", "except RuntimeError as error:", "    print(str(error))"].join(
          "\n",
        ),
        { fail },
      );
      expect(result.stdout).toContain("boom");
    });
  });

  test("classifies rejected nested calls without parsing diagnostics", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run(
        [
          "try:",
          "    await blocked()",
          "except RuntimeError as error:",
          "    print(str(error))",
        ].join("\n"),
        {
          blocked: () => {
            throw new NestedToolPolicyError("blocked by policy");
          },
        },
      );
      expect(result).toMatchObject({
        diagnostic: "blocked by policy",
        exitCode: 0,
        status: "policy_error",
        stderrBytes: 0,
        stderrTruncated: false,
        stdout: "blocked by policy\n",
        stdoutBytes: 18,
        stdoutTruncated: false,
      });
    });
  });

  test("gather supports return_exceptions", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run(
        [
          "import asyncio",
          "results = await asyncio.gather(ok(), fail(), return_exceptions=True)",
          "print(results[0])",
          "print(type(results[1]).__name__, str(results[1]))",
        ].join("\n"),
        { fail, ok },
      );
      expect(result.stdout).toBe("ok\nRuntimeError boom\n");
    });
  });

  test("rejects positional tool arguments with an actionable message", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run("await ok('x')", { ok });
      expect(result.status).toBe("runtime_error");
      expect(result.diagnostic).toMatch(/keyword arguments only/u);
    });
  });

  test("correlates many concurrent tool responses by request id", async () => {
    await withRunner(async (runner) => {
      const echo = async ({ value }: Record<string, unknown>): Promise<string> => {
        await wait(Number(value) % 7);
        return `value:${value}`;
      };
      const result = await runner.run(
        [
          "import asyncio",
          "values = await asyncio.gather(*[echo(value=i) for i in range(80)])",
          "print(','.join(values))",
        ].join("\n"),
        { echo },
      );
      expect(result.stdout).toBe(
        `${Array.from({ length: 80 }, (_value, index) => `value:${index}`).join(",")}\n`,
      );
    });
  });

  test("cancellation kills Python background subprocesses", async () => {
    if (process.platform === "win32") return;
    await withRunner(async (runner) => {
      const directory = await makeTempDir();
      const pidFile = path.join(directory, "pid");
      const controller = new AbortController();
      const spoolPaths: string[] = [];
      let pid: number | undefined;
      try {
        const run = runner.run(
          [
            "import pathlib, subprocess, sys, time",
            "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])",
            `pathlib.Path(${JSON.stringify(pidFile)}).write_text(str(child.pid))`,
            "time.sleep(30)",
          ].join("\n"),
          {},
          undefined,
          {
            outputSpoolConsumer: (spool) => {
              spoolPaths.push(spool.stdout.path, spool.stderr.path);
            },
            signal: controller.signal,
            timeoutSecs: 30,
          },
        );
        await waitForFile(pidFile);
        pid = Number(await readFile(pidFile, "utf-8"));
        controller.abort(new Error("test cancellation"));
        const result = await run;
        expect(result.status).toBe("cancelled");
        expect(result.diagnostic).toContain("cancelled");
        expect(result).toMatchObject({
          exitCode: 143,
          stderrTruncated: false,
          stdoutTruncated: false,
        });
        expectTimedOutcome(result);
        await waitForProcessExit(pid);
        for (const file of spoolPaths) {
          await expect(stat(file)).rejects.toThrow();
        }
      } finally {
        if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
        await rm(directory, { force: true, recursive: true });
      }
    });
  });

  test("deadline kills Python background subprocesses", async () => {
    if (process.platform === "win32") return;
    await withRunner(async (runner) => {
      const directory = await makeTempDir();
      const pidFile = path.join(directory, "pid");
      const spoolPaths: string[] = [];
      let pid: number | undefined;
      try {
        const result = await runner.run(
          [
            "import pathlib, subprocess, sys",
            "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])",
            `pathlib.Path(${JSON.stringify(pidFile)}).write_text(str(child.pid))`,
            "while True:",
            "    pass",
          ].join("\n"),
          {},
          undefined,
          {
            outputSpoolConsumer: (spool) => {
              spoolPaths.push(spool.stdout.path, spool.stderr.path);
            },
            timeoutSecs: 1,
          },
        );
        expect(result.status).toBe("timeout");
        expect(result.diagnostic).toMatch(/deadline/iu);
        expect(result).toMatchObject({
          exitCode: 143,
          stderrTruncated: false,
          stdoutTruncated: false,
        });
        pid = Number(await readFile(pidFile, "utf-8"));
        await waitForProcessExit(pid);
        for (const file of spoolPaths) {
          await expect(stat(file)).rejects.toThrow();
        }
      } finally {
        if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
        await rm(directory, { force: true, recursive: true });
      }
    });
  });

  test("kills the script when it exceeds its deadline", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run("while True:\n    pass", {}, undefined, {
        timeoutSecs: 1,
      });
      expect(result.status).toBe("timeout");
      expect(result.diagnostic).toMatch(/deadline/iu);
    });
  });

  test("cleans up Python background subprocesses", async () => {
    if (process.platform === "win32") return;
    await withRunner(async (runner) => {
      const directory = await makeTempDir();
      const pidFile = path.join(directory, "pid");
      let pid: number | undefined;
      try {
        await runner.run(
          [
            "import pathlib, subprocess, sys",
            "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])",
            `pathlib.Path(${JSON.stringify(pidFile)}).write_text(str(child.pid))`,
            "print(child.pid)",
          ].join("\n"),
        );
        pid = Number(await readFile(pidFile, "utf-8"));
        await waitForProcessExit(pid);
      } finally {
        if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
        await rm(directory, { force: true, recursive: true });
      }
    });
  });

  test("treats an ordinary user exit 124 as an ordinary failure", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run("import sys\nsys.exit(124)");
      expect(result.status).toBe("runtime_error");
      expect(result.exitCode).toBe(124);
      expect(result.diagnostic).toContain("uv exited with 124");
      expect(result.diagnostic).not.toContain("deadline");
    });
  });

  test("hints at the PEP 723 header for a missing package", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run("import tabulate");
      expect(result.status).toBe("runtime_error");
      expect(result.diagnostic).toMatch(/Hint: The module was not found/u);
    });
  });

  test("explains how to install uv when it is missing", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run("print(1)", {}, undefined, {
        env: { PATH: "/nonexistent" },
      });
      expect(result).toMatchObject({
        status: "setup_error",
        stderrBytes: 0,
        stderrTruncated: false,
        stdout: "",
        stdoutBytes: 0,
        stdoutTruncated: false,
      });
      expect(result.diagnostic).toBe(MISSING_UV_MESSAGE);
      expect(result.diagnostic).toContain("docs.astral.sh/uv");
      expect(result.exitCode).toBeUndefined();
    });
  });

  test("uses the constructor uv override", async () => {
    const runner = new SandboxRunner("pi-code-execution-no-such-uv");
    try {
      const result = await runner.run("print(1)");
      expect(result.status).toBe("setup_error");
      expect(result.diagnostic).toContain("pi-code-execution-no-such-uv");
    } finally {
      await runner.close();
    }
  });

  test("uses the PI_CODE_EXECUTION_UV override", async () => {
    const previous = process.env.PI_CODE_EXECUTION_UV;
    process.env.PI_CODE_EXECUTION_UV = "pi-code-execution-no-such-uv";
    const runner = new SandboxRunner();
    try {
      const result = await runner.run("print(1)");
      expect(result.status).toBe("setup_error");
      expect(result.diagnostic).toContain("pi-code-execution-no-such-uv");
    } finally {
      if (previous === undefined) {
        delete process.env.PI_CODE_EXECUTION_UV;
      } else {
        process.env.PI_CODE_EXECUTION_UV = previous;
      }
      await runner.close();
    }
  });

  test("stops the script when either channel callback fails", async () => {
    await withRunner(async (runner) => {
      for (const stream of ["stdout", "stderr"] as const) {
        const spoolPaths: string[] = [];
        const print =
          stream === "stdout"
            ? "print('ready', flush=True)"
            : "print('ready', file=sys.stderr, flush=True)";
        const started = Date.now();
        await expect(
          runner.run(
            `import sys, time\n${print}\ntime.sleep(30)`,
            {},
            (chunk) => {
              if (chunk.stream === stream) throw new Error(`${stream} consumer failed`);
            },
            {
              outputSpoolConsumer: (spool) => {
                spoolPaths.push(spool.stdout.path, spool.stderr.path);
              },
            },
          ),
        ).rejects.toThrow(`${stream} consumer failed`);
        expect(Date.now() - started).toBeLessThan(3000);
        for (const file of spoolPaths) {
          await expect(stat(file)).rejects.toThrow();
        }
      }
    });
  });

  test("removes the private watchdog path from the script environment", async () => {
    await withRunner(async (runner) => {
      const result = await runner.run("import os\nprint('PI_WATCHDOG_PATH' in os.environ)");
      expect(result.stdout).toBe("False\n");
    });
  });

  test("close aborts active runs and the host factory signal", async () => {
    const runner = new SandboxRunner();
    let runSignal: AbortSignal | undefined;
    const active = runner.run("import time\ntime.sleep(30)", (signal) => {
      runSignal = signal;
      return {};
    });
    await wait(20);
    await runner.close();
    const result = await active;
    expect(result.status).toBe("cancelled");
    expect(runSignal?.aborted).toBeTrue();
  });

  test("close is idempotent", async () => {
    const runner = new SandboxRunner();
    await runner.close();
    await runner.close();
    await expect(runner.run("print(1)")).rejects.toThrow("closed");
  });
});
