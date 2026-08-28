import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadOutputArtifact,
  OutputArtifactUnavailableError,
  outputArtifactId,
  saveOutputArtifact,
} from "./output-artifacts.ts";
import type { OutputArtifactReference } from "./output-artifacts.ts";
import type { OutputSpool, SpooledOutputStream } from "./runner.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-output-artifacts-"));
  dirs.push(dir);
  return dir;
};

const lineCount = (data: Buffer): number => {
  if (data.length === 0) return 0;
  let lines = data.at(-1) === 0x0a ? 0 : 1;
  for (const byte of data) {
    if (byte === 0x0a) lines += 1;
  }
  return lines;
};

interface StreamOverrides {
  emittedBytes?: number;
  emittedLines?: number;
  endsWithNewline?: boolean;
}

const streamMetadata = (
  file: string,
  data: Buffer,
  overrides: StreamOverrides = {},
): SpooledOutputStream => ({
  emittedBytes: overrides.emittedBytes ?? data.length,
  emittedLines: overrides.emittedLines ?? lineCount(data),
  endsWithNewline: overrides.endsWithNewline ?? data.at(-1) === 0x0a,
  path: file,
  retainedBytes: data.length,
});

const createSpool = async (
  directory: string,
  stdout: string | Buffer,
  stderr: string | Buffer,
  options: {
    limit?: number;
    stderr?: StreamOverrides;
    stdout?: StreamOverrides;
  } = {},
): Promise<OutputSpool> => {
  const spoolDirectory = path.join(directory, `spool-${crypto.randomUUID()}`);
  await mkdir(spoolDirectory, { mode: 0o700 });
  const stdoutData = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "utf-8");
  const stderrData = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr, "utf-8");
  const stdoutPath = path.join(spoolDirectory, "stdout");
  const stderrPath = path.join(spoolDirectory, "stderr");
  await Promise.all([
    writeFile(stdoutPath, stdoutData, { mode: 0o600 }),
    writeFile(stderrPath, stderrData, { mode: 0o600 }),
  ]);
  const stdoutMetadata = streamMetadata(stdoutPath, stdoutData, options.stdout);
  const stderrMetadata = streamMetadata(stderrPath, stderrData, options.stderr);
  const retainedBytes = stdoutData.length + stderrData.length;
  const rawTruncated =
    stdoutMetadata.emittedBytes > stdoutData.length ||
    stderrMetadata.emittedBytes > stderrData.length;
  return {
    retainedBytes,
    retentionLimitBytes: options.limit ?? retainedBytes + 1024,
    retentionTruncated: rawTruncated,
    stderr: stderrMetadata,
    stdout: stdoutMetadata,
  };
};

const readLoaded = async (
  reference: OutputArtifactReference,
  root: string,
): Promise<Buffer> => {
  const loaded = await loadOutputArtifact(reference, root);
  try {
    return await loaded.handle.readFile();
  } finally {
    await loaded.handle.close();
  }
};

const digest = (data: Buffer): string =>
  createHash("sha256").update(data).digest("hex");

describe("output artifacts", () => {
  test("saves a canonical portable transcript with exact metadata", async () => {
    const directory = await tempDir();
    const root = path.join(directory, "artifacts");
    const spool = await createSpool(directory, "alpha\n", "warn\n");
    const reference = await saveOutputArtifact(spool, "call-mixed", root);
    expect(reference).toBeDefined();
    if (!reference) throw new Error("expected output artifact");

    const transcript = Buffer.from("alpha\n[stderr]\nwarn\n", "utf-8");
    const sha256 = digest(transcript);
    const identity = {
      emittedBytes: transcript.length,
      lines: 3,
      retainedBytes: transcript.length,
      retainedLines: 3,
      sha256,
      truncated: false,
    };
    expect(reference).toEqual({
      artifactId: outputArtifactId(identity),
      ...identity,
      toolCallId: "call-mixed",
    });
    expect(reference).not.toHaveProperty("path");
    expect(await readLoaded(reference, root)).toEqual(transcript);

    const file = path.join(root, reference.artifactId);
    if (process.platform !== "win32") {
      const [directoryMetadata, fileMetadata] = await Promise.all([stat(root), stat(file)]);
      // File modes are represented as a bit mask.
      // oxlint-disable-next-line eslint/no-bitwise
      expect(directoryMetadata.mode & 0o777).toBe(0o700);
      // File modes are represented as a bit mask.
      // oxlint-disable-next-line eslint/no-bitwise
      expect(fileMetadata.mode & 0o777).toBe(0o600);
    }
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("uses an explicit boundary after unterminated stdout", async () => {
    const directory = await tempDir();
    const root = path.join(directory, "artifacts");
    const spool = await createSpool(directory, "alpha", "warn");
    const reference = await saveOutputArtifact(spool, "call-boundary", root);
    if (!reference) throw new Error("expected output artifact");
    expect((await readLoaded(reference, root)).toString("utf-8")).toBe(
      "alpha\n[stderr]\nwarn",
    );
    expect(reference.lines).toBe(3);
  });

  test("keeps the canonical artifact within the aggregate ceiling", async () => {
    const directory = await tempDir();
    const root = path.join(directory, "artifacts");
    const spool = await createSpool(directory, "o".repeat(10), "e".repeat(20), {
      limit: 30,
    });
    const reference = await saveOutputArtifact(spool, "call-ceiling", root);
    if (!reference) throw new Error("expected output artifact");
    const transcript = await readLoaded(reference, root);
    expect(transcript.toString("utf-8")).toBe(
      `${"o".repeat(10)}\n[stderr]\n${"e".repeat(10)}`,
    );
    expect(reference).toMatchObject({
      emittedBytes: 40,
      retainedBytes: 30,
      truncated: true,
    });
    expect(transcript.length).toBeLessThanOrEqual(spool.retentionLimitBytes);
  });

  test("coalesces concurrent identical saves", async () => {
    const directory = await tempDir();
    const root = path.join(directory, "artifacts");
    const spool = await createSpool(directory, "same\n", "");
    const references = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        saveOutputArtifact(spool, `call-${index}`, root),
      ),
    );
    const artifactIds = references.map((reference) => reference?.artifactId);
    expect(new Set(artifactIds).size).toBe(1);
    expect((await readdir(root)).filter((name) => name.endsWith(".out")).length).toBe(1);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("repairs missing, corrupt, permissive, and symlinked artifacts", async () => {
    const directory = await tempDir();
    const root = path.join(directory, "artifacts");
    const spool = await createSpool(directory, "durable\n", "");
    const reference = await saveOutputArtifact(spool, "call-repair", root);
    if (!reference) throw new Error("expected output artifact");
    const file = path.join(root, reference.artifactId);

    if (process.platform !== "win32") {
      await chmod(file, 0o666);
      await saveOutputArtifact(spool, "call-repair", root);
      const metadata = await stat(file);
      // File modes are represented as a bit mask.
      // oxlint-disable-next-line eslint/no-bitwise
      expect(metadata.mode & 0o777).toBe(0o600);
    }

    await writeFile(file, "corrupt", { mode: 0o600 });
    await saveOutputArtifact(spool, "call-repair", root);
    expect((await readFile(file, "utf-8"))).toBe("durable\n");

    await rm(file);
    const target = path.join(directory, "target");
    await writeFile(target, "do not replace");
    await symlink(target, file);
    await saveOutputArtifact(spool, "call-repair", root);
    expect((await lstat(file)).isFile()).toBeTrue();
    expect(await readFile(target, "utf-8")).toBe("do not replace");
  });

  test("verifies content, metadata, permissions, and regular-file boundaries", async () => {
    const directory = await tempDir();
    const root = path.join(directory, "artifacts");
    const spool = await createSpool(directory, "verified\n", "");
    const reference = await saveOutputArtifact(spool, "call-verify", root);
    if (!reference) throw new Error("expected output artifact");
    const file = path.join(root, reference.artifactId);

    await expect(
      loadOutputArtifact({ ...reference, sha256: "0".repeat(64) }, root),
    ).rejects.toThrow(/metadata/iu);
    await expect(
      loadOutputArtifact(
        {
          ...reference,
          retainedBytes: reference.retainedBytes - 1,
          truncated: true,
        },
        root,
      ),
    ).rejects.toThrow(/metadata/iu);
    await expect(
      loadOutputArtifact({ ...reference, artifactId: "../outside.out" }, root),
    ).rejects.toThrow(/content-addressed/iu);

    await writeFile(file, "tampered", { mode: 0o600 });
    await expect(loadOutputArtifact(reference, root)).rejects.toThrow(/digest/iu);
    await saveOutputArtifact(spool, "call-verify", root);

    if (process.platform !== "win32") {
      await chmod(file, 0o644);
      await expect(loadOutputArtifact(reference, root)).rejects.toThrow(/permissions/iu);
      await chmod(file, 0o600);
    }

    const target = path.join(directory, "verified-target");
    await rm(file);
    await writeFile(target, "verified\n", { mode: 0o600 });
    await symlink(target, file);
    await expect(loadOutputArtifact(reference, root)).rejects.toThrow(/regular file/iu);

    await rm(file);
    const error = await loadOutputArtifact(reference, root).catch((cause: Error) => cause);
    expect(error).toBeInstanceOf(OutputArtifactUnavailableError);
  });

  test("does not persist empty output", async () => {
    const directory = await tempDir();
    const root = path.join(directory, "artifacts");
    const spool = await createSpool(directory, "", "", { limit: 64 });
    expect(await saveOutputArtifact(spool, "call-empty", root)).toBeUndefined();
    await expect(stat(root)).rejects.toThrow();
  });
});
