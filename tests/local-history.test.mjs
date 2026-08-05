import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import {
  clearHistoryResults,
  deleteHistoryResult,
  getHistoryBlob,
  historyErrorKind,
  listHistoryEntries,
  saveHistoryResult,
  sumHistoryBytes,
} from "../lib/local-history.ts";

function makeEntry(id, createdAt, sizeBytes) {
  return {
    id,
    schemaVersion: 1,
    createdAt,
    source: {
      name: "sample.mp4",
      sizeBytes: 4096,
      durationSeconds: 4,
      width: 1280,
      height: 720,
      fps: 29.97,
    },
    output: {
      name: `${id}.gif`,
      format: "gif",
      mimeType: "image/gif",
      sizeBytes,
    },
    settings: {
      start: 0,
      duration: 4,
      fps: 20,
      width: 640,
      plays: 0,
      gifColors: 160,
      gifStats: "diff",
      gifDither: "sierra2_4a",
      apngCompression: 6,
      preset: "auto",
      presetPolicyVersion: "test",
    },
    batch: null,
  };
}

test("local history stores metadata separately from exact blob bytes", async () => {
  const factory = new IDBFactory();
  const older = makeEntry("older", 10, 3);
  const newer = makeEntry("newer", 20, 4);
  const olderBlob = new Blob([new Uint8Array([1, 2, 3])], {
    type: "image/gif",
  });
  const newerBlob = new Blob([new Uint8Array([4, 5, 6, 7])], {
    type: "image/gif",
  });

  await saveHistoryResult(older, olderBlob, factory);
  await saveHistoryResult(newer, newerBlob, factory);

  const entries = await listHistoryEntries(factory);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["newer", "older"],
  );
  assert.equal("blob" in entries[0], false);
  assert.equal(sumHistoryBytes(entries), 7);

  const restored = await getHistoryBlob("newer", factory);
  assert.ok(restored);
  assert.equal(restored.type, "image/gif");
  assert.deepEqual(
    [...new Uint8Array(await restored.arrayBuffer())],
    [4, 5, 6, 7],
  );
});

test("delete and clear remove both history metadata and files", async () => {
  const factory = new IDBFactory();
  await saveHistoryResult(
    makeEntry("one", 1, 1),
    new Blob(["1"], { type: "image/gif" }),
    factory,
  );
  await saveHistoryResult(
    makeEntry("two", 2, 1),
    new Blob(["2"], { type: "image/gif" }),
    factory,
  );

  await deleteHistoryResult("one", factory);
  assert.equal(await getHistoryBlob("one", factory), null);
  assert.deepEqual(
    (await listHistoryEntries(factory)).map((entry) => entry.id),
    ["two"],
  );

  await clearHistoryResults(factory);
  assert.deepEqual(await listHistoryEntries(factory), []);
  assert.equal(await getHistoryBlob("two", factory), null);
});

test("queued delete and clear cannot be overtaken by pending saves", async () => {
  const deleteFactory = new IDBFactory();
  const pendingSave = saveHistoryResult(
    makeEntry("pending-delete", 1, 1),
    new Blob(["x"], { type: "image/gif" }),
    deleteFactory,
  );
  const pendingDelete = deleteHistoryResult("pending-delete", deleteFactory);
  await Promise.all([pendingSave, pendingDelete]);
  assert.deepEqual(await listHistoryEntries(deleteFactory), []);
  assert.equal(await getHistoryBlob("pending-delete", deleteFactory), null);

  const clearFactory = new IDBFactory();
  const firstSave = saveHistoryResult(
    makeEntry("pending-clear-a", 1, 1),
    new Blob(["a"], { type: "image/gif" }),
    clearFactory,
  );
  const secondSave = saveHistoryResult(
    makeEntry("pending-clear-b", 2, 1),
    new Blob(["b"], { type: "image/gif" }),
    clearFactory,
  );
  const pendingClear = clearHistoryResults(clearFactory);
  await Promise.all([firstSave, secondSave, pendingClear]);
  assert.deepEqual(await listHistoryEntries(clearFactory), []);
  assert.equal(await getHistoryBlob("pending-clear-a", clearFactory), null);
  assert.equal(await getHistoryBlob("pending-clear-b", clearFactory), null);
});

test("quota errors are classified without turning conversion into a failure", () => {
  const quotaError = new DOMException("full", "QuotaExceededError");
  assert.equal(historyErrorKind(quotaError), "quota-full");
  assert.equal(historyErrorKind(new Error("private mode")), "session-only");
});
