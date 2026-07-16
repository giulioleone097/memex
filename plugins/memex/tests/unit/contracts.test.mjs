import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  MAX_ENVELOPE_BYTES,
  MAX_ENVELOPE_ITEMS,
  MAX_ITEM_TEXT_BYTES,
  MAX_METADATA_VALUE_BYTES,
  parseSourceEnvelope,
  parseWikiState,
} from "../../dist/contracts.js";
import { MemexError } from "../../dist/errors.js";

const NOW = "2026-07-11T10:15:30.000Z";

function createWikiState(overrides = {}) {
  return {
    schemaVersion: 1,
    mode: "code",
    workspaceId: "workspace-123",
    wikiRoot: "/tmp/example/memex",
    createdAt: NOW,
    updatedAt: NOW,
    contentHash: "a".repeat(64),
    lastGitHead: "b".repeat(40),
    lastRun: {
      id: "run-123",
      command: "init",
      startedAt: NOW,
      completedAt: NOW,
      changed: true,
      summary: "Initialized repository wiki.",
    },
    ...overrides,
  };
}

function createSourceEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    sourceId: "gmail-primary",
    kind: "gmail",
    fetchedAt: NOW,
    cursor: "cursor-1",
    provenance: {
      host: "codex",
      accountHint: "work account",
      query: "newer_than:1d",
    },
    items: [
      {
        externalId: "message-1",
        title: "Production release",
        text: "Release completed successfully.",
        url: "https://example.test/messages/1",
        occurredAt: NOW,
        metadata: {
          "source-specific-label": "important",
          attempts: 1,
          confirmed: true,
          nullable: null,
        },
      },
    ],
    ...overrides,
  };
}

function captureMemexError(callback) {
  try {
    callback();
  } catch (error) {
    assert.ok(error instanceof MemexError);
    return error;
  }

  assert.fail("Expected MemexError to be thrown.");
}

describe("contracts", () => {
  test("contracts: parses valid wiki state and source envelope", () => {
    const state = createWikiState();
    const envelope = createSourceEnvelope();

    assert.deepEqual(parseWikiState(state), state);
    assert.deepEqual(parseSourceEnvelope(envelope), envelope);
  });

  test("contracts: allows arbitrary metadata keys and rejects unknown structural keys", () => {
    const metadataEnvelope = createSourceEnvelope({
      items: [
        {
          externalId: "message-1",
          text: "Evidence",
          metadata: { arbitrary_vendor_field: "accepted" },
        },
      ],
    });
    assert.deepEqual(parseSourceEnvelope(metadataEnvelope), metadataEnvelope);

    for (const invalid of [
      createWikiState({ unexpected: true }),
      createWikiState({
        lastRun: {
          ...createWikiState().lastRun,
          unexpected: true,
        },
      }),
    ]) {
      assert.equal(captureMemexError(() => parseWikiState(invalid)).code, "INVALID_STATE");
    }

    for (const invalid of [
      createSourceEnvelope({ unexpected: true }),
      createSourceEnvelope({
        provenance: {
          ...createSourceEnvelope().provenance,
          unexpected: true,
        },
      }),
      createSourceEnvelope({
        items: [
          {
            externalId: "message-1",
            text: "Evidence",
            unexpected: true,
          },
        ],
      }),
    ]) {
      assert.equal(
        captureMemexError(() => parseSourceEnvelope(invalid)).code,
        "INVALID_ARGUMENT",
      );
    }
  });

  test("contracts: rejects unknown schema versions", () => {
    const stateError = captureMemexError(() =>
      parseWikiState(createWikiState({ schemaVersion: 2 })),
    );
    assert.deepEqual(stateError.toJSON(), {
      code: "INVALID_STATE",
      message: "Unsupported wiki state schema version. Expected 1.",
    });

    const envelopeError = captureMemexError(() =>
      parseSourceEnvelope(createSourceEnvelope({ schemaVersion: 2 })),
    );
    assert.deepEqual(envelopeError.toJSON(), {
      code: "INVALID_ARGUMENT",
      message: "Unsupported source envelope schema version. Expected 1.",
    });
  });

  test("contracts: rejects invalid timestamps at every timestamp boundary", () => {
    for (const state of [
      createWikiState({ createdAt: "yesterday" }),
      createWikiState({ updatedAt: "2026-02-30T10:00:00.000Z" }),
      createWikiState({
        lastRun: { ...createWikiState().lastRun, completedAt: "invalid" },
      }),
    ]) {
      assert.equal(captureMemexError(() => parseWikiState(state)).code, "INVALID_STATE");
    }

    for (const envelope of [
      createSourceEnvelope({ fetchedAt: "invalid" }),
      createSourceEnvelope({
        items: [
          {
            externalId: "message-1",
            text: "Evidence",
            occurredAt: "invalid",
          },
        ],
      }),
    ]) {
      assert.equal(
        captureMemexError(() => parseSourceEnvelope(envelope)).code,
        "INVALID_ARGUMENT",
      );
    }
  });

  test("contracts: rejects duplicate external IDs", () => {
    const envelope = createSourceEnvelope({
      items: [
        { externalId: "duplicate", text: "First" },
        { externalId: "duplicate", text: "Second" },
      ],
    });

    const error = captureMemexError(() => parseSourceEnvelope(envelope));
    assert.deepEqual(error.toJSON(), {
      code: "INVALID_ARGUMENT",
      message: "Source envelope contains duplicate externalId values.",
    });
  });

  test("contracts: enforces item, text, metadata, and total envelope limits", () => {
    const tooManyItems = Array.from({ length: MAX_ENVELOPE_ITEMS + 1 }, (_, index) => ({
      externalId: `item-${index}`,
      text: "bounded",
    }));
    assert.equal(
      captureMemexError(() =>
        parseSourceEnvelope(createSourceEnvelope({ items: tooManyItems })),
      ).code,
      "SOURCE_TOO_LARGE",
    );

    const oversizedText = "😀".repeat(Math.floor(MAX_ITEM_TEXT_BYTES / 4) + 1);
    assert.equal(
      captureMemexError(() =>
        parseSourceEnvelope(
          createSourceEnvelope({
            items: [{ externalId: "large-text", text: oversizedText }],
          }),
        ),
      ).code,
      "SOURCE_TOO_LARGE",
    );

    const oversizedMetadata = "é".repeat(Math.floor(MAX_METADATA_VALUE_BYTES / 2) + 1);
    assert.equal(
      captureMemexError(() =>
        parseSourceEnvelope(
          createSourceEnvelope({
            items: [
              {
                externalId: "large-metadata",
                text: "bounded",
                metadata: { value: oversizedMetadata },
              },
            ],
          }),
        ),
      ).code,
      "SOURCE_TOO_LARGE",
    );

    const boundedText = "x".repeat(MAX_ITEM_TEXT_BYTES);
    const oversizedEnvelope = createSourceEnvelope({
      items: Array.from({ length: 17 }, (_, index) => ({
        externalId: `large-envelope-${index}`,
        text: boundedText,
      })),
    });
    assert.ok(Buffer.byteLength(JSON.stringify(oversizedEnvelope), "utf8") > MAX_ENVELOPE_BYTES);
    assert.equal(
      captureMemexError(() => parseSourceEnvelope(oversizedEnvelope)).code,
      "SOURCE_TOO_LARGE",
    );
  });

  test("contracts: serializes typed errors to stable safe JSON", () => {
    const error = new MemexError("INVALID_STATE", "Wiki state is invalid.");

    assert.equal(error.name, "MemexError");
    assert.deepEqual(error.toJSON(), {
      code: "INVALID_STATE",
      message: "Wiki state is invalid.",
    });
    assert.equal(
      JSON.stringify(error),
      '{"code":"INVALID_STATE","message":"Wiki state is invalid."}',
    );
  });
});
