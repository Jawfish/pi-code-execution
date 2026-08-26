import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CodeArtifactUnavailableError,
  codeArtifactId,
  codeArtifactPath,
  codeDigest,
  loadCodeArtifact,
  saveCodeArtifact,
} from "./artifacts.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-code-artifacts-"));
  dirs.push(dir);
  return dir;
};

describe("code artifacts", () => {
  test("uses a stable content-addressed path", async () => {
    const root = await tempDir();
    const code = "print('saved')";
    expect(codeArtifactPath(code, root)).toBe(path.join(root, `${codeDigest(code)}.py`));
  });

  test("saves exact source atomically with private permissions", async () => {
    const root = await tempDir();
    const code = "print('saved')\n";
    const artifactId = await saveCodeArtifact(code, root);
    const file = path.join(root, artifactId);
    expect(artifactId).toBe(codeArtifactId(code));
    expect(await readFile(file, "utf-8")).toBe(code);
    if (process.platform !== "win32") {
      const metadata = await stat(file);
      // File modes are represented as a bit mask.
      // oxlint-disable-next-line eslint/no-bitwise
      expect(metadata.mode & 0o777).toBe(0o600);
    }
    const entries = await readdir(root);
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("coalesces concurrent saves of the same immutable artifact", async () => {
    const root = await tempDir();
    const code = "print('concurrent')";
    const ids = await Promise.all(Array.from({ length: 20 }, () => saveCodeArtifact(code, root)));
    expect(new Set(ids)).toEqual(new Set([codeArtifactId(code)]));
    expect(await readdir(root)).toEqual([codeArtifactId(code)]);
  });

  test("repairs missing, corrupted, and overly permissive artifacts", async () => {
    const root = await tempDir();
    const code = "print('durable')";
    const file = codeArtifactPath(code, root);
    await writeFile(file, "corrupted", { mode: 0o644 });
    expect(await saveCodeArtifact(code, root)).toBe(codeArtifactId(code));
    expect(await readFile(file, "utf-8")).toBe(code);
    if (process.platform !== "win32") {
      await chmod(file, 0o666);
      await saveCodeArtifact(code, root);
      const repairedMetadata = await stat(file);
      // oxlint-disable-next-line eslint/no-bitwise
      expect(repairedMetadata.mode & 0o777).toBe(0o600);
    }
    await rm(file);
    await saveCodeArtifact(code, root);
    expect(await readFile(file, "utf-8")).toBe(code);
  });

  test("loads only verified regular content-addressed artifacts", async () => {
    const root = await tempDir();
    const code = "print('replay')";
    const artifactId = await saveCodeArtifact(code, root);
    const file = path.join(root, artifactId);
    const reference = {
      artifactId,
      lines: 1,
      sha256: codeDigest(code),
    };
    expect(await loadCodeArtifact(reference, root)).toEqual({
      artifactId,
      code,
    });
    await expect(loadCodeArtifact({ ...reference, sha256: "0".repeat(64) }, root)).rejects.toThrow(
      /digest/iu,
    );
    await expect(loadCodeArtifact({ ...reference, lines: 2 }, root)).rejects.toThrow(
      /line count/iu,
    );
    await expect(
      loadCodeArtifact({ ...reference, artifactId: "../outside.py" }, root),
    ).rejects.toThrow(/content-addressed/iu);
    await expect(
      loadCodeArtifact({ ...reference, artifactId: "0000000000000000.py" }, root),
    ).rejects.toThrow(/missing/iu);

    await rm(file);
    const target = path.join(root, "target.txt");
    await writeFile(target, "not an artifact");
    await symlink(target, file);
    await expect(loadCodeArtifact(reference, root)).rejects.toThrow(/regular file/iu);
  });

  test("classifies an unreadable regular artifact as unavailable", async () => {
    if (process.platform === "win32") return;
    const root = await tempDir();
    const code = "print('unreadable')";
    const artifactId = await saveCodeArtifact(code, root);
    const file = path.join(root, artifactId);
    const reference = {
      artifactId,
      lines: 1,
      sha256: codeDigest(code),
    };
    await chmod(file, 0o000);
    try {
      const error = await loadCodeArtifact(reference, root).catch((cause: Error) => cause);
      expect(error).toBeInstanceOf(CodeArtifactUnavailableError);
    } finally {
      await chmod(file, 0o600);
    }
  });

  test("resolves references against the current artifact root", async () => {
    const firstRoot = await tempDir();
    const secondRoot = await tempDir();
    const code = "print('portable')";
    const artifactId = await saveCodeArtifact(code, firstRoot);
    await saveCodeArtifact(code, secondRoot);
    const reference = {
      artifactId,
      lines: 1,
      sha256: codeDigest(code),
    };
    expect(await loadCodeArtifact(reference, secondRoot)).toEqual({
      artifactId,
      code,
    });
  });
});
