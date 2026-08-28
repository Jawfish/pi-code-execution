import { truncateHead } from "@earendil-works/pi-coding-agent";

export const MAX_CODE_EXECUTION_OUTPUT_BYTES = 20 * 1024;
export const NO_OUTPUT = "(no output)";

/** Keep a UTF-8-safe rolling tail for bounded live rendering. */
export const appendLiveOutputTail = (current: string, chunk: string, maxBytes: number): string => {
  const combined = Buffer.from(current + chunk);
  if (combined.length <= maxBytes) return current + chunk;
  return combined
    .subarray(combined.length - Math.max(0, maxBytes))
    .toString("utf-8")
    .replace(/^\uFFFD+/u, "");
};

/**
 * CPython scripts communicate through stdout. Successful stderr is retained
 * too: libraries and subprocesses commonly use it for warnings and progress,
 * and silently losing it makes a completed script look healthy when it is not.
 */
export const assembleOutput = (stdout: string, stderr = ""): string => {
  const parts = [stdout.replace(/\n$/u, "")].filter(Boolean);
  if (stderr) {
    parts.push(`[stderr]\n${stderr.replace(/\n$/u, "")}`);
  }
  return parts.join("\n") || NO_OUTPUT;
};

export const truncateOutput = (output: string): string => {
  const truncated = truncateHead(output, {
    maxBytes: MAX_CODE_EXECUTION_OUTPUT_BYTES,
  });
  if (!truncated.truncated) {
    return output;
  }
  if (truncated.firstLineExceedsLimit) {
    const preview = Buffer.from(output)
      .subarray(0, truncated.maxBytes)
      .toString("utf-8")
      .replace(/�$/u, "");
    return `${preview}\n\n[Output truncated: showing the first ${Buffer.byteLength(preview, "utf-8")} of ${truncated.totalBytes} bytes]`;
  }
  return `${truncated.content}\n\n[Output truncated: showing ${truncated.outputLines} of ${truncated.totalLines} lines (${truncated.outputBytes} of ${truncated.totalBytes} bytes)]`;
};
