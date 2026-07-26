import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSettings } from "../lib/ffmpeg-commands.mjs";
import {
  estimateOutputSize,
  OUTPUT_SIZE_ESTIMATOR_LIMITS,
  OUTPUT_SIZE_MODEL_VERSION,
} from "../lib/output-size-estimator.mjs";

const DEFAULT_MEDIA = Object.freeze({
  durationSeconds: 12,
  width: 1920,
  height: 1080,
  sizeBytes: 5 * 1024 ** 2,
});

function settings(overrides = {}) {
  return normalizeSettings({
    mode: "Advanced",
    format: "gif",
    start: 0,
    duration: 4,
    fps: 12,
    width: 480,
    plays: 0,
    gifColors: 128,
    gifStats: "diff",
    gifDither: "sierra2_4a",
    apngCompression: 6,
    ...overrides,
  });
}

function estimate(settingsOverrides = {}, mediaOverrides = {}) {
  return estimateOutputSize({
    settings: settings(settingsOverrides),
    media: { ...DEFAULT_MEDIA, ...mediaOverrides },
  });
}

function assertBoundedAvailable(result) {
  assert.equal(result.status, "available");
  assert.equal(result.reason, null);
  assert.ok(Number.isInteger(result.rangeBytes.lower));
  assert.ok(Number.isInteger(result.rangeBytes.likely));
  assert.ok(Number.isInteger(result.rangeBytes.upper));
  assert.ok(Number.isFinite(result.rangeBytes.lower));
  assert.ok(Number.isFinite(result.rangeBytes.likely));
  assert.ok(Number.isFinite(result.rangeBytes.upper));
  assert.ok(
    result.rangeBytes.lower >= OUTPUT_SIZE_ESTIMATOR_LIMITS.minimumBytes,
  );
  assert.ok(
    result.rangeBytes.upper <= OUTPUT_SIZE_ESTIMATOR_LIMITS.maximumBytes,
  );
  assert.ok(result.rangeBytes.lower <= result.rangeBytes.upper);
  assert.ok(result.rangeBytes.lower <= result.rangeBytes.likely);
  assert.ok(result.rangeBytes.likely <= result.rangeBytes.upper);
  assert.ok(Number.isInteger(result.output.width));
  assert.ok(Number.isInteger(result.output.height));
  assert.ok(Number.isInteger(result.output.frameCount));
  assert.equal(typeof result.capped, "boolean");
}

test("returns the stable machine-readable contract and model version", () => {
  const result = estimate();

  assert.deepEqual(Object.keys(result), [
    "modelVersion",
    "status",
    "reason",
    "rangeBytes",
    "output",
    "confidence",
    "primaryUncertainty",
    "sizeClass",
    "capped",
  ]);
  assert.equal(result.modelVersion, OUTPUT_SIZE_MODEL_VERSION);
  assert.equal(result.status, "available");
  assert.equal(result.confidence, "limited");
  assert.equal(result.primaryUncertainty, "visual-complexity");
  assert.deepEqual(Object.keys(result.rangeBytes), [
    "lower",
    "likely",
    "upper",
  ]);
  assert.deepEqual(Object.keys(result.output), [
    "width",
    "height",
    "frameCount",
  ]);
  assertBoundedAvailable(result);
});

test("is deterministic and does not mutate inputs", () => {
  const normalized = Object.freeze(settings());
  const media = Object.freeze({ ...DEFAULT_MEDIA });
  const input = Object.freeze({ settings: normalized, media });
  const before = JSON.stringify(input);

  assert.deepEqual(estimateOutputSize(input), estimateOutputSize(input));
  assert.equal(JSON.stringify(input), before);
});

test("reports missing and invalid essential inputs without synthetic bytes", () => {
  const missingCases = [
    undefined,
    {},
    { durationSeconds: null, width: 10, height: 10 },
    { durationSeconds: 1, width: null, height: 10 },
    { durationSeconds: 1, width: 10, height: undefined },
  ];
  for (const media of missingCases) {
    const result = estimateOutputSize({ settings: settings(), media });
    assert.deepEqual(result.rangeBytes, null);
    assert.deepEqual(result.output, {
      width: null,
      height: null,
      frameCount: null,
    });
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "missing-metadata");
    assert.equal(result.confidence, "unavailable");
    assert.equal(result.sizeClass, "unavailable");
    assert.equal(result.capped, false);
  }

  const invalidMediaCases = [
    { ...DEFAULT_MEDIA, durationSeconds: 0 },
    { ...DEFAULT_MEDIA, durationSeconds: Number.NaN },
    { ...DEFAULT_MEDIA, width: -1 },
    { ...DEFAULT_MEDIA, height: Number.POSITIVE_INFINITY },
    { ...DEFAULT_MEDIA, sizeBytes: 0 },
    {
      ...DEFAULT_MEDIA,
      width: OUTPUT_SIZE_ESTIMATOR_LIMITS.maximumSourceDimension + 1,
    },
  ];
  for (const media of invalidMediaCases) {
    const result = estimateOutputSize({ settings: settings(), media });
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "invalid-input");
    assert.equal(result.rangeBytes, null);
  }

  for (const invalidSettings of [
    null,
    { ...settings(), duration: Number.NaN },
    { ...settings(), fps: 31 },
    { ...settings(), width: 159 },
    { ...settings(), gifColors: 257 },
    { ...settings(), gifStats: "single" },
    { ...settings(), gifDither: "unknown" },
    { ...settings({ format: "apng" }), apngCompression: -1 },
  ]) {
    const result = estimateOutputSize({
      settings: invalidSettings,
      media: DEFAULT_MEDIA,
    });
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "invalid-input");
  }
});

test("keeps tiny, portrait, extreme-aspect, and maximum inputs bounded", () => {
  const cases = [
    estimate(
      { duration: 0.1, fps: 1, width: 160 },
      { durationSeconds: 0.01, width: 1, height: 1, sizeBytes: 1 },
    ),
    estimate({}, { width: 1080, height: 1920 }),
    estimate(
      { width: 1280 },
      {
        width: 2,
        height: OUTPUT_SIZE_ESTIMATOR_LIMITS.maximumSourceDimension,
      },
    ),
    estimate(
      {
        format: "apng",
        duration: 30,
        fps: 30,
        width: 1280,
        apngCompression: 0,
      },
      {
        durationSeconds: 30,
        width: 1280,
        height: OUTPUT_SIZE_ESTIMATOR_LIMITS.maximumSourceDimension,
        sizeBytes: Number.MAX_VALUE,
      },
    ),
  ];

  for (const result of cases) assertBoundedAvailable(result);
  assert.deepEqual(cases[0].output, {
    width: 1,
    height: 2,
    frameCount: 1,
  });
  assert.equal(cases[2].output.height % 2, 0);
  assert.equal(
    cases[3].rangeBytes.upper,
    OUTPUT_SIZE_ESTIMATOR_LIMITS.maximumBytes,
  );
});

test("matches FFmpeg width saturation and even aspect-preserving height", () => {
  const saturated = estimate({ width: 1280 }, { width: 321, height: 181 });
  const scaled = estimate({ width: 480 }, { width: 1920, height: 1080 });

  assert.deepEqual(saturated.output, {
    width: 321,
    height: 182,
    frameCount: 48,
  });
  assert.deepEqual(scaled.output, {
    width: 480,
    height: 270,
    frameCount: 48,
  });
});

test("duration, FPS, and unsaturated width never decrease either bound", () => {
  for (const values of [
    [estimate({ duration: 1 }), estimate({ duration: 8 })],
    [estimate({ fps: 6 }), estimate({ fps: 24 })],
    [estimate({ width: 320 }), estimate({ width: 960 })],
  ]) {
    const [smaller, larger] = values;
    assert.ok(larger.rangeBytes.lower >= smaller.rangeBytes.lower);
    assert.ok(larger.rangeBytes.likely >= smaller.rangeBytes.likely);
    assert.ok(larger.rangeBytes.upper >= smaller.rangeBytes.upper);
  }
});

test("supports long source durations while keeping frame counts safe", () => {
  const long = estimate(
    { duration: 600, fps: 30 },
    { durationSeconds: 600 },
  );
  assertBoundedAvailable(long);
  assert.equal(long.output.frameCount, 18_000);

  const unsafe = estimateOutputSize({
    settings: {
      ...settings(),
      duration: Number.MAX_VALUE,
    },
    media: DEFAULT_MEDIA,
  });
  assert.equal(unsafe.status, "unavailable");
  assert.equal(unsafe.reason, "invalid-input");
});

test("GIF colors increase smoothly while APNG compression decreases size", () => {
  let previousGif = estimate({ gifColors: 2 });
  for (const gifColors of [3, 16, 64, 128, 192, 256]) {
    const current = estimate({ gifColors });
    assert.ok(current.rangeBytes.lower >= previousGif.rangeBytes.lower);
    assert.ok(current.rangeBytes.likely >= previousGif.rangeBytes.likely);
    assert.ok(current.rangeBytes.upper >= previousGif.rangeBytes.upper);
    previousGif = current;
  }

  let previousApng = estimate({
    format: "apng",
    apngCompression: 0,
  });
  for (const apngCompression of [1, 3, 6, 9]) {
    const current = estimate({ format: "apng", apngCompression });
    assert.ok(current.rangeBytes.lower <= previousApng.rangeBytes.lower);
    assert.ok(current.rangeBytes.likely <= previousApng.rangeBytes.likely);
    assert.ok(current.rangeBytes.upper <= previousApng.rangeBytes.upper);
    previousApng = current;
  }
});

test("settings belonging only to the other format have no effect", () => {
  assert.deepEqual(
    estimate({ format: "gif", apngCompression: 0 }),
    estimate({ format: "gif", apngCompression: 9 }),
  );
  assert.deepEqual(
    estimate({
      format: "apng",
      gifColors: 2,
      gifStats: "diff",
      gifDither: "none",
    }),
    estimate({
      format: "apng",
      gifColors: 256,
      gifStats: "full",
      gifDither: "floyd_steinberg",
    }),
  );
});

test("source size is an optional log-scaled hint, never a guarantee", () => {
  const absent = estimate({}, { sizeBytes: null });
  const flat = estimate(
    {},
    {
      durationSeconds: 4,
      width: 640,
      height: 360,
      sizeBytes: 4391,
    },
  );
  const detailed = estimate(
    {},
    {
      durationSeconds: 4,
      width: 640,
      height: 360,
      sizeBytes: 3_786_581,
    },
  );

  assertBoundedAvailable(absent);
  assertBoundedAvailable(flat);
  assertBoundedAvailable(detailed);
  assert.ok(flat.rangeBytes.likely < detailed.rangeBytes.likely);
  assert.ok(flat.rangeBytes.upper < detailed.rangeBytes.upper);
});

test("both formats produce valid distinct estimates without cross-format claims", () => {
  const gif = estimate({ format: "gif" });
  const apng = estimate({ format: "apng" });

  assertBoundedAvailable(gif);
  assertBoundedAvailable(apng);
  assert.notDeepEqual(gif.rangeBytes, apng.rangeBytes);
});

test("classifies normal, large, and very large conservative estimates", () => {
  const normal = estimate();
  const large = estimate(
    {
      format: "apng",
      duration: 6,
      fps: 20,
      width: 640,
      apngCompression: 6,
    },
    {
      durationSeconds: 6,
      width: 640,
      height: 360,
      sizeBytes: 20 * 1024 ** 2,
    },
  );
  const veryLarge = estimate(
    {
      format: "apng",
      duration: 6,
      fps: 20,
      width: 640,
      apngCompression: 0,
    },
    {
      durationSeconds: 6,
      width: 640,
      height: 360,
      sizeBytes: 20 * 1024 ** 2,
    },
  );

  assert.equal(normal.sizeClass, "normal");
  assert.equal(large.sizeClass, "large");
  assert.equal(veryLarge.sizeClass, "very-large");
  assert.ok(
    large.rangeBytes.upper >=
      OUTPUT_SIZE_ESTIMATOR_LIMITS.largeThresholdBytes,
  );
  assert.ok(
    large.rangeBytes.upper <
      OUTPUT_SIZE_ESTIMATOR_LIMITS.veryLargeThresholdBytes,
  );
  assert.ok(
    veryLarge.rangeBytes.upper >=
      OUTPUT_SIZE_ESTIMATOR_LIMITS.veryLargeThresholdBytes,
  );
  assert.ok(640 * 360 * 6 * 20 <= 32_000_000);
});

test("contains measured flat, motion, and detailed outputs in its ranges", () => {
  const fixtures = [
    { sizeBytes: 4391, gif: 2606, apng: 4273 },
    { sizeBytes: 445_671, gif: 698_419, apng: 2_175_890 },
    { sizeBytes: 3_786_581, gif: 2_832_976, apng: 7_699_725 },
  ];

  for (const fixture of fixtures) {
    for (const format of ["gif", "apng"]) {
      const result = estimate(
        { format },
        {
          durationSeconds: 4,
          width: 640,
          height: 360,
          sizeBytes: fixture.sizeBytes,
        },
      );
      assert.ok(result.rangeBytes.lower <= fixture[format]);
      assert.ok(fixture[format] <= result.rangeBytes.upper);
    }
  }
});

test("contains measured GIF palette and APNG compression calibration points", () => {
  const motionMedia = {
    durationSeconds: 4,
    width: 640,
    height: 360,
    sizeBytes: 445_671,
  };
  const gifMeasurements = new Map([
    [32, 512_438],
    [64, 626_997],
    [128, 698_419],
    [256, 799_962],
  ]);
  const apngMeasurements = new Map([
    [1, 2_515_302],
    [3, 2_436_326],
    [6, 2_175_890],
    [9, 2_133_788],
  ]);

  for (const [gifColors, actualBytes] of gifMeasurements) {
    const result = estimate({ gifColors }, motionMedia);
    assert.ok(result.rangeBytes.lower <= actualBytes);
    assert.ok(actualBytes <= result.rangeBytes.upper);
  }

  for (const [apngCompression, actualBytes] of apngMeasurements) {
    const result = estimate(
      { format: "apng", apngCompression },
      motionMedia,
    );
    assert.ok(result.rangeBytes.lower <= actualBytes);
    assert.ok(actualBytes <= result.rangeBytes.upper);
  }
});

test("models APNG level zero as a broad raw-frame discontinuity", () => {
  const flatLevelZero = estimate(
    { format: "apng", apngCompression: 0 },
    {
      durationSeconds: 4,
      width: 640,
      height: 360,
      sizeBytes: 4391,
    },
  );
  const motionLevelZero = estimate(
    { format: "apng", apngCompression: 0 },
    {
      durationSeconds: 4,
      width: 640,
      height: 360,
      sizeBytes: 445_671,
    },
  );
  const compressed = estimate(
    { format: "apng", apngCompression: 1 },
    {
      durationSeconds: 4,
      width: 640,
      height: 360,
      sizeBytes: 445_671,
    },
  );

  assert.ok(flatLevelZero.rangeBytes.lower <= 523_694);
  assert.ok(523_694 <= flatLevelZero.rangeBytes.upper);
  assert.ok(motionLevelZero.rangeBytes.lower <= 24_335_698);
  assert.ok(24_335_698 <= motionLevelZero.rangeBytes.upper);
  assert.ok(
    motionLevelZero.rangeBytes.upper > compressed.rangeBytes.upper * 2,
  );
});

test("locks versioned default GIF and APNG fixtures", () => {
  const gif = estimate({ format: "gif" });
  const apng = estimate({ format: "apng" });

  assert.equal(OUTPUT_SIZE_MODEL_VERSION, "ffimg-size-v1");
  assert.deepEqual(gif.rangeBytes, {
    lower: 6605,
    likely: 372551,
    upper: 1232269,
  });
  assert.deepEqual(apng.rangeBytes, {
    lower: 13943,
    likely: 1369035,
    upper: 3346749,
  });
});

test("reports when the hard byte ceiling collapses optimizer candidates", () => {
  const result = estimate(
    {
      format: "apng",
      duration: 30,
      fps: 30,
      width: 1280,
      apngCompression: 0,
    },
    {
      durationSeconds: 30,
      width: 1280,
      height: OUTPUT_SIZE_ESTIMATOR_LIMITS.maximumSourceDimension,
      sizeBytes: Number.MAX_VALUE,
    },
  );

  assert.equal(result.capped, true);
  assert.equal(
    result.rangeBytes.upper,
    OUTPUT_SIZE_ESTIMATOR_LIMITS.maximumBytes,
  );
});
