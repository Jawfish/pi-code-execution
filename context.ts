import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import { codeArtifactId, codeDigest, saveCodeArtifact } from "./artifacts.ts";
import type { CodeArtifactReference } from "./artifacts.ts";

type ContextMessages = ContextEvent["messages"];

export const codeSourceReference = (
  code: string,
  toolCallId?: string,
): CodeArtifactReference => ({
  artifactId: codeArtifactId(code),
  lines: code.split(/\r?\n/u).length,
  sha256: codeDigest(code),
  ...(toolCallId ? { toolCallId } : {}),
});

export const codePlaceholder = (code: string, toolCallId?: string): string => {
  const reference = codeSourceReference(code, toolCallId);
  const call = reference.toolCallId
    ? ` tool_call_id="${encodeURIComponent(reference.toolCallId)}"`
    : "";
  return `<code_execution_source_redacted artifact="${reference.artifactId}"${call} lines="${reference.lines}" sha256="${reference.sha256}">`;
};

const CURRENT_PLACEHOLDER =
  /^<code_execution_source_redacted artifact="(?<artifactId>(?:[a-f\d]{16}|[a-f\d]{64})\.py)"(?: tool_call_id="(?<toolCallId>[^"]+)")? lines="(?<lines>\d+)" sha256="(?<sha256>[a-f\d]{12,64})">$/u;
const PATH_CURRENT_PLACEHOLDER =
  /^<code_execution_source_redacted path="(?<path>[^"]+\.py)"(?: tool_call_id="(?<toolCallId>[^"]+)")? lines="(?<lines>\d+)" sha256="(?<sha256>[a-f\d]{12,64})">$/u;
const PATH_LEGACY_PLACEHOLDER =
  /^# previous code_execution source saved to (?<path>.+\.py) \((?<lines>\d+) lines, sha256:(?<sha256>[a-f\d]{12,64})\)$/u;
const PATHLESS_LEGACY_PLACEHOLDER =
  /^# code omitted after execution \(\d+ lines, sha256:[a-f\d]+\)$/u;

const artifactIdFromPath = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const artifactId = value.split(/[\\/]/u).at(-1);
  if (!artifactId) return undefined;
  return /^(?:[a-f\d]{16}|[a-f\d]{64})\.py$/u.test(artifactId) ? artifactId : undefined;
};

const decodedToolCallId = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

export const parseCodeArtifactReference = (code: string): CodeArtifactReference | undefined => {
  const trimmed = code.trim();
  const match =
    CURRENT_PLACEHOLDER.exec(trimmed) ??
    PATH_CURRENT_PLACEHOLDER.exec(trimmed) ??
    PATH_LEGACY_PLACEHOLDER.exec(trimmed);
  const groups = match?.groups;
  if (!groups) return undefined;
  const artifactId = groups.artifactId ?? artifactIdFromPath(groups.path);
  if (!artifactId) return undefined;
  const toolCallId = decodedToolCallId(groups.toolCallId);
  return {
    artifactId,
    lines: Number(groups.lines),
    sha256: groups.sha256 ?? "",
    ...(toolCallId ? { toolCallId } : {}),
  };
};

export const isRedactedCodePlaceholder = (code: string): boolean => {
  const trimmed = code.trim();
  return (
    parseCodeArtifactReference(trimmed) !== undefined ||
    PATH_CURRENT_PLACEHOLDER.test(trimmed) ||
    PATH_LEGACY_PLACEHOLDER.test(trimmed) ||
    PATHLESS_LEGACY_PLACEHOLDER.test(trimmed)
  );
};

const codeSources = (messages: ContextMessages): string[] =>
  messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((block) =>
          block.type === "toolCall" &&
          block.name === "code_execution" &&
          typeof block.arguments.code === "string" &&
          !isRedactedCodePlaceholder(block.arguments.code)
            ? [block.arguments.code]
            : [],
        )
      : [],
  );

export const saveContextCodeArtifacts = async (messages: ContextMessages): Promise<void> => {
  await Promise.all(codeSources(messages).map((code) => saveCodeArtifact(code)));
};

export const redactCompletedCodeExecutions = (messages: ContextMessages): ContextMessages => {
  const completedIds = new Set<string>();
  let latestCodeCallId: string | undefined;
  for (const message of messages) {
    if (message.role === "toolResult" && message.toolName === "code_execution") {
      completedIds.add(message.toolCallId);
    }
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall" && block.name === "code_execution") {
          latestCodeCallId = block.id;
        }
      }
    }
  }

  return messages.map((message) => {
    if (message.role === "assistant") {
      return {
        ...message,
        content: message.content.map((block) => {
          if (
            block.type !== "toolCall" ||
            block.name !== "code_execution" ||
            typeof block.arguments.code !== "string"
          ) {
            return block;
          }
          const existingReference = parseCodeArtifactReference(block.arguments.code);
          if (
            !existingReference &&
            (!completedIds.has(block.id) ||
              block.id === latestCodeCallId ||
              isRedactedCodePlaceholder(block.arguments.code))
          ) {
            return block;
          }
          const {
            code,
            sourceRef: _sourceRef,
            ...argumentsWithoutSource
          } = block.arguments;
          return {
            ...block,
            arguments: {
              ...argumentsWithoutSource,
              sourceRef: existingReference
                ? {
                    ...existingReference,
                    ...(existingReference.toolCallId ? {} : { toolCallId: block.id }),
                  }
                : codeSourceReference(code, block.id),
            },
          };
        }),
      };
    }

    if (
      message.role === "toolResult" &&
      message.toolName === "code_execution" &&
      message.details &&
      typeof message.details === "object"
    ) {
      const {
        code: _code,
        codePath: _legacyCodePath,
        ...details
      } = message.details as Record<string, unknown>;
      return { ...message, details };
    }

    return message;
  });
};
