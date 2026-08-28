import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { OutputSpool, SpooledOutputStream } from "./runner.ts";

const OUTPUT_ARTIFACT_ID_PATTERN = /^[a-f\d]{64}\.out$/u;
const STDERR_MARKER = Buffer.from("[stderr]\n", "utf-8");
const JOINED_STDERR_MARKER = Buffer.from("\n[stderr]\n", "utf-8");
const COPY_BUFFER_BYTES = 64 * 1024;

export interface OutputArtifactReference {
  artifactId: string;
  emittedBytes: number;
  lines: number;
  retainedBytes: number;
  retainedLines: number;
  sha256: string;
  toolCallId: string;
  truncated: boolean;
}

export type OutputArtifactIdentity = Omit<
  OutputArtifactReference,
  "artifactId" | "toolCallId"
>;

export interface LoadedOutputArtifact {
  handle: FileHandle;
  reference: OutputArtifactReference;
}

export class OutputArtifactUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputArtifactUnavailableError";
  }
}

export const outputArtifactRoot = (): string =>
  path.join(getAgentDir(), "code-execution-output");

export const outputArtifactId = (identity: OutputArtifactIdentity): string => {
  const encoded = JSON.stringify([
    "pi-code-execution-output-v1",
    identity.sha256,
    identity.emittedBytes,
    identity.lines,
    identity.retainedBytes,
    identity.retainedLines,
    identity.truncated,
  ]);
  return `${createHash("sha256").update(encoded).digest("hex")}.out`;
};

const ensureArtifactDirectory = async (directory: string, create: boolean): Promise<void> => {
  if (create) {
    await mkdir(directory, { mode: 0o700, recursive: true });
  }
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch {
    throw new OutputArtifactUnavailableError(
      `Output artifact directory is missing: ${directory}`,
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Output artifact directory is not a regular directory: ${directory}`);
  }
  await chmod(directory, 0o700);
};

const safeOpen = async (
  file: string,
  unavailableMessage: string,
): Promise<FileHandle> => {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch {
    throw new OutputArtifactUnavailableError(unavailableMessage);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Output artifact is not a regular file: ${path.basename(file)}`);
  }
  if (process.platform !== "win32") {
    // File modes are represented as a bit mask.
    // oxlint-disable-next-line eslint/no-bitwise
    if ((metadata.mode & 0o777) !== 0o600) {
      throw new Error(`Output artifact permissions are unsafe: ${path.basename(file)}`);
    }
  }

  let handle: FileHandle | undefined;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    // File-open flags are represented as a bit mask.
    // oxlint-disable-next-line eslint/no-bitwise
    handle = await open(file, constants.O_RDONLY | noFollow);
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) {
      throw new Error(`Output artifact is not a regular file: ${path.basename(file)}`);
    }
    if (process.platform !== "win32") {
      // File modes are represented as a bit mask.
      // oxlint-disable-next-line eslint/no-bitwise
      if ((openedMetadata.mode & 0o777) !== 0o600) {
        throw new Error(`Output artifact permissions are unsafe: ${path.basename(file)}`);
      }
    }
    return handle;
  } catch (error) {
    await handle?.close();
    if (error instanceof OutputArtifactUnavailableError) throw error;
    if (error instanceof Error && error.message.startsWith("Output artifact is not")) throw error;
    throw new OutputArtifactUnavailableError(unavailableMessage);
  }
};

interface ContentMetadata {
  bytes: number;
  digest: string;
  lines: number;
}

interface LineCounter {
  bytes: number;
  lastByte?: number;
  lineBreaks: number;
}

const updateLineCounter = (counter: LineCounter, data: Buffer): void => {
  counter.bytes += data.length;
  counter.lastByte = data.at(-1);
  for (const byte of data) {
    if (byte === 0x0a) counter.lineBreaks += 1;
  }
};

const finishLineCount = (counter: LineCounter): number =>
  counter.bytes === 0
    ? 0
    : counter.lineBreaks + (counter.lastByte === 0x0a ? 0 : 1);

const inspectHandle = async (handle: FileHandle): Promise<ContentMetadata> => {
  const hash = createHash("sha256");
  const counter: LineCounter = { bytes: 0, lineBreaks: 0 };
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    const data = buffer.subarray(0, bytesRead);
    hash.update(data);
    updateLineCounter(counter, data);
    position += bytesRead;
  }
  return {
    bytes: counter.bytes,
    digest: hash.digest("hex"),
    lines: finishLineCount(counter),
  };
};

const writeAll = async (handle: FileHandle, data: Buffer): Promise<void> => {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset);
    if (bytesWritten === 0) throw new Error("Could not write output artifact");
    offset += bytesWritten;
  }
};

const copyPrefix = async (
  source: FileHandle,
  target: FileHandle,
  bytes: number,
  hash: ReturnType<typeof createHash>,
  counter: LineCounter,
): Promise<void> => {
  const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, Math.max(1, bytes)));
  let position = 0;
  while (position < bytes) {
    const wanted = Math.min(buffer.length, bytes - position);
    const { bytesRead } = await source.read(buffer, 0, wanted, position);
    if (bytesRead === 0) throw new Error("Output spool ended before its retained byte count");
    const data = buffer.subarray(0, bytesRead);
    await writeAll(target, data);
    hash.update(data);
    updateLineCounter(counter, data);
    position += bytesRead;
  }
};

const openSpool = async (stream: SpooledOutputStream): Promise<FileHandle> => {
  const metadata = await lstat(stream.path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Output spool is not a regular file: ${stream.path}`);
  }
  if (metadata.size !== stream.retainedBytes) {
    throw new Error(`Output spool size does not match its metadata: ${stream.path}`);
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  // File-open flags are represented as a bit mask.
  // oxlint-disable-next-line eslint/no-bitwise
  const handle = await open(stream.path, constants.O_RDONLY | noFollow);
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) {
      throw new Error(`Output spool is not a regular file: ${stream.path}`);
    }
    if (openedMetadata.size !== stream.retainedBytes) {
      throw new Error(`Output spool size does not match its metadata: ${stream.path}`);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const validateSpool = (spool: OutputSpool): void => {
  const streams = [spool.stdout, spool.stderr];
  for (const stream of streams) {
    if (
      !Number.isSafeInteger(stream.emittedBytes) ||
      !Number.isSafeInteger(stream.emittedLines) ||
      !Number.isSafeInteger(stream.retainedBytes) ||
      stream.emittedBytes < 0 ||
      stream.emittedLines < 0 ||
      stream.retainedBytes < 0 ||
      stream.retainedBytes > stream.emittedBytes
    ) {
      throw new Error("Output spool metadata is invalid");
    }
  }
  const retainedBytes = spool.stdout.retainedBytes + spool.stderr.retainedBytes;
  const rawTruncated = streams.some(
    (stream) => stream.retainedBytes < stream.emittedBytes,
  );
  if (
    !Number.isSafeInteger(spool.retentionLimitBytes) ||
    spool.retentionLimitBytes < 0 ||
    spool.retainedBytes !== retainedBytes ||
    retainedBytes > spool.retentionLimitBytes ||
    spool.retentionTruncated !== rawTruncated
  ) {
    throw new Error("Output spool aggregate metadata is invalid");
  }
};

const stderrBoundary = (spool: OutputSpool): Buffer =>
  spool.stdout.emittedBytes > 0 && !spool.stdout.endsWithNewline
    ? JOINED_STDERR_MARKER
    : STDERR_MARKER;

const emittedMetadata = (spool: OutputSpool): { bytes: number; lines: number } => {
  const hasStderr = spool.stderr.emittedBytes > 0;
  const boundaryBytes = hasStderr ? stderrBoundary(spool).length : 0;
  return {
    bytes: spool.stdout.emittedBytes + spool.stderr.emittedBytes + boundaryBytes,
    lines:
      spool.stdout.emittedLines +
      spool.stderr.emittedLines +
      (hasStderr ? 1 : 0),
  };
};

const retainedParts = (
  spool: OutputSpool,
): { boundary: Buffer; stderrBytes: number; stdoutBytes: number } => {
  const stdoutBytes = spool.stdout.retainedBytes;
  let stderrBytes = spool.stderr.retainedBytes;
  let boundary = stderrBytes > 0 ? stderrBoundary(spool) : Buffer.alloc(0);
  const overflow = stdoutBytes + boundary.length + stderrBytes - spool.retentionLimitBytes;
  if (overflow > 0) {
    stderrBytes = Math.max(0, stderrBytes - overflow);
    if (stderrBytes === 0) boundary = Buffer.alloc(0);
  }
  return { boundary, stderrBytes, stdoutBytes };
};

const matchingArtifact = async (
  file: string,
  digest: string,
  bytes: number,
): Promise<boolean> => {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch {
    return false;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) return false;
  let handle: FileHandle | undefined;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    // File-open flags are represented as a bit mask.
    // oxlint-disable-next-line eslint/no-bitwise
    handle = await open(file, constants.O_RDONLY | noFollow);
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) return false;
    await handle.chmod(0o600);
    const actual = await inspectHandle(handle);
    return actual.bytes === bytes && actual.digest === digest;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
};

export const saveOutputArtifact = async (
  spool: OutputSpool,
  toolCallId: string,
  root = outputArtifactRoot(),
): Promise<OutputArtifactReference | undefined> => {
  validateSpool(spool);
  if (!toolCallId) throw new Error("Output artifact tool call ID is required");
  const parts = retainedParts(spool);
  const retainedBytes = parts.stdoutBytes + parts.boundary.length + parts.stderrBytes;
  if (retainedBytes === 0) return undefined;

  const directory = path.resolve(root);
  await ensureArtifactDirectory(directory, true);
  const temporary = path.join(directory, `.output.${randomUUID()}.tmp`);
  const hash = createHash("sha256");
  const lineCounter: LineCounter = { bytes: 0, lineBreaks: 0 };
  let temporaryHandle: FileHandle | undefined;
  let stdoutHandle: FileHandle | undefined;
  let stderrHandle: FileHandle | undefined;
  try {
    temporaryHandle = await open(temporary, "wx", 0o600);
    stdoutHandle = await openSpool(spool.stdout);
    stderrHandle = await openSpool(spool.stderr);
    await copyPrefix(
      stdoutHandle,
      temporaryHandle,
      parts.stdoutBytes,
      hash,
      lineCounter,
    );
    if (parts.boundary.length > 0) {
      await writeAll(temporaryHandle, parts.boundary);
      hash.update(parts.boundary);
      updateLineCounter(lineCounter, parts.boundary);
    }
    await copyPrefix(
      stderrHandle,
      temporaryHandle,
      parts.stderrBytes,
      hash,
      lineCounter,
    );
    await temporaryHandle.sync();
    await Promise.all([temporaryHandle.close(), stdoutHandle.close(), stderrHandle.close()]);
    temporaryHandle = undefined;
    stdoutHandle = undefined;
    stderrHandle = undefined;

    const sha256 = hash.digest("hex");
    const emitted = emittedMetadata(spool);
    const identity: OutputArtifactIdentity = {
      emittedBytes: emitted.bytes,
      lines: emitted.lines,
      retainedBytes,
      retainedLines: finishLineCount(lineCounter),
      sha256,
      truncated: retainedBytes < emitted.bytes,
    };
    const artifactId = outputArtifactId(identity);
    const file = path.join(directory, artifactId);
    if (!(await matchingArtifact(file, sha256, retainedBytes))) {
      try {
        await rename(temporary, file);
      } catch (error) {
        if (!(await matchingArtifact(file, sha256, retainedBytes))) throw error;
      }
    }
    return { artifactId, ...identity, toolCallId };
  } finally {
    await Promise.allSettled([
      temporaryHandle?.close(),
      stdoutHandle?.close(),
      stderrHandle?.close(),
    ]);
    await rm(temporary, { force: true });
  }
};

const validateReference = (reference: OutputArtifactReference): void => {
  if (
    !OUTPUT_ARTIFACT_ID_PATTERN.test(reference.artifactId) ||
    !/^[a-f\d]{64}$/u.test(reference.sha256)
  ) {
    throw new Error("Output artifact reference is not content-addressed");
  }
  if (
    !Number.isSafeInteger(reference.emittedBytes) ||
    !Number.isSafeInteger(reference.lines) ||
    !Number.isSafeInteger(reference.retainedBytes) ||
    !Number.isSafeInteger(reference.retainedLines) ||
    reference.retainedBytes <= 0 ||
    reference.emittedBytes < reference.retainedBytes ||
    reference.lines < reference.retainedLines ||
    reference.retainedLines < 0 ||
    !reference.toolCallId ||
    reference.truncated !== (reference.retainedBytes < reference.emittedBytes)
  ) {
    throw new Error("Output artifact reference metadata is invalid");
  }
  const { artifactId, toolCallId: _toolCallId, ...identity } = reference;
  if (artifactId !== outputArtifactId(identity)) {
    throw new Error("Output artifact ID does not match its reference metadata");
  }
};

export const loadOutputArtifact = async (
  reference: OutputArtifactReference,
  root = outputArtifactRoot(),
): Promise<LoadedOutputArtifact> => {
  validateReference(reference);
  const directory = path.resolve(root);
  await ensureArtifactDirectory(directory, false);
  const file = path.join(directory, reference.artifactId);
  const handle = await safeOpen(
    file,
    `Output artifact is missing or unreadable: ${reference.artifactId}`,
  );
  try {
    const actual = await inspectHandle(handle);
    if (actual.digest !== reference.sha256) {
      throw new Error(
        `Output artifact digest does not match its reference: ${reference.artifactId}`,
      );
    }
    if (
      actual.bytes !== reference.retainedBytes ||
      actual.lines !== reference.retainedLines
    ) {
      throw new Error(
        `Output artifact metadata does not match its reference: ${reference.artifactId}`,
      );
    }
    return { handle, reference };
  } catch (error) {
    await handle.close();
    throw error;
  }
};
