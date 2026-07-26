export const VIRTUAL_FILES = Object.freeze({
  input: "/input/source-video",
  palette: "palette.png",
  apngOutput: "converted.png",
  gifOutput: "converted.gif",
});

export const MODE_DEFAULTS = Object.freeze({
  Beginner: Object.freeze({
    fps: 12,
    width: 480,
    start: 0,
    duration: 6,
    plays: 0,
    gifColors: 128,
    gifStats: "diff",
    gifDither: "sierra2_4a",
    apngCompression: 6,
  }),
  Intermediate: Object.freeze({
    fps: 12,
    width: 480,
    start: 0,
    duration: 6,
    plays: 0,
    gifColors: 128,
    gifStats: "diff",
    gifDither: "sierra2_4a",
    apngCompression: 6,
  }),
  Advanced: Object.freeze({
    fps: 12,
    width: 480,
    start: 0,
    duration: 6,
    plays: 0,
    gifColors: 128,
    gifStats: "diff",
    gifDither: "sierra2_4a",
    apngCompression: 6,
  }),
});

export const INTERMEDIATE_PRESETS = Object.freeze({
  light: Object.freeze({
    fps: 8,
    width: 360,
    gifColors: 96,
    gifStats: "diff",
    gifDither: "sierra2_4a",
    apngCompression: 7,
  }),
  balanced: Object.freeze({
    fps: 12,
    width: 480,
    gifColors: 128,
    gifStats: "diff",
    gifDither: "sierra2_4a",
    apngCompression: 6,
  }),
  crisp: Object.freeze({
    fps: 15,
    width: 720,
    gifColors: 192,
    gifStats: "full",
    gifDither: "floyd_steinberg",
    apngCompression: 5,
  }),
});

const FORMATS = new Set(["apng", "gif"]);
const MODES = new Set(["Beginner", "Intermediate", "Advanced"]);
const PRESETS = new Set(Object.keys(INTERMEDIATE_PRESETS));
const GIF_STATS = new Set(["full", "diff"]);
const GIF_DITHERS = new Set([
  "sierra2_4a",
  "floyd_steinberg",
  "bayer",
  "none",
]);

function finiteNumber(value, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampInteger(value, min, max, fallback) {
  return Math.round(clamp(finiteNumber(value, fallback), min, max));
}

function formatNumber(value) {
  return Number(value.toFixed(3)).toString();
}

function boundedSourceDuration(sourceDuration) {
  const duration = finiteNumber(sourceDuration, Number.POSITIVE_INFINITY);
  return duration > 0 ? duration : Number.POSITIVE_INFINITY;
}

export function normalizeSettings(input = {}, sourceDuration) {
  const mode = MODES.has(input.mode) ? input.mode : "Beginner";
  const format = FORMATS.has(input.format) ? input.format : "gif";
  const preset = PRESETS.has(input.preset) ? input.preset : "balanced";
  const sourceLimit = boundedSourceDuration(sourceDuration);
  const modeDefaults = MODE_DEFAULTS[mode];
  const presetDefaults =
    mode === "Intermediate" ? INTERMEDIATE_PRESETS[preset] : {};
  const defaults = { ...modeDefaults, ...presetDefaults };
  const maximumStart = Number.isFinite(sourceLimit)
    ? Math.max(0, sourceLimit - 0.1)
    : sourceLimit;

  const start =
    mode === "Beginner"
      ? 0
      : clamp(finiteNumber(input.start, defaults.start), 0, maximumStart);
  const availableDuration = Math.max(0.1, sourceLimit - start);
  const requestedDuration =
    mode === "Beginner"
      ? Math.min(6, sourceLimit)
      : finiteNumber(input.duration, defaults.duration);
  const duration = clamp(requestedDuration, 0.1, availableDuration);

  return {
    format,
    mode,
    preset,
    start,
    duration,
    fps:
      mode === "Advanced"
        ? clampInteger(input.fps, 1, 30, defaults.fps)
        : defaults.fps,
    width:
      mode === "Advanced"
        ? clampInteger(input.width, 160, 1280, defaults.width)
        : defaults.width,
    plays:
      mode === "Beginner" || mode === "Intermediate"
        ? 0
        : clampInteger(input.plays, 0, 20, defaults.plays),
    gifColors:
      mode === "Advanced"
        ? clampInteger(input.gifColors, 2, 256, defaults.gifColors)
        : defaults.gifColors,
    gifStats:
      mode === "Advanced" && GIF_STATS.has(input.gifStats)
        ? input.gifStats
        : defaults.gifStats,
    gifDither:
      mode === "Advanced" && GIF_DITHERS.has(input.gifDither)
        ? input.gifDither
        : defaults.gifDither,
    apngCompression:
      mode === "Advanced"
        ? clampInteger(
            input.apngCompression,
            0,
            9,
            defaults.apngCompression,
          )
        : defaults.apngCompression,
  };
}

export function loopArguments(format, totalPlays) {
  const plays = clampInteger(totalPlays, 0, 20, 0);

  if (format === "apng") {
    return ["-plays", String(plays)];
  }

  return [
    "-loop",
    plays === 0 ? "0" : plays === 1 ? "-1" : String(plays - 1),
  ];
}

function trimArguments(settings) {
  return [
    "-ss",
    formatNumber(settings.start),
    "-t",
    formatNumber(settings.duration),
  ];
}

function videoFilter(settings) {
  return `fps=${settings.fps},scale='min(${settings.width},iw)':-2:flags=lanczos`;
}

export function buildApngCommand(settingsInput, sourceDuration) {
  const settings = normalizeSettings(
    { ...settingsInput, format: "apng" },
    sourceDuration,
  );

  return [
    ...trimArguments(settings),
    "-i",
    VIRTUAL_FILES.input,
    "-an",
    "-vf",
    videoFilter(settings),
    "-c:v",
    "apng",
    "-pix_fmt",
    "rgba",
    "-compression_level",
    String(settings.apngCompression),
    ...loopArguments("apng", settings.plays),
    "-f",
    "apng",
    VIRTUAL_FILES.apngOutput,
  ];
}

export function buildGifCommands(settingsInput, sourceDuration) {
  const settings = normalizeSettings(
    { ...settingsInput, format: "gif" },
    sourceDuration,
  );
  const filter = videoFilter(settings);
  const paletteFilter = `${filter},palettegen=max_colors=${settings.gifColors}:stats_mode=${settings.gifStats}`;
  const paletteUse =
    settings.gifDither === "bayer"
      ? "paletteuse=dither=bayer:bayer_scale=5"
      : `paletteuse=dither=${settings.gifDither}`;

  return {
    palette: [
      ...trimArguments(settings),
      "-i",
      VIRTUAL_FILES.input,
      "-an",
      "-vf",
      paletteFilter,
      "-frames:v",
      "1",
      VIRTUAL_FILES.palette,
    ],
    encode: [
      ...trimArguments(settings),
      "-i",
      VIRTUAL_FILES.input,
      "-i",
      VIRTUAL_FILES.palette,
      "-an",
      "-filter_complex",
      `[0:v]${filter}[video];[video][1:v]${paletteUse}`,
      ...loopArguments("gif", settings.plays),
      VIRTUAL_FILES.gifOutput,
    ],
  };
}

export function outputFileFor(format) {
  return format === "apng"
    ? {
        virtualName: VIRTUAL_FILES.apngOutput,
        extension: "png",
        mimeType: "image/png",
      }
    : {
        virtualName: VIRTUAL_FILES.gifOutput,
        extension: "gif",
        mimeType: "image/gif",
      };
}

export function safeDownloadName(sourceName, format) {
  const rawStem = String(sourceName || "video").replace(/\.[^./\\]+$/, "");
  const safeStem =
    rawStem
      .normalize("NFKC")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/^[.\s-]+/g, "")
      .replace(/[.\s-]+$/g, "")
      .slice(0, 80) || "video";
  const extension = format === "apng" ? "png" : "gif";

  return `${safeStem}-animated.${extension}`;
}
