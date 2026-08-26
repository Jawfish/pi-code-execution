import { describe, expect, test } from "bun:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import { NO_OUTPUT } from "./core.ts";
import {
  COLLAPSED_OUTPUT_LINES,
  COLLAPSED_SCRIPT_LINES,
  renderOutputText,
  renderScriptText,
} from "./rendering.ts";

const theme = {
  bold: (text: string) => `<bold>${text}</bold>`,
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as Theme;

describe("code execution rendering", () => {
  test("numbers and collapses long scripts", () => {
    const code = Array.from(
      { length: COLLAPSED_SCRIPT_LINES + 2 },
      (_, index) => `print(${index})`,
    ).join("\n");
    const collapsed = renderScriptText(code, false, theme);
    expect(collapsed).toContain(
      `<toolTitle><bold>Python</bold></toolTitle><dim> · ${COLLAPSED_SCRIPT_LINES + 2} lines</dim>`,
    );
    expect(collapsed).toContain("<dim> 1</dim>");
    expect(collapsed).toContain(
      `Showing ${COLLAPSED_SCRIPT_LINES} of ${COLLAPSED_SCRIPT_LINES + 2} lines · expand to view`,
    );
    expect(collapsed).not.toContain(`print(${COLLAPSED_SCRIPT_LINES + 1})`);

    const expanded = renderScriptText(code, true, theme);
    expect(expanded).toContain(`print(${COLLAPSED_SCRIPT_LINES + 1})`);
    expect(expanded).not.toContain("expand to view");
  });

  test("shows hierarchy, status, and explicit success or error labels", () => {
    expect(renderScriptText("print('hi')", false, theme, true)).toContain(
      "<dim> · 1 line · running</dim>",
    );
    expect(renderOutputText(NO_OUTPUT, false, theme)).toBe(
      "\n<success><bold>Done</bold></success><dim> · no output</dim>",
    );
    expect(renderOutputText("done", false, theme)).toBe(
      "\n<toolTitle><bold>Output</bold></toolTitle><dim> · 1 line</dim>\n<toolOutput>done</toolOutput>",
    );
    expect(renderOutputText("boom", false, theme, true)).toBe(
      "\n<error><bold>Error</bold></error><dim> · 1 line</dim>\n<error>boom</error>",
    );
    expect(renderOutputText("working", false, theme, false, true)).toContain(
      "<dim> · 1 line · live</dim>",
    );
  });

  test("collapses long output unless expanded", () => {
    const output = Array.from(
      { length: COLLAPSED_OUTPUT_LINES + 1 },
      (_, index) => `line ${index}`,
    ).join("\n");
    expect(renderOutputText(output, false, theme)).toContain(
      `Showing ${COLLAPSED_OUTPUT_LINES} of ${COLLAPSED_OUTPUT_LINES + 1} lines · expand to view`,
    );
    expect(renderOutputText(output, true, theme)).toContain(`line ${COLLAPSED_OUTPUT_LINES}`);
  });
});
