import assert from "node:assert/strict";
import test from "node:test";
import {
  buildApngCommand,
  buildApngCommandFromResolved,
  buildGifCommands,
  buildGifCommandsFromResolved,
  loopArguments,
  normalizeSettings,
  outputFileFor,
  safeDownloadName,
  VIRTUAL_FILES,
} from "../lib/ffmpeg-commands.mjs";

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag}`);
  return args[index + 1];
}

test("Beginner uses a short, balanced, decision-light configuration", () => {
  const settings = normalizeSettings(
    {
      format: "apng",
      mode: "Beginner",
      start: 99,
      duration: 50,
      fps: 30,
      width: 1280,
      plays: 8,
    },
    20,
  );

  assert.deepEqual(
    {
      start: settings.start,
      duration: settings.duration,
      fps: settings.fps,
      width: settings.width,
      plays: settings.plays,
    },
    { start: 0, duration: 6, fps: 12, width: 480, plays: 0 },
  );
});

test("Intermediate expands all four named presets and preserves bounded trim", () => {
  const expected = {
    light: [8, 360, 96],
    balanced: [12, 480, 128],
    crisp: [15, 720, 192],
    source: [20, 1280, 256],
  };

  for (const [preset, values] of Object.entries(expected)) {
    const settings = normalizeSettings(
      {
        mode: "Intermediate",
        preset,
        start: 2.5,
        duration: 50,
      },
      10,
    );
    assert.deepEqual(
      [settings.fps, settings.width, settings.gifColors],
      values,
    );
    assert.equal(settings.start, 2.5);
    assert.equal(settings.duration, 7.5);
  }
});

test("Advanced invalid numbers and boundaries are clamped", () => {
  const settings = normalizeSettings(
    {
      mode: "Advanced",
      start: -4,
      duration: "not-a-number",
      fps: 80,
      width: 12,
      plays: 99,
      gifColors: 1,
      gifStats: "invalid",
      gifDither: "invalid",
      apngCompression: -8,
    },
    3,
  );

  assert.equal(settings.start, 0);
  assert.equal(settings.duration, 3);
  assert.equal(settings.fps, 60);
  assert.equal(settings.width, 160);
  assert.equal(settings.plays, 20);
  assert.equal(settings.gifColors, 2);
  assert.equal(settings.gifStats, "diff");
  assert.equal(settings.gifDither, "sierra2_4a");
  assert.equal(settings.apngCompression, 0);

  const maximum = normalizeSettings({ mode: "Advanced", width: 9999 });
  assert.equal(maximum.width, 1920);
});

test("trim start always leaves a convertible slice of known media", () => {
  const settings = normalizeSettings(
    {
      mode: "Advanced",
      start: 30,
      duration: 5,
    },
    10,
  );

  assert.equal(settings.start, 9.9);
  assert.equal(settings.duration, 0.1);
});

test("duration follows the source length when known and is uncapped otherwise", () => {
  for (const mode of ["Intermediate", "Advanced"]) {
    const bounded = normalizeSettings({ mode, duration: 600 }, 10);
    assert.ok(bounded.duration <= 10);
    assert.ok(bounded.duration > 0);

    const openEnded = normalizeSettings({ mode, duration: 600 }, undefined);
    assert.equal(openEnded.duration, 600);
  }
});

test("APNG command contains trim, scale, frame, compression, and play options", () => {
  const args = buildApngCommand(
    {
      mode: "Advanced",
      start: 1.25,
      duration: 2.5,
      fps: 18,
      width: 640,
      plays: 3,
      apngCompression: 8,
    },
    12,
  );

  assert.equal(valueAfter(args, "-ss"), "1.25");
  assert.equal(valueAfter(args, "-t"), "2.5");
  assert.equal(valueAfter(args, "-i"), VIRTUAL_FILES.input);
  assert.match(valueAfter(args, "-vf"), /fps=18/);
  assert.match(valueAfter(args, "-vf"), /min\(640,iw\)/);
  assert.match(valueAfter(args, "-vf"), /flags=lanczos/);
  assert.equal(valueAfter(args, "-c:v"), "apng");
  assert.equal(valueAfter(args, "-compression_level"), "8");
  assert.equal(valueAfter(args, "-plays"), "3");
  assert.equal(args.at(-1), VIRTUAL_FILES.apngOutput);
});

test("GIF uses a two-pass palette workflow with selected settings", () => {
  const commands = buildGifCommands(
    {
      mode: "Advanced",
      start: 0.5,
      duration: 4,
      fps: 14,
      width: 560,
      plays: 4,
      gifColors: 220,
      gifStats: "full",
      gifDither: "bayer",
    },
    9,
  );

  assert.match(valueAfter(commands.palette, "-vf"), /palettegen=max_colors=220:stats_mode=full/);
  assert.equal(commands.palette.at(-1), VIRTUAL_FILES.palette);
  assert.equal(valueAfter(commands.encode, "-i"), VIRTUAL_FILES.input);
  assert.ok(commands.encode.includes(VIRTUAL_FILES.palette));
  assert.match(
    valueAfter(commands.encode, "-filter_complex"),
    /paletteuse=dither=bayer:bayer_scale=5/,
  );
  assert.equal(valueAfter(commands.encode, "-loop"), "3");
  assert.equal(commands.encode.at(-1), VIRTUAL_FILES.gifOutput);
});

test("resolved adaptive settings reach both encoders without mode defaults replacing them", () => {
  const resolved = {
    format: "gif",
    mode: "Beginner",
    preset: "auto",
    start: 0,
    duration: 3,
    fps: 24,
    width: 1920,
    plays: 0,
    gifColors: 224,
    gifStats: "full",
    gifDither: "floyd_steinberg",
    apngCompression: 8,
  };
  const gif = buildGifCommandsFromResolved(resolved);
  const apng = buildApngCommandFromResolved(resolved);

  assert.match(valueAfter(gif.palette, "-vf"), /fps=24/);
  assert.match(valueAfter(gif.palette, "-vf"), /min\(1920,iw\)/);
  assert.match(valueAfter(gif.palette, "-vf"), /max_colors=224/);
  assert.match(valueAfter(gif.encode, "-filter_complex"), /floyd_steinberg/);
  assert.match(valueAfter(apng, "-vf"), /fps=24/);
  assert.match(valueAfter(apng, "-vf"), /min\(1920,iw\)/);
  assert.equal(valueAfter(apng, "-compression_level"), "8");
});

test("decimal frame rates survive normalization and both FFmpeg command paths", () => {
  const resolved = {
    mode: "Advanced",
    start: 0,
    duration: 2,
    fps: 59.94,
    width: 640,
  };
  const gif = buildGifCommandsFromResolved(resolved);
  const apng = buildApngCommandFromResolved(resolved);

  assert.equal(normalizeSettings(resolved).fps, 59.94);
  assert.match(valueAfter(gif.palette, "-vf"), /^fps=59\.94,/);
  assert.match(valueAfter(apng, "-vf"), /^fps=59\.94,/);
});

test("total-play mapping follows each muxer", () => {
  assert.deepEqual(loopArguments("apng", 0), ["-plays", "0"]);
  assert.deepEqual(loopArguments("apng", 1), ["-plays", "1"]);
  assert.deepEqual(loopArguments("gif", 0), ["-loop", "0"]);
  assert.deepEqual(loopArguments("gif", 1), ["-loop", "-1"]);
  assert.deepEqual(loopArguments("gif", 5), ["-loop", "4"]);
});

test("virtual paths never interpolate a user filename", () => {
  const dangerousName = "../../private/input.mp4;rm -rf";
  const commands = buildGifCommands({ mode: "Beginner" }, 8);
  const serialized = JSON.stringify(commands);

  assert.doesNotMatch(serialized, /private|rm -rf/);
  assert.equal(VIRTUAL_FILES.input, "/input/source-video");
  assert.equal(
    safeDownloadName(dangerousName, "gif"),
    "private-input-animated.gif",
  );
});

test("unsupported per-frame GIF palettes fall back to a valid shared palette", () => {
  const settings = normalizeSettings({
    mode: "Advanced",
    gifStats: "single",
  });
  assert.equal(settings.gifStats, "diff");
});

test("output descriptors use browser-previewable image MIME types", () => {
  assert.deepEqual(outputFileFor("apng"), {
    virtualName: "converted.png",
    extension: "png",
    mimeType: "image/png",
  });
  assert.deepEqual(outputFileFor("gif"), {
    virtualName: "converted.gif",
    extension: "gif",
    mimeType: "image/gif",
  });
  assert.equal(safeDownloadName("여름 여행.mp4", "apng"), "여름 여행-animated.png");
});
