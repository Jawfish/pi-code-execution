import { highlightCode } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { NO_OUTPUT } from "./core.ts";

export const COLLAPSED_SCRIPT_LINES = 12;
export const COLLAPSED_OUTPUT_LINES = 3;

const lineCount = (count: number): string => `${count} ${count === 1 ? "line" : "lines"}`;

export const renderScriptText = (
  code: string,
  expanded: boolean,
  theme: Theme,
  running = false,
): string => {
  const lines = code.replace(/\n+$/u, "").split("\n");
  const visible = expanded ? lines : lines.slice(0, COLLAPSED_SCRIPT_LINES);
  const highlighted = highlightCode(visible.join("\n"), "python");
  const width = String(visible.length).length;
  const heading = `${theme.fg("toolTitle", theme.bold("Python"))}${theme.fg(
    "dim",
    ` · ${lineCount(lines.length)}${running ? " · running" : ""}`,
  )}`;
  const rendered = highlighted.map(
    (line, index) => `${theme.fg("dim", String(index + 1).padStart(width, " "))} ${line}`,
  );
  if (visible.length < lines.length) {
    rendered.push(
      theme.fg("dim", `Showing ${visible.length} of ${lines.length} lines · expand to view`),
    );
  }
  return [heading, ...rendered].join("\n");
};

export const renderOutputText = (
  output: string,
  expanded: boolean,
  theme: Theme,
  isError = false,
  isPartial = false,
): string => {
  if (output === NO_OUTPUT) {
    return `\n${theme.fg("success", theme.bold("Done"))}${theme.fg("dim", " · no output")}`;
  }
  const lines = output.split("\n");
  const visible = expanded
    ? lines
    : isPartial
      ? lines.slice(-COLLAPSED_OUTPUT_LINES)
      : lines.slice(0, COLLAPSED_OUTPUT_LINES);
  const color = isError ? "error" : "toolOutput";
  const headingColor = isError ? "error" : "toolTitle";
  const label = isError ? "Error" : "Output";
  const heading = `${theme.fg(headingColor, theme.bold(label))}${theme.fg(
    "dim",
    ` · ${lineCount(lines.length)}${isPartial ? " · live" : ""}`,
  )}`;
  const rendered = visible.map((line) => theme.fg(color, line));
  if (visible.length < lines.length) {
    const hidden = lines.length - visible.length;
    const notice = isPartial
      ? `${hidden} earlier ${hidden === 1 ? "line" : "lines"} hidden · expand to view`
      : `Showing ${visible.length} of ${lines.length} lines · expand to view`;
    if (isPartial) {
      rendered.unshift(theme.fg("dim", notice));
    } else {
      rendered.push(theme.fg("dim", notice));
    }
  }
  return ["", heading, ...rendered].join("\n");
};
