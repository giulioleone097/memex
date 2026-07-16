import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { OpenWikiError } from "../../dist/errors.js";
import {
  parseCommunitiesSnapshot,
  probeAnalysisStorage,
  readCommunitiesSnapshot,
  resolveAnalysisStorage,
  writeCommunitiesSnapshot,
} from "../../dist/analysis-store.js";

const roots = [];

async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-analysis-store-${label}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("analysis-store: communities snapshot persistence", () => {
  test("analysis-store: reports uninitialized before any snapshot is written", async () => {
    const root = await temporaryRoot("repository");
    await mkdir(root, { recursive: true });
    const home = await temporaryRoot("home");
    const probed = await probeAnalysisStorage(root, home);
    assert.equal(probed.initialized, false);
  });

  test("analysis-store: writes and reads back a snapshot with round-tripped fields", async () => {
    const root = await temporaryRoot("repository");
    await mkdir(root, { recursive: true });
    const home = await temporaryRoot("home");
    const resolved = await resolveAnalysisStorage(root, home);
    const snapshot = {
      schemaVersion: 1,
      generation: "g-abc",
      generatedAt: "2026-07-14T00:00:00.000Z",
      communities: [
        { id: "leader", memberCount: 2, topTerms: ["catalog"], members: ["leader", "member"], membersTruncated: false },
      ],
      membership: { leader: "leader", member: "leader" },
    };
    await writeCommunitiesSnapshot(resolved.storage, snapshot);
    const probed = await probeAnalysisStorage(root, home);
    assert.equal(probed.initialized, true);
    const read = await readCommunitiesSnapshot(resolved.storage);
    assert.deepEqual(read, snapshot);
  });

  test("analysis-store: rejects a malformed snapshot on read", () => {
    assert.throws(() => parseCommunitiesSnapshot({ schemaVersion: 2 }), OpenWikiError);
    assert.throws(() => parseCommunitiesSnapshot({ schemaVersion: 1, generation: "g", generatedAt: "t", communities: [{}], membership: {} }), OpenWikiError);
  });

  test("analysis-store: throws NOT_INITIALIZED reading a missing snapshot", async () => {
    const root = await temporaryRoot("repository");
    await mkdir(root, { recursive: true });
    const home = await temporaryRoot("home");
    const resolved = await resolveAnalysisStorage(root, home);
    await assert.rejects(readCommunitiesSnapshot(resolved.storage), (error) => error instanceof OpenWikiError && error.code === "NOT_INITIALIZED");
  });
});
