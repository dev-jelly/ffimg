import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPTIVE_PRESET_POLICY_VERSION,
  recommendBeginnerDuration,
  resolveAdaptivePreset,
} from "../lib/adaptive-presets.mjs";

const mebibyte = 1024 ** 2;

function resolve({
  format = "gif",
  preset = "auto",
  media,
  duration = media?.durationSeconds,
}) {
  return resolveAdaptivePreset({
    format,
    mode: "Intermediate",
    preset,
    media,
    trim: { start: 0, duration },
  });
}

test("short high-resolution media receives a substantially richer automatic preset", () => {
  const recommendation = resolve({
    media: {
      durationSeconds: 3,
      width: 3840,
      height: 2160,
      sizeBytes: 8 * mebibyte,
    },
  });

  assert.equal(recommendation.policyVersion, ADAPTIVE_PRESET_POLICY_VERSION);
  assert.equal(recommendation.intent, "crisp");
  assert.ok(recommendation.settings.width >= 960);
  assert.ok(recommendation.settings.fps >= 20);
  assert.equal(recommendation.rationale, "short-source");
});

test("a long full-length source is reduced more than a short source", () => {
  const media = {
    durationSeconds: 60,
    width: 1920,
    height: 1080,
    sizeBytes: 120 * mebibyte,
  };
  const short = resolve({ media, duration: 4 });
  const full = resolve({ media, duration: 60 });

  assert.equal(full.intent, "light");
  assert.equal(full.rationale, "long-duration");
  assert.ok(full.settings.width < short.settings.width);
  assert.ok(full.settings.fps < short.settings.fps);
});

test("automatic recommendations change smoothly around former duration cutoffs", () => {
  const media = {
    durationSeconds: 60,
    width: 1920,
    height: 1080,
    sizeBytes: 120 * mebibyte,
  };

  for (const [leftDuration, rightDuration] of [
    [5, 5.001],
    [23.999, 24],
  ]) {
    const left = resolve({ media, duration: leftDuration });
    const right = resolve({ media, duration: rightDuration });
    assert.ok(Math.abs(left.settings.width - right.settings.width) <= 240);
    assert.ok(Math.abs(left.settings.fps - right.settings.fps) <= 4);
  }
});

test("very long conversions expose workload risk even when output bytes look small", () => {
  const recommendation = resolve({
    format: "apng",
    media: {
      durationSeconds: 600,
      width: 3840,
      height: 2160,
      sizeBytes: 1024 * mebibyte,
    },
    duration: 600,
  });

  assert.equal(recommendation.risk.level, "high");
  assert.equal(recommendation.risk.reason, "workload");
  assert.ok(recommendation.risk.workUnits > 0);
  assert.ok(recommendation.estimate.rangeBytes.upper < 128 * mebibyte);
});

test("named intents preserve increasing quality headroom for the same file", () => {
  const media = {
    durationSeconds: 12,
    width: 1920,
    height: 1080,
    sizeBytes: 20 * mebibyte,
  };
  const light = resolve({ media, preset: "light" });
  const balanced = resolve({ media, preset: "balanced" });
  const crisp = resolve({ media, preset: "crisp" });
  const lightDetail =
    light.output.width * light.output.height * light.settings.fps;
  const balancedDetail =
    balanced.output.width * balanced.output.height * balanced.settings.fps;
  const crispDetail =
    crisp.output.width * crisp.output.height * crisp.settings.fps;

  assert.ok(light.output.width <= balanced.output.width);
  assert.ok(balanced.output.width <= crisp.output.width);
  assert.ok(lightDetail <= balancedDetail);
  assert.ok(balancedDetail <= crispDetail);
  assert.ok(light.settings.gifColors < balanced.settings.gifColors);
  assert.ok(balanced.settings.gifColors < crisp.settings.gifColors);
});

test("portrait and low-resolution sources are never upscaled past their source width", () => {
  const portrait = resolve({
    preset: "crisp",
    media: {
      durationSeconds: 10,
      width: 720,
      height: 1280,
      sizeBytes: 10 * mebibyte,
    },
  });
  const lowResolution = resolve({
    preset: "crisp",
    media: {
      durationSeconds: 6,
      width: 320,
      height: 240,
      sizeBytes: mebibyte,
    },
  });

  assert.ok(portrait.output.width <= 720);
  assert.ok(lowResolution.output.width <= 320);
  assert.equal(lowResolution.output.width, 320);
});

test("format-aware recommendations avoid ineffective APNG compression level zero", () => {
  const media = {
    durationSeconds: 10,
    width: 1920,
    height: 1080,
    sizeBytes: 18 * mebibyte,
  };
  const gif = resolve({ format: "gif", media, preset: "balanced" });
  const apng = resolve({ format: "apng", media, preset: "balanced" });

  assert.ok(apng.settings.apngCompression >= 7);
  assert.ok(apng.settings.apngCompression <= 8);
  assert.notEqual(apng.settings.apngCompression, 0);
  assert.ok(gif.settings.gifColors >= 96);
  assert.notEqual(gif.estimate.rangeBytes.likely, apng.estimate.rangeBytes.likely);
  assert.equal(gif.risk.workUnits, gif.risk.pixelFrames * 2);
  assert.equal(apng.risk.workUnits, apng.risk.pixelFrames);
});

test("missing metadata has a deterministic, modest fallback", () => {
  const first = resolveAdaptivePreset({ format: "gif" });
  const second = resolveAdaptivePreset({ format: "gif" });

  assert.deepEqual(first, second);
  assert.equal(first.metadataAvailable, false);
  assert.equal(first.settings.width, 480);
  assert.equal(first.settings.fps, 12);
  assert.equal(first.risk.level, "unknown");
});

test("unsupported metadata extremes use the same safe fallback contract", () => {
  for (const media of [
    { durationSeconds: 0.05, width: 1920, height: 1080 },
    { durationSeconds: 4, width: 100_001, height: 1080 },
  ]) {
    const recommendation = resolve({ media });
    assert.equal(recommendation.metadataAvailable, false);
    assert.equal(recommendation.settings.duration >= 0.1, true);
    assert.equal(recommendation.risk.reason, "metadata-unavailable");
  }
});

test("beginner trim length follows source duration instead of a fixed six seconds", () => {
  const profile = { width: 1920, height: 1080 };

  assert.equal(
    recommendBeginnerDuration({ ...profile, durationSeconds: 3 }),
    3,
  );
  assert.equal(
    recommendBeginnerDuration({ ...profile, durationSeconds: 20 }),
    12,
  );
  assert.equal(
    recommendBeginnerDuration({ ...profile, durationSeconds: 60 }),
    10,
  );
});
