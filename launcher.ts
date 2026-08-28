/**
 * Python launcher executed by `uv run`.
 *
 * It runs before the user's script so it can inject tool wrappers into
 * `builtins`, which keeps the user's file byte-for-byte identical to what the
 * model wrote. That matters for two reasons: PEP 723 metadata stays on line 1,
 * and traceback line numbers match the code in the transcript.
 */

export const USER_SCRIPT_NAME = "your_code.py";

const LAUNCHER_BODY = `import ast
import asyncio
import builtins
import inspect
import json
import linecache
import os
import sys
import threading
import traceback

_SCRIPT = ${JSON.stringify(USER_SCRIPT_NAME)}
# Tool output recovered from Pi artifacts is capped at 5 MiB. JSON can expand
# control characters sixfold (\\u0000), so a 32 MiB frame also accommodates the
# worst valid recovered text plus its envelope.
_MAX_DISPATCH_MESSAGE_BYTES = 32 * 1024 * 1024


def _start_watchdog():
    """Enforce the deadline from inside the interpreter.

    The agent runs this script through \`uv run\`, so killing uv would leave
    this process alive and still holding the output pipe. A daemon thread
    releases the GIL while it sleeps, so it fires even when the main thread is
    stuck in a tight loop.
    """
    raw = os.environ.get("PI_DEADLINE_SECS")
    if not raw:
        return
    try:
        deadline = float(raw)
    except ValueError:
        return

    marker = os.environ.pop("PI_WATCHDOG_MARKER", "")

    def expire():
        sys.stdout.flush()
        sys.stderr.write(
            marker + " The run exceeded its " + raw + "s deadline and was stopped.\\n"
        )
        sys.stderr.flush()
        os._exit(124)

    timer = threading.Timer(deadline, expire)
    timer.daemon = True
    timer.start()


class _Host:
    """Authenticated newline-delimited JSON client for loopback TCP."""

    def __init__(self, port, token):
        self._port = port
        self._token = token
        self._writer = None
        self._pending = {}
        self._next_id = 0
        self._connecting = None

    async def _connect(self):
        if self._writer is not None:
            return self._writer
        if self._connecting is None:
            self._connecting = asyncio.ensure_future(self._open())
        return await self._connecting

    async def _open(self):
        reader, writer = await asyncio.open_connection(
            "127.0.0.1", self._port, limit=_MAX_DISPATCH_MESSAGE_BYTES
        )
        self._writer = writer
        asyncio.ensure_future(self._read_loop(reader))
        return writer

    def _fail_pending(self, error):
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)
        self._pending.clear()

    async def _read_loop(self, reader):
        try:
            while True:
                line = await reader.readline()
                if not line:
                    self._fail_pending(
                        RuntimeError("agent tool dispatch closed unexpectedly")
                    )
                    return
                message = json.loads(line)
                future = self._pending.pop(message["id"], None)
                if future is not None and not future.done():
                    future.set_result(message)
        except BaseException as error:
            self._fail_pending(
                RuntimeError("agent tool dispatch failed: " + str(error))
            )

    async def call(self, tool, arguments):
        writer = await self._connect()
        self._next_id += 1
        call_id = self._next_id
        # JSON has no representation for NaN or infinity. Serialize before
        # registering a response future: a local serialization failure has no
        # host response, so registering first would leave an unobserved future
        # to warn during interpreter shutdown.
        payload = json.dumps(
            {
                "id": call_id,
                "tool": tool,
                "args": arguments,
                "token": self._token,
            },
            default=str,
            allow_nan=False,
        )
        future = asyncio.get_running_loop().create_future()
        self._pending[call_id] = future
        try:
            writer.write((payload + "\\n").encode("utf-8"))
            await writer.drain()
        except BaseException:
            self._pending.pop(call_id, None)
            future.cancel()
            raise
        message = await future
        if message.get("ok"):
            return message["value"]
        raise RuntimeError(message.get("error", tool + " failed"))


def _make_tool(host, name):
    async def tool(*args, **kwargs):
        if args:
            if len(args) == 1 and isinstance(args[0], dict) and not kwargs:
                kwargs = args[0]
            else:
                raise TypeError(
                    name
                    + "() takes keyword arguments only, e.g. "
                    + name
                    + "(url='...')"
                )
        return await host.call(name, kwargs)

    tool.__name__ = name
    tool.__qualname__ = name
    return tool


def _install_tools():
    raw_port = os.environ.get("PI_HOST_PORT")
    token = os.environ.get("PI_HOST_TOKEN")
    names = json.loads(os.environ.get("PI_TOOL_NAMES", "[]"))
    signatures = json.loads(os.environ.get("PI_TOOL_SIGNATURES", "{}"))
    if not raw_port or not token or not names:
        builtins.available_tools = lambda: {}
        return
    try:
        port = int(raw_port)
    except ValueError:
        raise RuntimeError("invalid agent tool dispatch port")
    host = _Host(port, token)
    tools = {name: _make_tool(host, name) for name in names}
    for name, tool in tools.items():
        setattr(builtins, name, tool)
    builtins.available_tools = lambda: {
        name: signatures.get(name, name + "(**kwargs) -> str")
        for name in tools
    }


def _main(path):
    with open(path, "r", encoding="utf-8") as handle:
        source = handle.read()
    # Register the source under a stable name so tracebacks show real lines
    # even though the file itself lives in a temporary directory.
    linecache.cache[_SCRIPT] = (
        len(source),
        None,
        source.splitlines(True),
        _SCRIPT,
    )
    # uv executes this generated launcher from a temporary directory. User code should instead
    # resolve local imports exactly as an inline script in the session cwd.
    if sys.path:
        sys.path[0] = os.getcwd()
    else:
        sys.path.append(os.getcwd())
    sys.argv = [_SCRIPT]
    code = compile(source, _SCRIPT, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    namespace = {"__name__": "__main__", "__file__": _SCRIPT}
    if code.co_flags & inspect.CO_COROUTINE:
        asyncio.run(eval(code, namespace))
    else:
        exec(code, namespace)


def _report(exc):
    # Drop launcher frames so the model only sees its own code.
    tb = exc.__traceback__
    while tb is not None and tb.tb_frame.f_code.co_filename != _SCRIPT:
        tb = tb.tb_next
    traceback.print_exception(type(exc), exc, tb)


def _run():
    _start_watchdog()
    _install_tools()
    try:
        _main(sys.argv[1])
    except SystemExit:
        raise
    except BaseException as exc:
        sys.stdout.flush()
        _report(exc)
        sys.stderr.flush()
        sys.exit(1)
    sys.stdout.flush()


_run()
`;

const SCRIPT_BLOCK = /^#\s*\/\/\/\s*script\s*$[\s\S]*?^#\s*\/\/\/\s*$/mu;

const EMPTY_BLOCK = ["# /// script", "# dependencies = []", "# ///"].join("\n");

/**
 * PEP 723 metadata declares third-party dependencies inside the script itself,
 * so it travels with the code artifact and a replayed script resolves the same
 * packages. uv reads the block from the file it is given, which is the
 * launcher, so the model's block is copied across verbatim.
 */
export const extractScriptBlock = (code: string): string | undefined =>
  SCRIPT_BLOCK.exec(code)?.[0];

export const buildLauncher = (code: string): string => {
  // Always emit a block: it forces uv into script mode, so a pyproject.toml in
  // the working directory can never change which interpreter runs.
  const block = extractScriptBlock(code) ?? EMPTY_BLOCK;
  return `${block}\n${LAUNCHER_BODY}`;
};
