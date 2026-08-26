import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

const ARTIFACT_ID_PATTERN = /^(?:[a-f\d]{16}|[a-f\d]{64})\.py$/u;

export interface CodeArtifactReference {
  artifactId: string;
  lines: number;
  sha256: string;
  toolCallId?: string;
}

export class CodeArtifactUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeArtifactUnavailableError";
  }
}

export interface LoadedCodeArtifact {
  artifactId: string;
  code: string;
}

export const codeArtifactRoot = (): string => path.join(getAgentDir(), "code-execution");

export const codeDigest = (code: string): string => createHash("sha256").update(code).digest("hex");

export const codeArtifactId = (code: string): string => `${codeDigest(code)}.py`;

export const codeArtifactPath = (code: string, root = codeArtifactRoot()): string =>
  path.join(root, codeArtifactId(code));

const codeLineCount = (code: string): number => code.split(/\r?\n/u).length;

const ensureArtifactDirectory = async (directory: string, create: boolean): Promise<void> => {
  if (create) {
    await mkdir(directory, { mode: 0o700, recursive: true });
  }
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch {
    throw new CodeArtifactUnavailableError(`Code artifact directory is missing: ${directory}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Code artifact directory is not a regular directory: ${directory}`);
  }
  await chmod(directory, 0o700);
};

const readRegularFile = async (file: string): Promise<string | undefined> => {
  let handle;
  try {
    const linkMetadata = await lstat(file);
    if (linkMetadata.isSymbolicLink() || !linkMetadata.isFile()) {
      return undefined;
    }
    // O_NOFOLLOW is not available on every supported Node platform.
    const noFollow = constants.O_NOFOLLOW ?? 0;
    // File-open flags are represented as a bit mask.
    // oxlint-disable-next-line eslint/no-bitwise
    handle = await open(file, constants.O_RDONLY | noFollow);
  } catch {
    return undefined;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      return undefined;
    }
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
};

export const saveCodeArtifact = async (
  code: string,
  root = codeArtifactRoot(),
): Promise<string> => {
  const directory = path.resolve(root);
  const artifactId = codeArtifactId(code);
  const file = path.join(directory, artifactId);
  await ensureArtifactDirectory(directory, true);

  if ((await readRegularFile(file)) === code) {
    await chmod(file, 0o600);
    return artifactId;
  }

  const temporary = path.join(directory, `.${artifactId}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, code, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      await rename(temporary, file);
    } catch (error) {
      // Another concurrent save may have installed the same immutable artifact.
      if ((await readRegularFile(file)) !== code) throw error;
    }
    await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  return artifactId;
};

export const loadCodeArtifact = async (
  reference: CodeArtifactReference,
  root = codeArtifactRoot(),
): Promise<LoadedCodeArtifact> => {
  const directory = path.resolve(root);
  await ensureArtifactDirectory(directory, false);
  if (!ARTIFACT_ID_PATTERN.test(reference.artifactId)) {
    throw new Error("Code artifact ID is not content-addressed");
  }
  const file = path.join(directory, reference.artifactId);

  const code = await readRegularFile(file);
  if (code === undefined) {
    let metadata;
    try {
      metadata = await lstat(file);
    } catch {
      throw new CodeArtifactUnavailableError(
        `Code artifact is missing or unreadable: ${reference.artifactId}`,
      );
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Code artifact is not a regular file: ${reference.artifactId}`);
    }
    throw new CodeArtifactUnavailableError(
      `Code artifact is missing or unreadable: ${reference.artifactId}`,
    );
  }
  const digest = codeDigest(code);
  if (!digest.startsWith(reference.sha256)) {
    throw new Error(`Code artifact digest does not match its reference: ${reference.artifactId}`);
  }
  if (
    reference.artifactId !== `${digest}.py` &&
    reference.artifactId !== `${digest.slice(0, 16)}.py`
  ) {
    throw new Error(`Code artifact ID does not match its content: ${reference.artifactId}`);
  }
  if (codeLineCount(code) !== reference.lines) {
    throw new Error(
      `Code artifact line count does not match its reference: ${reference.artifactId}`,
    );
  }

  await chmod(file, 0o600);
  return { artifactId: reference.artifactId, code };
};
