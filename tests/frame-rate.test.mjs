import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMON_FRAME_RATES,
  estimateFrameRateFromSamples,
  formatFrameRate,
  getSourceAwareFrameRateOptions,
  normalizeFrameRate,
  parseFrameRate,
} from "../lib/frame-rate.mjs";

test("normalizes, clamps, parses, and formats decimal frame rates", () => {
  assert.equal(normalizeFrameRate(23.9764), 23.976);
  assert.equal(normalizeFrameRate(120), 60);
  assert.equal(normalizeFrameRate("bad", 29.97), 29.97);
  assert.equal(parseFrameRate("24000/1001"), 23.976);
  assert.equal(parseFrameRate("30000/1001"), 29.97);
  assert.equal(parseFrameRate("0/0"), null);
  assert.equal(formatFrameRate(59.94), "59.94");
  assert.equal(formatFrameRate(120), "120");
  assert.ok(COMMON_FRAME_RATES.includes(59.94));
});

test("source-aware options include the exact source and never exceed it", () => {
  const options = getSourceAwareFrameRateOptions(23.976);
  assert.equal(options.at(-1), 23.976);
  assert.ok(options.every((fps) => fps <= 23.976));

  const targeted = getSourceAwareFrameRateOptions(59.94, {
    fpsTarget: 29.97,
  });
  assert.equal(targeted.at(-1), 29.97);
  assert.ok(targeted.every((fps) => fps <= 29.97));
});

test("sample estimation accounts for skipped presentation callbacks", () => {
  const samples = [
    { mediaTime: 0, presentedFrames: 1 },
    { mediaTime: 0.1001, presentedFrames: 4 },
    { mediaTime: 0.2002, presentedFrames: 7 },
    { mediaTime: 0.333667, presentedFrames: 11 },
  ];
  const before = structuredClone(samples);

  assert.equal(estimateFrameRateFromSamples(samples), 29.97);
  assert.deepEqual(samples, before);
});

test("sample estimation ignores malformed and non-forward pairs", () => {
  assert.equal(estimateFrameRateFromSamples([]), null);
  assert.equal(
    estimateFrameRateFromSamples([
      { mediaTime: 0, presentedFrames: 1 },
      { mediaTime: 0, presentedFrames: 2 },
      { mediaTime: "invalid", presentedFrames: 3 },
    ]),
    null,
  );
});
