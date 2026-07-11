import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, test } from "node:test";

import { initializeWiki } from "../../dist/wiki.js";
import {
  HOOK_PATH,
  assertAdapterExists,
  initializeGitRepository,
  makeIsolatedEnvironment,
  makeTemporaryRoot,
  parseSingleJsonDocument,
  runNodeAdapter,
  snapshotTree,
} from "../fixtures/adapter/process-harness.mjs";

const EVENT_SOURCES = ["startup", "resume", "clear", "compact"];

before(() => assertAdapterExists(HOOK_PATH, "SessionStart hook"));

function runHook({ cwd, home, source = "startup", extra = {} }) {
  const input = {
    session_id: "openwiki-adapter-session",
    transcript_path: join(home, "transcript.jsonl"),
    cwd,
    hook_event_name: "SessionStart",
    source,
    model: "claude-adapter-test",
    permission_mode: "default",
    agent_type: "test-agent",
    ...extra,
  };
  return runNodeAdapter(HOOK_PATH, [], {
    env: makeIsolatedEnvironment(home),
    input: `${JSON.stringify(input)}\n`,
    timeout: 5_000,
  });
}

function parseHookContext(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = parseSingleJsonDocument(result.stdout);
  assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
  assert.deepEqual(Object.keys(output.hookSpecificOutput).sort(), [
    "additionalContext",
    "hookEventName",
  ]);
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(typeof output.hookSpecificOutput.additionalContext, "string");
  assert.ok(output.hookSpecificOutput.additionalContext.length <= 300);
  return output.hookSpecificOutput.additionalContext;
}

function assertFactualContext(context, { mode, wikiRoot, updatedAt }) {
  for (const field of ["mode", "wikiRoot", "updatedAt", "freshness"]) {
    assert.match(context, new RegExp(field, "u"));
  }
  assert.match(context, new RegExp(mode, "u"));
  assert.match(context, new RegExp(escapeRegExp(wikiRoot), "u"));
  assert.match(context, new RegExp(escapeRegExp(updatedAt), "u"));
  for (const forbidden of [
    "contentHash",
    "lastGitHead",
    "lastRun",
    "summary",
    "quickstart",
    "secret fixture content",
  ]) {
    assert.equal(context.includes(forbidden), false, forbidden);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

describe("Claude SessionStart hook adapter", () => {
  test("hook handles startup, resume, clear, and compact from a nested repository cwd", async (t) => {
    const sandbox = makeTemporaryRoot(t, "hook events");
    const home = join(sandbox, "home with spaces");
    const repository = join(sandbox, "repository with spaces");
    const nested = join(repository, "packages", "feature", "src");
    mkdirSync(home);
    initializeGitRepository(repository);
    mkdirSync(nested, { recursive: true });
    const updatedAt = new Date().toISOString();
    const code = await initializeWiki({
      mode: "code",
      root: repository,
      homeDir: home,
      now: updatedAt,
      runId: "hook-code-events",
    });

    for (const source of EVENT_SOURCES) {
      const context = parseHookContext(runHook({ cwd: nested, home, source }));
      assertFactualContext(context, {
        mode: "code",
        wikiRoot: code.location.wikiRoot,
        updatedAt,
      });
    }
  });

  test("hook prefers an initialized code wiki over personal and falls back to personal", async (t) => {
    const sandbox = makeTemporaryRoot(t, "hook precedence");
    const home = join(sandbox, "home");
    const codeRepository = join(sandbox, "code repository");
    const fallbackRepository = join(sandbox, "fallback repository");
    const codeNested = join(codeRepository, "nested");
    const fallbackNested = join(fallbackRepository, "nested");
    mkdirSync(home);
    initializeGitRepository(codeRepository);
    initializeGitRepository(fallbackRepository);
    mkdirSync(codeNested);
    mkdirSync(fallbackNested);

    const personalUpdatedAt = "2026-07-11T09:00:00.000Z";
    const codeUpdatedAt = "2026-07-11T10:00:00.000Z";
    const personal = await initializeWiki({
      mode: "personal",
      homeDir: home,
      now: personalUpdatedAt,
      runId: "hook-personal",
    });
    const code = await initializeWiki({
      mode: "code",
      root: codeRepository,
      homeDir: home,
      now: codeUpdatedAt,
      runId: "hook-code",
    });

    assertFactualContext(parseHookContext(runHook({ cwd: codeNested, home })), {
      mode: "code",
      wikiRoot: code.location.wikiRoot,
      updatedAt: codeUpdatedAt,
    });
    assertFactualContext(parseHookContext(runHook({ cwd: fallbackNested, home })), {
      mode: "personal",
      wikiRoot: personal.location.wikiRoot,
      updatedAt: personalUpdatedAt,
    });
  });

  test("hook treats malformed code state as unavailable and safely uses personal fallback", async (t) => {
    const sandbox = makeTemporaryRoot(t, "hook malformed fallback");
    const home = join(sandbox, "home");
    const repository = join(sandbox, "repository");
    const nested = join(repository, "nested");
    mkdirSync(home);
    initializeGitRepository(repository);
    mkdirSync(nested);
    const personalUpdatedAt = "2026-07-11T09:30:00.000Z";
    const personal = await initializeWiki({
      mode: "personal",
      homeDir: home,
      now: personalUpdatedAt,
      runId: "hook-malformed-personal",
    });
    const code = await initializeWiki({
      mode: "code",
      root: repository,
      homeDir: home,
      now: "2026-07-11T10:30:00.000Z",
      runId: "hook-malformed-code",
    });
    writeFileSync(code.location.statePath, "{malformed state", "utf8");

    assertFactualContext(parseHookContext(runHook({ cwd: nested, home })), {
      mode: "personal",
      wikiRoot: personal.location.wikiRoot,
      updatedAt: personalUpdatedAt,
    });
  });

  test("hook emits nothing and mutates nothing when no valid wiki exists", async (t) => {
    const sandbox = makeTemporaryRoot(t, "hook absent");
    const home = join(sandbox, "home");
    const repository = join(sandbox, "repository");
    const nested = join(repository, "nested");
    mkdirSync(home);
    initializeGitRepository(repository);
    mkdirSync(nested);
    mkdirSync(join(repository, "openwiki"));
    writeFileSync(join(repository, "openwiki", ".last-update.json"), "{bad json", "utf8");
    const beforeTree = snapshotTree(sandbox);

    const result = runHook({ cwd: nested, home });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.deepEqual(snapshotTree(sandbox), beforeTree);
  });

  test("hook leaves initialized code and personal trees byte- and mtime-identical", async (t) => {
    const sandbox = makeTemporaryRoot(t, "hook readonly");
    const home = join(sandbox, "home");
    const repository = join(sandbox, "repository");
    const nested = join(repository, "nested", "deeper");
    mkdirSync(home);
    initializeGitRepository(repository);
    mkdirSync(nested, { recursive: true });
    await initializeWiki({
      mode: "personal",
      homeDir: home,
      now: "2026-07-11T08:00:00.000Z",
      runId: "hook-readonly-personal",
    });
    await initializeWiki({
      mode: "code",
      root: repository,
      homeDir: home,
      now: "2026-07-11T10:00:00.000Z",
      runId: "hook-readonly-code",
    });
    const beforeTree = snapshotTree(sandbox);

    parseHookContext(runHook({ cwd: nested, home, source: "resume" }));

    assert.deepEqual(snapshotTree(sandbox), beforeTree);
  });

  test("hook caps stale factual context at 300 characters for a long repository path", async (t) => {
    const sandbox = makeTemporaryRoot(t, "hook cap");
    const home = join(sandbox, "home");
    const repository = join(
      sandbox,
      "repository segment with deliberately long but safe name 01",
      "repository segment with deliberately long but safe name 02",
      "repository segment with deliberately long but safe name 03",
    );
    const nested = join(repository, "deeply nested cwd");
    mkdirSync(home);
    initializeGitRepository(repository);
    mkdirSync(nested);
    await initializeWiki({
      mode: "code",
      root: repository,
      homeDir: home,
      now: "2020-01-01T00:00:00.000Z",
      runId: "hook-cap",
    });

    const context = parseHookContext(runHook({ cwd: nested, home, source: "compact" }));
    assert.ok(context.length <= 300);
    assert.match(context, /freshness/iu);
    assert.match(context, /stale/iu);
  });
});
