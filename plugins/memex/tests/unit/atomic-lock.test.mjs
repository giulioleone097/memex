import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { withFileWriteLock } from "../../dist/atomic.js";

const roots = [];
async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `memex-lock-${label}-`));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("withFileWriteLock: serializes concurrent operations and creates the lock directory", async () => {
  const root = await temporaryRoot("root");
  const lockPath = path.join(root, "nested", "writer.lock");
  const order = [];
  await Promise.all([
    withFileWriteLock(lockPath, async () => {
      order.push("a-start");
      await new Promise((resolve) => { globalThis.setTimeout(resolve, 30); });
      order.push("a-end");
    }, { waitMs: 500 }),
    (async () => {
      await new Promise((resolve) => { globalThis.setTimeout(resolve, 5); });
      await withFileWriteLock(lockPath, async () => {
        order.push("b-start");
        order.push("b-end");
      }, { waitMs: 500 });
    })(),
  ]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  await assert.rejects(readFile(lockPath), { code: "ENOENT" });
});

test("withFileWriteLock: a live holder rejects a second acquirer with LOCKED", async () => {
  const root = await temporaryRoot("busy");
  const lockPath = path.join(root, "writer.lock");
  let release;
  const entered = new Promise((resolve) => { release = resolve; });
  const owner = withFileWriteLock(lockPath, async () => {
    release();
    await new Promise((resolve) => { globalThis.setTimeout(resolve, 100); });
  }, { waitMs: 20 });
  await entered;
  await assert.rejects(withFileWriteLock(lockPath, async () => undefined, { waitMs: 20 }), { code: "LOCKED" });
  await owner;
});

test("withFileWriteLock: recovers a stale lock left by a dead process", async () => {
  const root = await temporaryRoot("stale");
  const lockPath = path.join(root, "writer.lock");
  const stale = JSON.stringify({ schemaVersion: 1, pid: 999_999, createdAt: new Date(0).toISOString(), token: "dead" });
  const handle = await open(lockPath, "wx", 0o600);
  await handle.writeFile(`${stale}\n`, "utf8");
  await handle.close();
  let ran = false;
  await withFileWriteLock(lockPath, async () => { ran = true; }, { waitMs: 20, staleMs: 0 });
  assert.equal(ran, true);
});

test("atomicWriteBinaryFile: writes exact bytes and refuses to replace a symlink target", async () => {
  const { atomicWriteBinaryFile } = await import("../../dist/atomic.js");
  const root = await temporaryRoot("binary");
  const file = path.join(root, "segment.bin");
  const payload = Buffer.from([0, 1, 2, 255, 254]);
  await atomicWriteBinaryFile(file, payload);
  assert.deepEqual(await readFile(file), payload);
  const target = path.join(root, "target.bin");
  await writeFile(target, "x");
  const link = path.join(root, "link.bin");
  const { symlink } = await import("node:fs/promises");
  await symlink(target, link);
  await assert.rejects(atomicWriteBinaryFile(link, payload), { code: "SYMLINK_ESCAPE" });
  await unlink(link);
});
