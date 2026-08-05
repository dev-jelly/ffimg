import assert from "node:assert/strict";
import test from "node:test";

import {
  getBatchExecutionPlan,
  getBatchSettingsSafetyError,
  runBatchQueue,
} from "../lib/batch-queue.mjs";

function safetyInput(overrides = {}) {
  return {
    settings: { format: "gif", width: 480, fps: 12 },
    metadataAvailable: true,
    estimate: {
      status: "available",
      capped: false,
      rangeBytes: { upper: 8 * 1024 * 1024 },
      output: { width: 480, height: 270, frameCount: 72 },
    },
    ...overrides,
  };
}

test("batch safety blocks unknown high settings and preset hard failures", () => {
  assert.match(
    getBatchSettingsSafetyError(
      safetyInput({
        metadataAvailable: false,
        settings: { format: "gif", width: 720, fps: 18 },
      }),
    ),
    /480px/,
  );
  assert.equal(
    getBatchSettingsSafetyError(
      safetyInput({
        metadataAvailable: false,
        settings: { format: "gif", width: 480, fps: 12 },
      }),
    ),
    null,
  );
  assert.equal(
    getBatchSettingsSafetyError(
      safetyInput({ presetSafetyError: "source preset blocked" }),
    ),
    "source preset blocked",
  );
});

test("batch safety enforces output, workload, and memory hard caps", () => {
  assert.match(
    getBatchSettingsSafetyError(
      safetyInput({
        estimate: {
          status: "available",
          capped: false,
          rangeBytes: { upper: 160 * 1024 * 1024 },
          output: { width: 480, height: 270, frameCount: 72 },
        },
      }),
    ),
    /너무 커요/,
  );
  assert.match(
    getBatchSettingsSafetyError(
      safetyInput({
        estimate: {
          status: "available",
          capped: false,
          rangeBytes: { upper: 1 },
          output: { width: 1920, height: 1080, frameCount: 78 },
        },
      }),
    ),
    /프레임이 너무 많아요/,
  );
  assert.match(
    getBatchSettingsSafetyError(
      safetyInput({
        settings: { format: "apng", width: 1920, fps: 1 },
        estimate: {
          status: "available",
          capped: false,
          rangeBytes: { upper: 170 * 1024 * 1024 },
          output: { width: 1920, height: 1080, frameCount: 1 },
        },
      }),
    ),
    /메모리/,
  );
  assert.equal(getBatchSettingsSafetyError(safetyInput()), null);
});

test("batch execution stays sequential unless every parallel safety signal passes", () => {
  const safe = getBatchExecutionPlan({
    hardwareConcurrency: 10,
    deviceMemory: 8,
    fileSizeBytes: 80 * 1024 * 1024,
    jobCount: 3,
    estimatedWorkingSetBytes: 180 * 1024 * 1024,
  });
  assert.deepEqual(safe, { concurrency: 2, reason: "parallel-safe" });

  assert.equal(
    getBatchExecutionPlan({
      hardwareConcurrency: 10,
      jobCount: 3,
      fileSizeBytes: 1,
    }).concurrency,
    1,
  );
  assert.equal(
    getBatchExecutionPlan({
      hardwareConcurrency: 10,
      deviceMemory: 8,
      jobCount: 3,
      fileSizeBytes: 256 * 1024 * 1024,
    }).concurrency,
    1,
  );
  assert.equal(
    getBatchExecutionPlan({
      hardwareConcurrency: 10,
      deviceMemory: 8,
      jobCount: 3,
      fileSizeBytes: 1,
      hasRiskyJobs: true,
    }).concurrency,
    1,
  );
});

test("batch queue never exceeds two workers and preserves output order", async () => {
  let active = 0;
  let maximumActive = 0;
  const outcomes = await runBatchQueue([1, 2, 3, 4], {
    concurrency: 99,
    worker: async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      return value * 10;
    },
  });

  assert.equal(maximumActive, 2);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.value),
    [10, 20, 30, 40],
  );
});

test("one failed job does not stop later jobs", async () => {
  const started = [];
  const outcomes = await runBatchQueue(["first", "broken", "last"], {
    concurrency: 1,
    worker: async (value) => {
      started.push(value);
      if (value === "broken") throw new Error("broken input");
      return value;
    },
  });

  assert.deepEqual(started, ["first", "broken", "last"]);
  assert.equal(outcomes[0].status, "fulfilled");
  assert.equal(outcomes[1].status, "rejected");
  assert.equal(outcomes[2].status, "fulfilled");
});

test("aborting prevents queued jobs from starting", async () => {
  const controller = new AbortController();
  const started = [];
  const outcomes = await runBatchQueue([1, 2, 3], {
    concurrency: 1,
    signal: controller.signal,
    worker: async (value) => {
      started.push(value);
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    },
  });

  assert.deepEqual(started, [1]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ["cancelled", "cancelled", "cancelled"],
  );
});
