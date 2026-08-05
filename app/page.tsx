"use client";

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Lightbox } from "@astryxdesign/core/Lightbox";
import {
  Selector,
  type SelectorOptionType,
} from "@astryxdesign/core/Selector";
import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  normalizeSettings,
  safeDownloadName,
} from "@/lib/ffmpeg-commands.mjs";
import {
  ADAPTIVE_PRESET_POLICY_VERSION,
  recommendBeginnerDuration,
  resolveAdaptivePreset,
} from "@/lib/adaptive-presets.mjs";
import {
  FFMPEG_CORE_NOTICE,
  type BrowserFfmpeg,
} from "@/lib/ffmpeg-runtime";
import {
  estimateOutputSize,
  OUTPUT_SIZE_MODEL_VERSION,
} from "@/lib/output-size-estimator.mjs";
import {
  estimateFrameRateFromSamples,
  formatFrameRate,
  getSourceAwareFrameRateOptions,
} from "@/lib/frame-rate.mjs";
import {
  convertLocalVideo,
  type ConversionStage,
  type ResolvedConversionSettings,
} from "@/lib/browser-converter";
import {
  getBatchExecutionPlan,
  getBatchSettingsSafetyError,
  runBatchQueue,
} from "@/lib/batch-queue.mjs";
import {
  clearHistoryResults,
  deleteHistoryResult,
  getHistoryBlob,
  historyErrorKind,
  listHistoryEntries,
  saveHistoryResult,
  sumHistoryBytes,
  type HistoryEntry,
  type HistoryPersistence,
} from "@/lib/local-history";

type Format = "apng" | "gif";
type Mode = "Beginner" | "Intermediate" | "Advanced";
type Preset = "auto" | "light" | "balanced" | "crisp" | "source";
type BatchPreset = Preset | "custom";
type Workflow = "single" | "batch";
type BatchJobStatus =
  | "ready"
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "cancelled";
type Phase =
  | "idle"
  | "inspecting"
  | "ready"
  | "loading"
  | "preparing"
  | "palette"
  | "encoding"
  | "finalizing"
  | "complete"
  | "cancelled"
  | "error";

type VideoMetadata = {
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  previewAvailable: boolean;
};

type FpsPreference = "recommended" | `fps:${string}`;

type RecommendedEncodingSettings = {
  fps: number;
  width: number;
  gifColors: number;
  gifStats: string;
  gifDither: string;
  apngCompression: number;
};

type BatchJob = {
  id: string;
  label: string;
  preset: BatchPreset;
  settings: ResolvedConversionSettings;
  presetSafetyError: string | null;
  status: BatchJobStatus;
  progress: number;
  stageMessage: string;
  error: string | null;
  historyId: string | null;
};

type HistoryItem = HistoryEntry & {
  persistence: HistoryPersistence;
};

type DeviceHints = {
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
};

const SUPPORTED_EXTENSIONS = new Set([
  "mp4",
  "mov",
  "m4v",
  "webm",
  "mkv",
  "avi",
  "mpg",
  "mpeg",
  "ogv",
]);
const MAX_FILE_SIZE = 1024 * 1024 * 1024;
const LARGE_FILE_WARNING_SIZE = 700 * 1024 * 1024;
const MAX_BATCH_JOBS = 5;
const MEBIBYTE = 1024 ** 2;
const MAX_SESSION_HISTORY_RESULTS = 3;
const MAX_SESSION_HISTORY_BYTES = 256 * MEBIBYTE;
const BATCH_RUNNABLE_STATUSES = new Set<BatchJobStatus>([
  "ready",
  "failed",
  "cancelled",
]);
const ACTIVE_PHASES = new Set<Phase>([
  "loading",
  "preparing",
  "palette",
  "encoding",
  "finalizing",
]);

const MODE_COPY: Array<{
  name: Mode;
  label: string;
  eyebrow: string;
  description: string;
}> = [
  {
    name: "Beginner",
    label: "초보자",
    eyebrow: "처음이라면",
    description: "결정은 최소로, 안전한 기본값으로",
  },
  {
    name: "Intermediate",
    label: "중급자",
    eyebrow: "조금 익숙하다면",
    description: "용량과 선명도의 균형을 빠르게",
  },
  {
    name: "Advanced",
    label: "고급",
    eyebrow: "직접 조절하려면",
    description: "프레임, 크기, 반복과 인코딩을 정밀하게",
  },
];

const PRESET_COPY: Array<{
  id: Preset;
  name: string;
  description: string;
}> = [
  { id: "auto", name: "자동 추천", description: "이 영상에 맞춘 추천" },
  { id: "light", name: "용량 작게", description: "공유하기 쉬운 작은 파일" },
  { id: "balanced", name: "균형 있게", description: "화질과 용량의 균형" },
  { id: "crisp", name: "더 선명하게", description: "글자와 디테일 우선" },
  {
    id: "source",
    name: "원본 가깝게",
    description: "도구 한도에서 원본 크기와 FPS 우선",
  },
];

const BATCH_PRESET_COPY: Array<{
  id: Exclude<BatchPreset, "custom">;
  label: string;
}> = [
  { id: "auto", label: "핌쥐 추천" },
  { id: "light", label: "가볍게" },
  { id: "balanced", label: "균형 있게" },
  { id: "crisp", label: "더 선명하게" },
  { id: "source", label: "원본 가깝게" },
];

const BATCH_STATUS_COPY: Record<BatchJobStatus, string> = {
  ready: "준비됨",
  queued: "대기 중",
  running: "변환 중",
  complete: "완료",
  failed: "실패",
  cancelled: "취소됨",
};

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatEstimatedRange(lowerBytes: number, upperBytes: number) {
  const lower = formatBytes(lowerBytes);
  const upper = formatBytes(upperBytes);
  return lower === upper ? `약 ${lower}` : `약 ${lower} - ${upper}`;
}

function formatPresetGeometry(width: number, height: number | null) {
  return height ? `${width} × ${height}px` : `최대 ${width}px`;
}

function formatPresetEstimate(
  estimate: { rangeBytes: { lower: number; upper: number } } | null,
) {
  return estimate
    ? `예상 ${formatEstimatedRange(
        estimate.rangeBytes.lower,
        estimate.rangeBytes.upper,
      )}`
    : "예상 용량 확인 불가";
}

function formatDuration(duration: number | null) {
  if (!duration || !Number.isFinite(duration)) return "확인 불가";
  const minutes = Math.floor(duration / 60);
  const seconds = Math.floor(duration % 60);
  return minutes ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}

function formatHistoryDate(timestamp: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function createLocalId(prefix: string) {
  const value =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

function currentTimestamp() {
  return Date.now();
}

function settingsSummary(settings: ResolvedConversionSettings) {
  const common = `${Number(settings.duration.toFixed(1))}초 / ${formatFrameRate(settings.fps)} FPS / ${settings.width}px`;
  return settings.format === "gif"
    ? `${common} / ${settings.gifColors}색`
    : `${common} / 압축 ${settings.apngCompression}`;
}

function makeBatchDownloadName(
  sourceName: string,
  format: Format,
  label: string,
  index: number,
) {
  const baseName = safeDownloadName(sourceName, format);
  const extension = format === "apng" ? ".png" : ".gif";
  const stem = baseName.slice(0, -extension.length);
  const safeLabel =
    label
      .normalize("NFKC")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 36) || `결과-${index + 1}`;
  return `${stem}-${safeLabel}${extension}`;
}

function mergeHistoryItems(current: HistoryItem[], incoming: HistoryItem[]) {
  const merged = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) merged.set(entry.id, entry);
  return [...merged.values()].sort(
    (left, right) => right.createdAt - left.createdAt,
  );
}

function focusAfterRender(id: string) {
  window.requestAnimationFrame(() => {
    document.getElementById(id)?.focus({ preventScroll: true });
  });
}

function formatSourceFrameRate(fps: number | null) {
  return fps ? `약 ${formatFrameRate(fps)} FPS` : "확인 불가";
}

function frameRatePreferenceValue(fps: number): FpsPreference {
  return `fps:${formatFrameRate(fps)}`;
}

function frameRateFromPreference(preference: FpsPreference) {
  if (preference === "recommended") return null;
  const value = Number(preference.slice(4));
  return Number.isFinite(value) && value >= 1 && value <= 60 ? value : null;
}

function createFrameRateSelectorOptions(
  sourceFps: number | null,
): SelectorOptionType[] {
  const values = getSourceAwareFrameRateOptions(sourceFps);
  const usableSourceFps = sourceFps ? Math.min(sourceFps, 60) : null;
  const sourceValue = usableSourceFps
    ? frameRatePreferenceValue(usableSourceFps)
    : null;
  const standardValues = values.filter(
    (value) =>
      !usableSourceFps || Math.abs(value - usableSourceFps) > 0.0005,
  );
  const groups = [
    {
      title: "저용량과 짧은 움직임",
      values: standardValues.filter((value) => value <= 20),
    },
    {
      title: "영화와 일반 영상",
      values: standardValues.filter((value) => value > 20 && value <= 30),
    },
    {
      title: "고프레임 영상",
      values: standardValues.filter((value) => value > 30),
    },
  ];
  const options: SelectorOptionType[] = [];

  if (sourceValue && usableSourceFps) {
    options.push({
      value: sourceValue,
      label:
        sourceFps && sourceFps > 60
          ? `도구 최대값 60 FPS (원본 약 ${formatFrameRate(sourceFps)} FPS)`
          : `원본 측정값 (약 ${formatFrameRate(usableSourceFps)} FPS)`,
    });
  }
  for (const group of groups) {
    if (group.values.length === 0) continue;
    options.push({
      type: "section",
      title: group.title,
      options: group.values.map((value) => ({
        value: frameRatePreferenceValue(value),
        label: `${formatFrameRate(value)} FPS`,
      })),
    });
  }
  return options;
}

function fpsAdjustmentCopy(
  sourceFps: number | null,
  outputFps: number,
  fallback: string,
) {
  if (!sourceFps) return fallback;
  const source = formatFrameRate(sourceFps);
  const output = formatFrameRate(outputFps);
  if (Math.abs(sourceFps - outputFps) <= 0.05) {
    return `원본과 비슷한 ${output} FPS를 유지해요.`;
  }
  return `예상 용량과 변환 부담을 줄이기 위해 원본 약 ${source} FPS를 ${output} FPS로 조정했어요.`;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b ? greatestCommonDivisor(b, a % b) : a;
}

function formatAspect(width: number | null, height: number | null) {
  if (!width || !height) return "확인 불가";
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function adaptiveRationale(reason: string) {
  switch (reason) {
    case "metadata-unavailable":
      return "영상 정보를 확인하기 어려워 기본 추천값을 사용해요.";
    case "long-duration":
      return "영상이 길어 용량이 과해지지 않도록 프레임과 크기를 조절했어요.";
    case "dense-source":
      return "파일 정보량이 많아 선명도와 변환 부담의 균형을 맞췄어요.";
    case "short-source":
      return "짧은 영상이라 프레임과 크기를 더 살렸어요.";
    case "light-source":
      return "파일이 비교적 가벼워 해상도를 조금 높였어요.";
    case "source-size":
      return "원본 크기를 넘겨 키우지 않고 프레임을 살렸어요.";
    case "source-limited":
      return "원본에 가깝게 두되, 결과가 아주 커질 때만 자동으로 낮췄어요.";
    default:
      return "영상 길이와 해상도를 함께 보고 균형을 맞췄어요.";
  }
}

function adaptiveRiskCopy(
  risk?: { level: string; reason: string } | null,
) {
  if (!risk || risk.level === "low") return null;
  if (risk.level === "unknown") {
    return {
      level: "unknown",
      title: "기기 부담을 미리 확인하기 어려워요",
      description:
        "영상 정보를 읽지 못했어요. 긴 영상이라면 짧은 구간부터 시도해 주세요.",
    };
  }
  if (risk.level === "medium" && risk.reason === "output-size") return null;
  return {
    level: risk.level,
    title:
      risk.level === "high"
        ? "변환 부담이 큰 편이에요"
        : "변환에 시간이 걸릴 수 있어요",
    description:
      risk.reason === "memory"
        ? "브라우저 메모리를 많이 사용할 수 있어요. 길이, FPS 또는 크기를 낮추면 더 안정적이에요."
        : risk.reason === "output-size"
          ? "결과 파일이 크게 나올 수 있어요. 예상 용량을 확인하고 필요하면 한 단계 낮춰 주세요."
        : "처리할 프레임이 많아요. 중급자 모드에서 길이를 줄이면 더 안정적이에요.",
  };
}

function fileExtension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function measureVideoFrameRate(video: HTMLVideoElement): Promise<number | null> {
  if (typeof video.requestVideoFrameCallback !== "function") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const samples: Array<{ mediaTime: number; presentedFrames: number }> = [];
    let callbackId: number | null = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      video.removeEventListener("ended", finish);
      if (callbackId !== null) video.cancelVideoFrameCallback(callbackId);
      video.pause();
      resolve(estimateFrameRateFromSamples(samples));
    };
    const collect: VideoFrameRequestCallback = (_now, frame) => {
      samples.push({
        mediaTime: frame.mediaTime,
        presentedFrames: frame.presentedFrames,
      });
      const elapsed =
        samples.length > 1
          ? samples.at(-1)!.mediaTime - samples[0].mediaTime
          : 0;
      if ((samples.length >= 8 && elapsed >= 0.45) || samples.length >= 36) {
        finish();
        return;
      }
      callbackId = video.requestVideoFrameCallback(collect);
    };
    const timeoutId = window.setTimeout(finish, 2400);

    video.addEventListener("ended", finish, { once: true });
    callbackId = video.requestVideoFrameCallback(collect);
    void video.play().catch(finish);
  });
}

function inspectVideo(url: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const finish = () => {
      video.onloadedmetadata = null;
      video.onerror = null;
      video.pause();
      video.remove();
      video.removeAttribute("src");
      video.load();
    };

    video.preload = "auto";
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.tabIndex = -1;
    video.className = "fps-probe";
    video.setAttribute("aria-hidden", "true");
    video.onloadedmetadata = async () => {
      const fps = await measureVideoFrameRate(video);
      const metadata = {
        duration: Number.isFinite(video.duration) ? video.duration : null,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
        fps,
        previewAvailable: true,
      };
      finish();
      resolve(metadata);
    };
    video.onerror = () => {
      finish();
      reject(new Error("Browser preview unavailable"));
    };
    document.body.append(video);
    video.src = url;
  });
}

function getReadableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  if (/abort|terminated/i.test(message)) {
    return "변환이 취소됐어요. 파일은 그대로이며 언제든 다시 시작할 수 있어요.";
  }
  if (/fetch|download|network|failed to load/i.test(message)) {
    return "변환 엔진을 내려받지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.";
  }
  if (/integrity/i.test(message)) {
    return "변환 엔진의 안전성을 확인하지 못했어요. 새로고침한 뒤 다시 시도해 주세요.";
  }
  if (/memory|allocation|out of bounds|array buffer/i.test(message)) {
    return "브라우저 메모리가 부족해요. 더 짧은 구간이나 작은 영상으로 다시 시도해 주세요.";
  }

  return "이 영상을 변환하지 못했어요. 지원되지 않는 코덱일 수 있어요. MP4(H.264) 또는 WebM 파일로 다시 시도해 주세요.";
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [inspectionWarning, setInspectionWarning] = useState<string | null>(
    null,
  );
  const [format, setFormat] = useState<Format>("gif");
  const [mode, setMode] = useState<Mode>("Beginner");
  const [preset, setPreset] = useState<Preset>("auto");
  const [fpsPreference, setFpsPreference] =
    useState<FpsPreference>("recommended");
  const [start, setStart] = useState(0);
  const [duration, setDuration] = useState(6);
  const [fps, setFps] = useState(12);
  const [width, setWidth] = useState(480);
  const [plays, setPlays] = useState(0);
  const [gifColors, setGifColors] = useState(128);
  const [gifStats, setGifStats] = useState("diff");
  const [gifDither, setGifDither] = useState("sierra2_4a");
  const [apngCompression, setApngCompression] = useState(6);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [stageMessage, setStageMessage] = useState("파일을 기다리고 있어요.");
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultSize, setResultSize] = useState<number | null>(null);
  const [resultName, setResultName] = useState("");
  const [reducedMotion, setReducedMotion] = useState(false);
  const [showResultPreview, setShowResultPreview] = useState(false);
  const [announcedPrediction, setAnnouncedPrediction] = useState("");
  const [advancedDirty, setAdvancedDirty] = useState(false);
  const [workflow, setWorkflow] = useState<Workflow>("single");
  const [batchJobs, setBatchJobs] = useState<BatchJob[]>([]);
  const [deviceHints, setDeviceHints] = useState<DeviceHints>({
    hardwareConcurrency: null,
    deviceMemory: null,
  });
  const [resultFormat, setResultFormat] = useState<Format>("gif");
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [historyVisibleCount, setHistoryVisibleCount] = useState(8);
  const [pendingBatchDelete, setPendingBatchDelete] = useState<string | null>(
    null,
  );
  const [pendingHistoryDelete, setPendingHistoryDelete] = useState<string | null>(
    null,
  );
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const [historyPreviewOpen, setHistoryPreviewOpen] = useState(false);
  const [historyPreviewUrl, setHistoryPreviewUrl] = useState<string | null>(null);
  const [historyPreviewEntry, setHistoryPreviewEntry] =
    useState<HistoryItem | null>(null);
  const [historyPreviewLoadingId, setHistoryPreviewLoadingId] = useState<
    string | null
  >(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const sourceUrlRef = useRef<string | null>(null);
  const resultUrlRef = useRef<string | null>(null);
  const historyPreviewUrlRef = useRef<string | null>(null);
  const historyPreviewRequestRef = useRef(0);
  const historyPreviewReturnIdRef = useRef<string | null>(null);
  const sessionHistoryBlobsRef = useRef(new Map<string, Blob>());
  const sessionHistoryFallbackIdsRef = useRef(new Set<string>());
  const historySavePromisesRef = useRef(new Map<string, Promise<void>>());
  const activeEnginesRef = useRef(new Set<BrowserFfmpeg>());
  const batchProgressRef = useRef(new Map<string, number>());
  const abortRef = useRef<AbortController | null>(null);
  const operationRef = useRef(0);
  const reducedMotionRef = useRef(false);
  const completedSettingsRef = useRef<string | null>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);

  const isActive = ACTIVE_PHASES.has(phase);
  const controlsDisabled =
    isActive || phase === "inspecting" || workflow === "batch";
  const mediaProfile = useMemo(
    () => ({
      durationSeconds: metadata?.duration,
      width: metadata?.width,
      height: metadata?.height,
      sizeBytes: file?.size,
      frameRate: metadata?.fps,
    }),
    [
      file?.size,
      metadata?.duration,
      metadata?.fps,
      metadata?.height,
      metadata?.width,
    ],
  );
  const selectedFpsTarget = useMemo(
    () => frameRateFromPreference(fpsPreference),
    [fpsPreference],
  );
  const beginnerDuration = useMemo(
    () => recommendBeginnerDuration(mediaProfile),
    [mediaProfile],
  );
  const automaticRecommendation = useMemo(
    () =>
      resolveAdaptivePreset({
        format,
        mode: mode === "Advanced" ? "Intermediate" : mode,
        preset: "auto",
        media: mediaProfile,
        trim: {
          start: mode === "Beginner" ? 0 : start,
          duration: mode === "Beginner" ? beginnerDuration : duration,
        },
      }),
    [beginnerDuration, duration, format, mediaProfile, mode, start],
  );
  const intermediateRecommendations = useMemo(
    () =>
      Object.fromEntries(
        PRESET_COPY.map((option) => [
          option.id,
          resolveAdaptivePreset({
            format,
            mode: "Intermediate",
            preset: option.id,
            media: mediaProfile,
            trim: { start, duration },
            fpsTarget: selectedFpsTarget ?? undefined,
          }),
        ]),
      ),
    [duration, format, mediaProfile, selectedFpsTarget, start],
  );
  const activeRecommendation =
    mode === "Beginner"
      ? automaticRecommendation
      : mode === "Intermediate"
        ? intermediateRecommendations[preset]
        : null;
  const directFpsOptions = useMemo(
    () => createFrameRateSelectorOptions(metadata?.fps ?? null),
    [metadata?.fps],
  );
  const batchFpsValues = useMemo(
    () => getSourceAwareFrameRateOptions(metadata?.fps ?? null),
    [metadata?.fps],
  );
  const intermediateFpsOptions = useMemo<SelectorOptionType[]>(
    () => [
      {
        value: "recommended",
        label: "프리셋 추천 (자동 계산)",
      },
      ...directFpsOptions,
    ],
    [directFpsOptions],
  );
  const advancedFpsValue =
    Number.isFinite(fps) && fps >= 1 && fps <= 60
      ? frameRatePreferenceValue(fps)
      : undefined;
  const advancedFpsOptionValues = useMemo(
    () =>
      new Set(
        directFpsOptions.flatMap((option) => {
          if (typeof option === "string") return [];
          if ("type" in option && option.type === "divider") return [];
          if ("type" in option && option.type === "section") {
            return option.options.map((item) => item.value);
          }
          return [option.value];
        }),
      ),
    [directFpsOptions],
  );
  const recommendationWarning = adaptiveRiskCopy(activeRecommendation?.risk);
  const advancedRecommendationMatches =
    fps === automaticRecommendation.settings.fps &&
    width === automaticRecommendation.settings.width &&
    gifColors === automaticRecommendation.settings.gifColors &&
    gifStats === automaticRecommendation.settings.gifStats &&
    gifDither === automaticRecommendation.settings.gifDither &&
    apngCompression === automaticRecommendation.settings.apngCompression;
  const manualSettings = useMemo(
    () =>
      normalizeSettings(
        {
          format,
          mode,
          preset,
          start,
          duration,
          fps,
          width,
          plays,
          gifColors,
          gifStats,
          gifDither,
          apngCompression,
        },
        metadata?.duration ?? undefined,
      ),
    [
      apngCompression,
      duration,
      format,
      fps,
      gifColors,
      gifDither,
      gifStats,
      metadata?.duration,
      mode,
      plays,
      preset,
      start,
      width,
    ],
  );
  const normalized = activeRecommendation?.settings ?? manualSettings;
  const settingsFingerprint = [
    ADAPTIVE_PRESET_POLICY_VERSION,
    normalized.format,
    normalized.mode,
    normalized.preset,
    normalized.start,
    normalized.duration,
    normalized.fps,
    normalized.width,
    normalized.plays,
    normalized.gifColors,
    normalized.gifStats,
    normalized.gifDither,
    normalized.apngCompression,
  ].join("|");
  const sourceDuration = metadata?.duration ?? null;
  const sizeEstimate = useMemo(
    () => estimateOutputSize({ settings: normalized, media: mediaProfile }),
    [mediaProfile, normalized],
  );
  const batchJobsWithEstimates = useMemo(
    () =>
      batchJobs.map((job) => {
        const estimate = estimateOutputSize({
          settings: job.settings,
          media: mediaProfile,
        });
        return {
          job,
          estimate,
          validationError: getBatchSettingsSafetyError({
            settings: job.settings,
            estimate,
            metadataAvailable: Boolean(
              metadata?.duration && metadata.width && metadata.height,
            ),
            presetSafetyError: job.presetSafetyError,
          }),
        };
      }),
    [batchJobs, mediaProfile, metadata],
  );
  const batchEstimateTotals = useMemo(() => {
    if (
      batchJobsWithEstimates.some(
        ({ estimate }) =>
          estimate.status !== "available" || estimate.rangeBytes === null,
      )
    ) {
      return null;
    }
    return batchJobsWithEstimates.reduce(
      (total, { estimate }) => ({
        lower: total.lower + (estimate.rangeBytes?.lower ?? 0),
        upper: total.upper + (estimate.rangeBytes?.upper ?? 0),
      }),
      { lower: 0, upper: 0 },
    );
  }, [batchJobsWithEstimates]);
  const batchExecutionPlan = useMemo(() => {
    const workingSets = batchJobsWithEstimates
      .filter(({ job }) => BATCH_RUNNABLE_STATUSES.has(job.status))
      .map(({ job, estimate }) => {
        if (estimate.status !== "available") return Number.POSITIVE_INFINITY;
        const width = estimate.output.width ?? job.settings.width;
        const height = estimate.output.height ?? width;
        return (
          width *
            height *
            4 *
            (job.settings.format === "gif" ? 12 : 8) +
          estimate.rangeBytes.upper * (job.settings.format === "gif" ? 3 : 2)
        );
      })
      .sort((left, right) => right - left);
    const hasRiskyJobs = batchJobsWithEstimates.some(
      ({ job, estimate }) =>
        BATCH_RUNNABLE_STATUSES.has(job.status) &&
        (estimate.status !== "available" ||
          estimate.sizeClass !== "normal" ||
          (job.settings.duration > 15 &&
            (job.settings.width > 960 || job.settings.fps > 30))),
    );
    const runnableJobCount = batchJobs.filter((job) =>
      BATCH_RUNNABLE_STATUSES.has(job.status),
    ).length;
    return getBatchExecutionPlan({
      hardwareConcurrency: deviceHints.hardwareConcurrency,
      deviceMemory: deviceHints.deviceMemory,
      fileSizeBytes: file?.size,
      jobCount: runnableJobCount,
      hasRiskyJobs,
      estimatedWorkingSetBytes: workingSets.slice(0, 2).reduce(
        (total, value) => total + value,
        0,
      ),
    });
  }, [batchJobs, batchJobsWithEstimates, deviceHints, file?.size]);
  const settingsError = (() => {
    if (activeRecommendation?.canConvert === false) {
      return "이 구간은 원본 가깝게 설정으로 처리하기 너무 커요. 변환 길이를 줄이거나 더 선명하게를 선택해 주세요.";
    }
    if (mode !== "Beginner") {
      if (!Number.isFinite(start) || start < 0) {
        return "시작 위치는 0초 이상으로 입력해 주세요.";
      }
      if (
        sourceDuration !== null &&
        (start >= sourceDuration || start + duration > sourceDuration + 0.001)
      ) {
        return "시작 위치와 변환 길이가 원본 영상 범위를 벗어났어요.";
      }
      if (!Number.isFinite(duration) || duration < 0.1) {
        return "변환 길이는 0.1초 이상으로 입력해 주세요.";
      }
    }
    if (mode === "Advanced") {
      if (!Number.isFinite(fps) || fps < 1 || fps > 60) {
        return "프레임은 1-60 FPS 사이로 입력해 주세요.";
      }
      if (!Number.isInteger(width) || width < 160 || width > 1920) {
        return "최대 너비는 160-1920px 사이의 정수로 입력해 주세요.";
      }
      if (
        format === "gif" &&
        (!Number.isInteger(gifColors) || gifColors < 2 || gifColors > 256)
      ) {
        return "GIF 색상 수는 2-256 사이의 정수로 입력해 주세요.";
      }
      if (
        format === "apng" &&
        (!Number.isInteger(apngCompression) ||
          apngCompression < 0 ||
          apngCompression > 9)
      ) {
        return "APNG 압축은 0-9 사이의 정수로 입력해 주세요.";
      }
      if (sourceDuration === null && (width > 480 || fps > 12)) {
        return "영상 정보를 확인할 수 없을 때는 480px · 12 FPS 이하로 설정해 주세요.";
      }
    }
    return null;
  })();

  const disposeActiveEngines = useCallback(() => {
    for (const engine of activeEnginesRef.current) engine.dispose();
    activeEnginesRef.current.clear();
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      reducedMotionRef.current = query.matches;
      setReducedMotion(query.matches);
      if (query.matches) setShowResultPreview(false);
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const navigatorWithMemory = navigator as Navigator & {
        deviceMemory?: number;
      };
      setDeviceHints({
        hardwareConcurrency: Number.isFinite(navigator.hardwareConcurrency)
          ? navigator.hardwareConcurrency
          : null,
        deviceMemory: Number.isFinite(navigatorWithMemory.deviceMemory)
          ? navigatorWithMemory.deviceMemory!
          : null,
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let disposed = false;
    void listHistoryEntries()
      .then((entries) => {
        if (disposed) return;
        setHistoryItems((current) =>
          mergeHistoryItems(
            current,
            entries.map((entry) => ({ ...entry, persistence: "saved" })),
          ),
        );
      })
      .catch(() => {
        if (!disposed) {
          setHistoryNotice(
            "이 브라우저에서는 최근 결과를 오래 보관할 수 없어요. 지금 탭의 결과는 계속 확인하고 내려받을 수 있어요.",
          );
        }
      })
      .finally(() => {
        if (!disposed) setHistoryLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(
    () => () => {
      operationRef.current += 1;
      historyPreviewRequestRef.current += 1;
      abortRef.current?.abort();
      disposeActiveEngines();
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
      if (historyPreviewUrlRef.current) {
        URL.revokeObjectURL(historyPreviewUrlRef.current);
      }
    },
    [disposeActiveEngines],
  );

  const clearResult = useCallback(() => {
    if (resultUrlRef.current) {
      URL.revokeObjectURL(resultUrlRef.current);
      resultUrlRef.current = null;
    }
    setResultUrl(null);
    setResultSize(null);
    setResultName("");
    setShowResultPreview(false);
    completedSettingsRef.current = null;
  }, []);

  useEffect(() => {
    if (
      workflow === "single" &&
      phase === "complete" &&
      completedSettingsRef.current !== null &&
      completedSettingsRef.current !== settingsFingerprint
    ) {
      clearResult();
      setProgress(0);
      setPhase("ready");
      setStageMessage("설정이 바뀌었어요. 새 설정으로 다시 변환해 주세요.");
    }
  }, [clearResult, phase, settingsFingerprint, workflow]);

  useEffect(() => {
    if (phase !== "complete") return;
    const heading = resultHeadingRef.current;
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({
      behavior: reducedMotionRef.current ? "auto" : "smooth",
      block: "nearest",
    });
  }, [phase]);

  function applyRecommendedEncoding(settings: RecommendedEncodingSettings) {
    setFps(settings.fps);
    setWidth(settings.width);
    setGifColors(settings.gifColors);
    setGifStats(settings.gifStats);
    setGifDither(settings.gifDither);
    setApngCompression(settings.apngCompression);
  }

  function handleModeChange(nextMode: Mode) {
    setMode(nextMode);
  }

  function loadRecommendedSettings() {
    applyRecommendedEncoding(automaticRecommendation.settings);
    setAdvancedDirty(false);
  }

  function updateAdvancedSetting(update: () => void) {
    setAdvancedDirty(true);
    update();
  }

  function resolvedBatchPreset(
    outputFormat: Format,
    batchPreset: Exclude<BatchPreset, "custom">,
    trim: { start: number; duration: number },
  ) {
    const recommendation = resolveAdaptivePreset({
      format: outputFormat,
      mode: "Intermediate",
      preset: batchPreset,
      media: mediaProfile,
      trim,
    });
    return {
      settings: recommendation.settings as ResolvedConversionSettings,
      presetSafetyError:
        recommendation.canConvert === false
          ? "원본에 가까운 설정으로 안전하게 처리하기 어려워요. 길이를 줄이거나 더 선명하게를 선택해 주세요."
          : null,
    };
  }

  function recommendedBatchJobs() {
    const starterPresets: Array<{
      preset: "light" | "auto" | "crisp";
      label: string;
    }> = [
      { preset: "light", label: "가볍게 공유" },
      { preset: "auto", label: "핌쥐 추천" },
      { preset: "crisp", label: "더 선명하게" },
    ];
    const trim = { start: normalized.start, duration: normalized.duration };
    return starterPresets.map(({ preset: jobPreset, label }) => {
      const resolved = resolvedBatchPreset(format, jobPreset, trim);
      return {
        id: createLocalId("job"),
        label,
        preset: jobPreset,
        ...resolved,
        status: "ready" as const,
        progress: 0,
        stageMessage: "변환 준비가 됐어요.",
        error: null,
        historyId: null,
      };
    });
  }

  function enterBatchMode() {
    if (isActive || !file || phase === "inspecting" || settingsError) return;
    clearResult();
    setBatchJobs(recommendedBatchJobs());
    setPendingBatchDelete(null);
    setWorkflow("batch");
    setPhase("ready");
    setProgress(0);
    setError(null);
    setStageMessage("여러 결과의 설정을 확인한 뒤 한 번에 시작해 주세요.");
    focusAfterRender("batch-builder-title");
  }

  function leaveBatchMode() {
    if (isActive) return;
    setWorkflow("single");
    setPendingBatchDelete(null);
    setPhase("ready");
    setProgress(0);
    setError(null);
    setStageMessage("설정을 확인하고 변환을 시작해 주세요.");
    focusAfterRender("settings-title");
  }

  function resetBatchJob(job: BatchJob, update: Partial<BatchJob>) {
    return {
      ...job,
      ...update,
      status: "ready" as const,
      progress: 0,
      stageMessage: "변환 준비가 됐어요.",
      error: null,
      historyId: null,
    };
  }

  function updateBatchLabel(id: string, label: string) {
    setBatchJobs((jobs) =>
      jobs.map((job) =>
        job.id === id ? resetBatchJob(job, { label }) : job,
      ),
    );
  }

  function updateBatchSettings(
    id: string,
    update: Partial<ResolvedConversionSettings>,
  ) {
    setBatchJobs((jobs) =>
      jobs.map((job) => {
        if (job.id !== id) return job;
        const nextSettings = normalizeSettings(
          {
            ...job.settings,
            ...update,
            mode: "Advanced",
          },
          metadata?.duration ?? undefined,
        ) as ResolvedConversionSettings;
        return resetBatchJob(job, {
          preset: "custom",
          settings: nextSettings,
          presetSafetyError: null,
        });
      }),
    );
  }

  function updateBatchPreset(
    id: string,
    nextFormat: Format,
    nextPreset: BatchPreset,
  ) {
    setBatchJobs((jobs) =>
      jobs.map((job) => {
        if (job.id !== id) return job;
        const resolved =
          nextPreset === "custom"
            ? {
                settings: normalizeSettings(
                {
                  ...job.settings,
                  format: nextFormat,
                  mode: "Advanced",
                },
                metadata?.duration ?? undefined,
                ) as ResolvedConversionSettings,
                presetSafetyError: null,
              }
            : resolvedBatchPreset(nextFormat, nextPreset, {
                start: job.settings.start,
                duration: job.settings.duration,
              });
        return resetBatchJob(job, {
          preset: nextPreset,
          ...resolved,
        });
      }),
    );
  }

  function addCurrentBatchJob() {
    if (batchJobs.length >= MAX_BATCH_JOBS) return;
    const nextNumber = batchJobs.length + 1;
    setBatchJobs((jobs) => [
      ...jobs,
      {
        id: createLocalId("job"),
        label: `내 설정 ${nextNumber}`,
        preset: "custom",
        settings: { ...normalized } as ResolvedConversionSettings,
        presetSafetyError: null,
        status: "ready",
        progress: 0,
        stageMessage: "변환 준비가 됐어요.",
        error: null,
        historyId: null,
      },
    ]);
  }

  function duplicateBatchJob(id: string) {
    if (batchJobs.length >= MAX_BATCH_JOBS) return;
    setBatchJobs((jobs) => {
      const source = jobs.find((job) => job.id === id);
      if (!source || jobs.length >= MAX_BATCH_JOBS) return jobs;
      return [
        ...jobs,
        {
          ...source,
          id: createLocalId("job"),
          label: `${source.label} 복사본`,
          settings: { ...source.settings },
          status: "ready",
          progress: 0,
          stageMessage: "변환 준비가 됐어요.",
          error: null,
          historyId: null,
        },
      ];
    });
  }

  function removeBatchJob(id: string) {
    const index = batchJobs.findIndex((job) => job.id === id);
    const nextFocusId =
      batchJobs[index + 1]?.id ?? batchJobs[index - 1]?.id ?? null;
    setBatchJobs((jobs) => jobs.filter((job) => job.id !== id));
    focusAfterRender(nextFocusId ? `batch-job-${nextFocusId}` : "batch-builder-title");
  }

  function setCurrentResult(
    blob: Blob,
    name: string,
    outputFormat: Format,
    fingerprint: string | null,
  ) {
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    const nextResultUrl = URL.createObjectURL(blob);
    resultUrlRef.current = nextResultUrl;
    completedSettingsRef.current = fingerprint;
    setResultUrl(nextResultUrl);
    setResultSize(blob.size);
    setResultName(name);
    setResultFormat(outputFormat);
    setShowResultPreview(!reducedMotionRef.current);
  }

  function openHistoryDialog() {
    setPendingHistoryDelete(null);
    setConfirmClearHistory(false);
    setHistoryOpen(true);
  }

  function closeHistoryDialog() {
    setHistoryOpen(false);
    setPendingHistoryDelete(null);
    setConfirmClearHistory(false);
  }

  function trimSessionHistoryFallback() {
    const fallbackIds = sessionHistoryFallbackIdsRef.current;
    const fallbackEntries = [...fallbackIds]
      .map((id) => ({ id, blob: sessionHistoryBlobsRef.current.get(id) }))
      .filter((entry): entry is { id: string; blob: Blob } => Boolean(entry.blob));
    let totalBytes = fallbackEntries.reduce(
      (total, entry) => total + entry.blob.size,
      0,
    );
    const evictedIds: string[] = [];

    while (
      fallbackEntries.length > 1 &&
      (fallbackEntries.length > MAX_SESSION_HISTORY_RESULTS ||
        totalBytes > MAX_SESSION_HISTORY_BYTES)
    ) {
      const oldest = fallbackEntries.shift();
      if (!oldest) break;
      totalBytes -= oldest.blob.size;
      fallbackIds.delete(oldest.id);
      sessionHistoryBlobsRef.current.delete(oldest.id);
      evictedIds.push(oldest.id);
    }

    if (evictedIds.length > 0) {
      const evicted = new Set(evictedIds);
      setHistoryItems((items) => items.filter((item) => !evicted.has(item.id)));
    }
    return evictedIds.length;
  }

  async function rememberResult({
    blob,
    name,
    settings,
    batch,
  }: {
    blob: Blob;
    name: string;
    settings: ResolvedConversionSettings;
    batch: HistoryEntry["batch"];
  }) {
    if (!file) return null;
    const entry: HistoryEntry = {
      id: createLocalId("result"),
      schemaVersion: 1,
      createdAt: currentTimestamp(),
      source: {
        name: file.name,
        sizeBytes: file.size,
        durationSeconds: metadata?.duration ?? null,
        width: metadata?.width ?? null,
        height: metadata?.height ?? null,
        fps: metadata?.fps ?? null,
      },
      output: {
        name,
        format: settings.format,
        mimeType: settings.format === "gif" ? "image/gif" : "image/png",
        sizeBytes: blob.size,
      },
      settings: {
        start: settings.start,
        duration: settings.duration,
        fps: settings.fps,
        width: settings.width,
        plays: settings.plays,
        gifColors: settings.gifColors,
        gifStats: settings.gifStats,
        gifDither: settings.gifDither,
        apngCompression: settings.apngCompression,
        preset: settings.preset,
        presetPolicyVersion: ADAPTIVE_PRESET_POLICY_VERSION,
      },
      batch,
    };
    const pendingItem: HistoryItem = {
      ...entry,
      persistence: "session-only",
    };
    sessionHistoryBlobsRef.current.set(entry.id, blob);
    setHistoryItems((items) => mergeHistoryItems(items, [pendingItem]));

    const savePromise = saveHistoryResult(entry, blob);
    historySavePromisesRef.current.set(entry.id, savePromise);
    try {
      await savePromise;
      sessionHistoryBlobsRef.current.delete(entry.id);
      sessionHistoryFallbackIdsRef.current.delete(entry.id);
      setHistoryItems((items) =>
        items.map((item) =>
          item.id === entry.id ? { ...item, persistence: "saved" } : item,
        ),
      );
    } catch (historyError) {
      const kind = historyErrorKind(historyError);
      const persistence = kind === "quota-full" ? "quota-full" : "session-only";
      sessionHistoryFallbackIdsRef.current.add(entry.id);
      setHistoryItems((items) =>
        items.map((item) =>
          item.id === entry.id ? { ...item, persistence } : item,
        ),
      );
      const evictedCount = trimSessionHistoryFallback();
      const baseNotice =
        kind === "quota-full"
          ? "브라우저 저장공간이 부족해 새 결과는 이번 탭에만 남아요. 기존 결과를 내려받거나 지운 뒤 다시 시도해 주세요."
          : "최근 결과를 오래 보관할 수 없어요. 이번 탭에서는 계속 확인하고 내려받을 수 있어요.";
      setHistoryNotice(
        evictedCount > 0
          ? `${baseNotice} 메모리를 보호하기 위해 오래된 탭 전용 결과 ${evictedCount}개는 목록에서 정리했어요.`
          : baseNotice,
      );
    } finally {
      if (historySavePromisesRef.current.get(entry.id) === savePromise) {
        historySavePromisesRef.current.delete(entry.id);
      }
    }

    return entry;
  }

  async function historyBlobFor(entry: HistoryItem) {
    const sessionBlob = sessionHistoryBlobsRef.current.get(entry.id);
    if (sessionBlob) return sessionBlob;
    return getHistoryBlob(entry.id);
  }

  async function previewHistoryResult(entry: HistoryItem) {
    const request = historyPreviewRequestRef.current + 1;
    historyPreviewRequestRef.current = request;
    setHistoryPreviewLoadingId(entry.id);
    setHistoryNotice(null);
    try {
      const blob = await historyBlobFor(entry);
      if (historyPreviewRequestRef.current !== request) return;
      if (!blob) {
        setHistoryNotice(
          "이 결과 파일을 찾을 수 없어요. 브라우저 데이터가 정리되었을 수 있어요.",
        );
        return;
      }
      if (historyPreviewUrlRef.current) {
        URL.revokeObjectURL(historyPreviewUrlRef.current);
      }
      const url = URL.createObjectURL(blob);
      historyPreviewUrlRef.current = url;
      setHistoryPreviewUrl(url);
      setHistoryPreviewEntry(entry);
      historyPreviewReturnIdRef.current = entry.id;
      closeHistoryDialog();
      setHistoryPreviewOpen(true);
    } catch {
      if (historyPreviewRequestRef.current === request) {
        setHistoryNotice("미리보기를 열지 못했어요. 잠시 후 다시 시도해 주세요.");
      }
    } finally {
      if (historyPreviewRequestRef.current === request) {
        setHistoryPreviewLoadingId(null);
      }
    }
  }

  function closeHistoryPreview(returnToHistory = true) {
    const returnId = historyPreviewReturnIdRef.current;
    historyPreviewRequestRef.current += 1;
    setHistoryPreviewOpen(false);
    if (historyPreviewUrlRef.current) {
      URL.revokeObjectURL(historyPreviewUrlRef.current);
      historyPreviewUrlRef.current = null;
    }
    setHistoryPreviewUrl(null);
    setHistoryPreviewEntry(null);
    historyPreviewReturnIdRef.current = null;
    if (returnToHistory && returnId) {
      openHistoryDialog();
      focusAfterRender(`history-preview-${returnId}`);
    }
  }

  async function downloadHistoryResult(entry: HistoryItem) {
    setHistoryNotice(null);
    try {
      const blob = await historyBlobFor(entry);
      if (!blob) {
        setHistoryNotice(
          "이 결과 파일을 찾을 수 없어요. 목록에서 지운 뒤 다시 만들어 주세요.",
        );
        return;
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = entry.output.name;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      setHistoryNotice("파일을 내려받지 못했어요. 잠시 후 다시 시도해 주세요.");
    }
  }

  async function confirmDeleteHistoryResult(entry: HistoryItem) {
    const currentIndex = historyItems.findIndex((item) => item.id === entry.id);
    const nextItem =
      historyItems[currentIndex + 1] ?? historyItems[currentIndex - 1] ?? null;
    try {
      if (historyPreviewLoadingId === entry.id) {
        historyPreviewRequestRef.current += 1;
        setHistoryPreviewLoadingId(null);
      }
      let mayBePersisted = entry.persistence === "saved";
      const pendingSave = historySavePromisesRef.current.get(entry.id);
      if (pendingSave) {
        try {
          await pendingSave;
          mayBePersisted = true;
        } catch {}
      }
      try {
        await deleteHistoryResult(entry.id);
      } catch (deleteError) {
        if (mayBePersisted) throw deleteError;
      }
      sessionHistoryBlobsRef.current.delete(entry.id);
      sessionHistoryFallbackIdsRef.current.delete(entry.id);
      setHistoryItems((items) => items.filter((item) => item.id !== entry.id));
      setPendingHistoryDelete(null);
      if (historyPreviewEntry?.id === entry.id) {
        closeHistoryPreview(false);
      }
      focusAfterRender(
        nextItem ? `history-item-${nextItem.id}` : "history-empty",
      );
    } catch {
      setHistoryNotice("결과를 지우지 못했어요. 잠시 후 다시 시도해 주세요.");
    }
  }

  async function confirmClearAllHistory() {
    try {
      let mayBePersisted = historyItems.some(
        (item) => item.persistence === "saved",
      );
      const pendingSaves = [...historySavePromisesRef.current.values()];
      if (pendingSaves.length > 0) {
        const settledSaves = await Promise.allSettled(pendingSaves);
        mayBePersisted ||= settledSaves.some(
          (outcome) => outcome.status === "fulfilled",
        );
      }
      try {
        await clearHistoryResults();
      } catch (clearError) {
        if (mayBePersisted) throw clearError;
      }
      sessionHistoryBlobsRef.current.clear();
      sessionHistoryFallbackIdsRef.current.clear();
      setHistoryItems([]);
      setConfirmClearHistory(false);
      setPendingHistoryDelete(null);
      closeHistoryPreview(false);
      setHistoryNotice(null);
      focusAfterRender("history-empty");
    } catch {
      setHistoryNotice("최근 결과를 모두 지우지 못했어요. 잠시 후 다시 시도해 주세요.");
    }
  }

  function validateFile(nextFile: File) {
    if (nextFile.size === 0) {
      return "내용이 없는 파일이에요. 다른 동영상 파일을 선택해 주세요.";
    }
    if (nextFile.size > MAX_FILE_SIZE) {
      return "파일이 1GB보다 커요. 더 짧거나 작은 동영상으로 다시 시도해 주세요.";
    }
    const extension = fileExtension(nextFile.name);
    if (!nextFile.type.startsWith("video/") && !SUPPORTED_EXTENSIONS.has(extension)) {
      return "지원하는 동영상 파일인지 확인해 주세요. MP4, MOV, WebM, MKV, AVI 등을 사용할 수 있어요.";
    }
    return null;
  }

  async function chooseFile(nextFile: File) {
    const validationError = validateFile(nextFile);
    if (validationError) {
      setError(validationError);
      setStageMessage("파일을 확인하지 못했어요.");
      setPhase("error");
      return;
    }

    const largeFileWarning =
      nextFile.size > LARGE_FILE_WARNING_SIZE
        ? "큰 파일이에요. 길거나 고해상도로 변환하면 모바일에서 메모리가 부족할 수 있어요."
        : null;
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    abortRef.current?.abort();
    disposeActiveEngines();
    abortRef.current = null;
    clearResult();
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);

    const nextUrl = URL.createObjectURL(nextFile);
    sourceUrlRef.current = nextUrl;
    setSourceUrl(nextUrl);
    setFile(nextFile);
    setMetadata(null);
    setWorkflow("single");
    setBatchJobs([]);
    setPendingBatchDelete(null);
    setFpsPreference("recommended");
    setInspectionWarning(largeFileWarning);
    setError(null);
    setProgress(0);
    setPhase("inspecting");
    setStageMessage("영상 정보와 원본 FPS를 확인하는 중이에요.");

    try {
      const nextMetadata = await inspectVideo(nextUrl);
      if (operationRef.current !== operation) return;
      setMetadata(nextMetadata);
      if (mode !== "Advanced" || !advancedDirty) {
        setStart(0);
        setDuration(
          recommendBeginnerDuration({
            durationSeconds: nextMetadata.duration,
            width: nextMetadata.width,
            height: nextMetadata.height,
            sizeBytes: nextFile.size,
          }),
        );
      }
    } catch {
      if (operationRef.current !== operation) return;
      setMetadata({
        duration: null,
        width: null,
        height: null,
        fps: null,
        previewAvailable: false,
      });
      setInspectionWarning(
        [
          largeFileWarning,
          "이 브라우저에서는 미리보기를 열 수 없지만 변환은 시도할 수 있어요.",
        ]
          .filter(Boolean)
          .join(" "),
      );
    }

    if (operationRef.current === operation) {
      setPhase("ready");
      setStageMessage("설정을 확인하고 변환을 시작해 주세요.");
    }
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const nextFile = event.target.files?.[0];
    event.target.value = "";
    if (nextFile) void chooseFile(nextFile);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setIsDragging(false);
    if (isActive) return;
    const nextFile = event.dataTransfer.files?.[0];
    if (nextFile) void chooseFile(nextFile);
  }

  function cancelConversion() {
    if (!isActive) return;
    operationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    disposeActiveEngines();
    setBatchJobs((jobs) =>
      jobs.map((job) =>
        job.status === "running" || job.status === "queued"
          ? {
              ...job,
              status: "cancelled",
              stageMessage: "전체 변환이 취소됐어요.",
            }
          : job,
      ),
    );
    setPhase("cancelled");
    setStageMessage(
      workflow === "batch"
        ? "여러 결과 만들기를 취소했어요. 완료된 결과는 최근 결과에 남아 있어요."
        : "변환을 취소했어요. 설정을 바꾸고 다시 시작할 수 있어요.",
    );
  }

  function resetAll() {
    operationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    disposeActiveEngines();
    clearResult();
    if (sourceUrlRef.current) {
      URL.revokeObjectURL(sourceUrlRef.current);
      sourceUrlRef.current = null;
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
    setSourceUrl(null);
    setFile(null);
    setMetadata(null);
    setInspectionWarning(null);
    setFormat("gif");
    setMode("Beginner");
    setPreset("auto");
    setFpsPreference("recommended");
    setStart(0);
    setDuration(6);
    setFps(12);
    setWidth(480);
    setPlays(0);
    setGifColors(128);
    setGifStats("diff");
    setGifDither("sierra2_4a");
    setApngCompression(6);
    setAdvancedDirty(false);
    setWorkflow("single");
    setBatchJobs([]);
    setPendingBatchDelete(null);
    batchProgressRef.current.clear();
    setProgress(0);
    setPhase("idle");
    setStageMessage("파일을 기다리고 있어요.");
    setError(null);
  }

  async function startConversion() {
    if (!file || isActive || phase === "inspecting" || settingsError) return;

    const operation = operationRef.current + 1;
    operationRef.current = operation;
    const controller = new AbortController();
    abortRef.current = controller;
    clearResult();
    setError(null);
    setProgress(1);
    setPhase("loading");
    setStageMessage("변환 엔진을 준비하고 있어요.");
    const settingsSnapshot = { ...normalized } as ResolvedConversionSettings;

    try {
      const { blob } = await convertLocalVideo({
        file,
        settings: settingsSnapshot,
        signal: controller.signal,
        onUpdate: (update) => {
          if (operationRef.current !== operation) return;
          setPhase(update.stage as ConversionStage);
          setProgress(update.progress);
          setStageMessage(update.message);
        },
        onEngineReady: (engine) => activeEnginesRef.current.add(engine),
        onEngineDisposed: (engine) => activeEnginesRef.current.delete(engine),
      });
      if (
        operationRef.current !== operation ||
        controller.signal.aborted
      ) {
        return;
      }
      const nextResultName = safeDownloadName(file.name, settingsSnapshot.format);
      setCurrentResult(
        blob,
        nextResultName,
        settingsSnapshot.format,
        settingsFingerprint,
      );
      setProgress(100);
      setPhase("complete");
      setStageMessage("변환이 끝났어요. 결과를 확인하고 내려받아 주세요.");
      void rememberResult({
        blob,
        name: nextResultName,
        settings: settingsSnapshot,
        batch: null,
      });
    } catch (caughtError) {
      if (
        operationRef.current !== operation ||
        controller.signal.aborted
      ) {
        return;
      }
      setError(getReadableError(caughtError));
      setPhase("error");
      setStageMessage("변환을 완료하지 못했어요.");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  async function startBatchConversion() {
    const runnableJobs = batchJobs.filter((job) =>
      BATCH_RUNNABLE_STATUSES.has(job.status),
    );
    if (!file || isActive || phase === "inspecting" || runnableJobs.length === 0) {
      return;
    }
    const firstInvalidJob = batchJobsWithEstimates.find(
      ({ job, validationError }) =>
        BATCH_RUNNABLE_STATUSES.has(job.status) && validationError,
    );
    if (firstInvalidJob) {
      setError("안전하게 처리하기 어려운 결과 설정이 있어요. 표시된 항목을 먼저 조정해 주세요.");
      focusAfterRender(`batch-job-${firstInvalidJob.job.id}`);
      return;
    }

    const operation = operationRef.current + 1;
    operationRef.current = operation;
    const controller = new AbortController();
    abortRef.current = controller;
    const runId = createLocalId("batch");
    const runnableIds = new Set(runnableJobs.map((job) => job.id));
    const nextBatchJobs = batchJobs.map((job) =>
      runnableIds.has(job.id)
        ? {
            ...job,
            settings: { ...job.settings },
            status: "queued" as const,
            progress: 0,
            stageMessage: "차례를 기다리고 있어요.",
            error: null,
            historyId: null,
          }
        : job,
    );
    const jobs = nextBatchJobs.filter((job) => runnableIds.has(job.id));
    const previouslyCompleted = batchJobs.length - runnableJobs.length;
    const jobWeights = new Map(
      batchJobsWithEstimates
        .filter(({ job }) => runnableIds.has(job.id))
        .map(({ job, estimate }) => {
        if (estimate.status !== "available") return [job.id, 1] as const;
        const pixelFrames =
          (estimate.output.width ?? job.settings.width) *
          (estimate.output.height ?? job.settings.width) *
          (estimate.output.frameCount ??
            Math.max(1, job.settings.duration * job.settings.fps));
        return [
          job.id,
          Math.max(1, pixelFrames * (job.settings.format === "gif" ? 2 : 1)),
        ] as const;
        }),
    );
    const totalWeight = jobs.reduce(
      (total, job) => total + (jobWeights.get(job.id) ?? 1),
      0,
    );
    setBatchJobs(nextBatchJobs);
    clearResult();
    batchProgressRef.current = new Map(jobs.map((job) => [job.id, 0]));
    setError(null);
    setProgress(0);
    setPhase("encoding");
    setStageMessage(
      batchExecutionPlan.concurrency === 2
        ? `${jobs.length}개 결과를 2개씩 병렬로 만들기 시작했어요.`
        : `${jobs.length}개 결과를 하나씩 안정적으로 만들기 시작했어요.`,
    );

    const updateJob = (id: string, update: Partial<BatchJob>) => {
      if (operationRef.current !== operation) return;
      setBatchJobs((current) =>
        current.map((job) => (job.id === id ? { ...job, ...update } : job)),
      );
    };
    const updateOverallProgress = (id: string, nextProgress: number) => {
      const previous = batchProgressRef.current.get(id) ?? 0;
      batchProgressRef.current.set(id, Math.max(previous, nextProgress));
      const weightedProgress = jobs.reduce(
        (sum, job) =>
          sum +
          (batchProgressRef.current.get(job.id) ?? 0) *
            (jobWeights.get(job.id) ?? 1),
        0,
      );
      setProgress(Math.round(weightedProgress / totalWeight));
    };

    try {
      const outcomes = await runBatchQueue(jobs, {
        concurrency: batchExecutionPlan.concurrency,
        signal: controller.signal,
        onItemStart: (job: BatchJob, index: number) => {
          updateJob(job.id, {
            status: "running",
            stageMessage: `${index + 1}번째 결과를 준비하고 있어요.`,
          });
        },
        worker: async (job: BatchJob, index: number) => {
          const { blob } = await convertLocalVideo({
            file,
            settings: job.settings,
            signal: controller.signal,
            onUpdate: (update) => {
              if (operationRef.current !== operation) return;
              updateOverallProgress(job.id, update.progress);
              updateJob(job.id, {
                status: "running",
                progress: update.progress,
                stageMessage: update.message,
              });
              setStageMessage(
                `${index + 1}/${jobs.length} ${job.label} 만들고 있어요.`,
              );
            },
            onEngineReady: (engine) => activeEnginesRef.current.add(engine),
            onEngineDisposed: (engine) => activeEnginesRef.current.delete(engine),
          });
          if (
            operationRef.current !== operation ||
            controller.signal.aborted
          ) {
            throw new DOMException("Aborted", "AbortError");
          }

          const name = makeBatchDownloadName(
            file.name,
            job.settings.format,
            job.label,
            index,
          );
          setCurrentResult(blob, name, job.settings.format, null);
          updateOverallProgress(job.id, 100);
          updateJob(job.id, {
            status: "complete",
            progress: 100,
            stageMessage: "최근 결과에 보관했어요.",
          });
          void rememberResult({
            blob,
            name,
            settings: job.settings,
            batch: {
              id: runId,
              label: job.label,
              index,
              total: jobs.length,
            },
          }).then((entry) => {
            if (entry) updateJob(job.id, { historyId: entry.id });
          });
          return job.id;
        },
        onItemSettled: (
          job: BatchJob,
          outcome: { status: string; error?: unknown },
        ) => {
          if (outcome.status === "rejected") {
            updateOverallProgress(job.id, 100);
            updateJob(job.id, {
              status: "failed",
              progress: 100,
              stageMessage: "이 결과만 만들지 못했어요.",
              error: getReadableError(outcome.error),
            });
          }
        },
      });

      if (
        operationRef.current !== operation ||
        controller.signal.aborted
      ) {
        return;
      }
      const completedThisRun = outcomes.filter(
        (outcome: { status: string }) => outcome.status === "fulfilled",
      ).length;
      const failed = outcomes.filter(
        (outcome: { status: string }) => outcome.status === "rejected",
      ).length;
      const completed = previouslyCompleted + completedThisRun;
      setProgress(100);
      if (completed > 0) {
        setPhase("complete");
        setStageMessage(
          failed
            ? `${completed}개 완료, ${failed}개는 만들지 못했어요. 완료된 결과는 최근 결과에서 확인할 수 있어요.`
            : `${completed}개 결과를 모두 만들었어요. 최근 결과에서 하나씩 확인하고 내려받을 수 있어요.`,
        );
      } else {
        setError("모든 결과를 만들지 못했어요. 각 결과의 설정을 낮춘 뒤 다시 시도해 주세요.");
        setPhase("error");
        setStageMessage("여러 결과 만들기를 완료하지 못했어요.");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  const outputSummary =
    phase === "inspecting"
      ? "추천 설정 계산 중"
      : workflow === "batch"
        ? `${batchJobs.length}개 결과 준비 중`
      : format === "gif"
      ? `${Number(normalized.duration.toFixed(1))}초, ${formatFrameRate(normalized.fps)} FPS, ${normalized.width}px, ${normalized.gifColors}색`
      : `${Number(normalized.duration.toFixed(1))}초, ${formatFrameRate(normalized.fps)} FPS, ${normalized.width}px, 압축 ${normalized.apngCompression}`;
  const historyTotalBytes = sumHistoryBytes(historyItems);
  const visibleHistoryItems = historyItems.slice(0, historyVisibleCount);
  const batchCompletedCount = batchJobs.filter(
    (job) => job.status === "complete",
  ).length;
  const batchFailedCount = batchJobs.filter(
    (job) => job.status === "failed",
  ).length;
  const batchCancelledCount = batchJobs.filter(
    (job) => job.status === "cancelled",
  ).length;
  const batchRunnableCount = batchJobs.filter((job) =>
    BATCH_RUNNABLE_STATUSES.has(job.status),
  ).length;
  const batchInvalidCount = batchJobsWithEstimates.filter(
    ({ job, validationError }) =>
      BATCH_RUNNABLE_STATUSES.has(job.status) && Boolean(validationError),
  ).length;
  const batchActionLabel =
    batchRunnableCount === 0
      ? "모두 완료됨"
      : batchFailedCount === batchRunnableCount
        ? `실패한 ${batchFailedCount}개 다시 시도`
        : batchCompletedCount > 0 || batchCancelledCount > 0
          ? `남은 ${batchRunnableCount}개 이어서 만들기`
          : `${batchRunnableCount}개 변환 시작`;
  const predictionRangeText =
    sizeEstimate.status === "available" && !settingsError
      ? formatEstimatedRange(
          sizeEstimate.rangeBytes.lower,
          sizeEstimate.rangeBytes.upper,
        )
      : null;
  const recommendationLiveText =
    file && metadata && mode !== "Advanced" && phase !== "inspecting"
      ? `${
          mode === "Beginner" || preset === "auto"
            ? "자동 추천"
            : `${PRESET_COPY.find((option) => option.id === preset)?.name} 프리셋`
        }이 준비됐어요. ${
          normalized.start > 0
            ? `${Number(normalized.start.toFixed(1))}초부터 `
            : "처음 "
        }${Number(normalized.duration.toFixed(1))}초, ${formatPresetGeometry(
          sizeEstimate.output.width ?? normalized.width,
          sizeEstimate.output.height,
        )}, ${formatFrameRate(normalized.fps)} FPS로 설정했어요.`
      : null;
  const recommendationRiskLiveText = recommendationWarning
    ? `${recommendationWarning.title} ${recommendationWarning.description}`
    : null;
  const predictionLiveText =
    phase === "inspecting"
      ? "영상 정보와 원본 FPS를 확인하고 예상 용량을 계산하는 중이에요."
      : settingsError
        ? "설정을 확인하면 예상 용량을 다시 계산할게요."
      : predictionRangeText
          ? [
            recommendationLiveText,
            `예상 출력 용량은 ${predictionRangeText}예요.`,
            recommendationRiskLiveText,
          ]
            .filter(Boolean)
            .join(" ")
        : metadata
          ? [
              recommendationLiveText,
              "영상 길이 또는 해상도를 확인할 수 없어 예상 용량을 계산할 수 없어요.",
              recommendationRiskLiveText,
            ]
              .filter(Boolean)
              .join(" ")
          : null;

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setAnnouncedPrediction(predictionLiveText ?? "");
    }, predictionLiveText ? 500 : 0);
    return () => window.clearTimeout(timeout);
  }, [predictionLiveText]);

  const statusText =
    isActive ||
    phase === "inspecting" ||
    phase === "complete" ||
    phase === "cancelled" ||
    phase === "error"
      ? stageMessage
      : settingsError ??
        ([stageMessage, announcedPrediction, inspectionWarning, historyNotice]
          .filter(Boolean)
          .join(" ") ||
          stageMessage);

  return (
    <main className="site-shell">
      <header className="site-header">
        <a className="brand" href="#converter" aria-label="핌쥐 변환기로 이동">
          {/* A relative URL keeps this generated brand mark portable across Pages and Sites. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="brand-mark"
            src="./pimg-mark.png"
            alt=""
            width="40"
            height="40"
          />
          <span>핌쥐</span>
        </a>
        <div className="header-actions">
          <button
            className="history-trigger"
            type="button"
            onClick={openHistoryDialog}
            aria-label={`최근 결과 열기, ${historyItems.length}개`}
          >
            최근 결과
            <strong>{historyItems.length}</strong>
          </button>
          <span className="local-badge">
            <span aria-hidden="true">●</span>
            브라우저에서만
          </span>
        </div>
      </header>

      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">VIDEO → APNG / GIF</p>
        <h1 id="page-title">동영상을 가볍게, 움직이는 이미지로</h1>
        <p className="hero-copy">
          복잡한 설치 없이 파일을 고르고, 원하는 형식을 선택하면 끝이에요.
          <br className="desktop-break" /> 파일은 업로드되지 않아요. 변환은 이
          브라우저 안에서 진행됩니다.
        </p>
        <div className="trust-row" aria-label="서비스 특징">
          <span>서버 업로드 없음</span>
          <span>계정 필요 없음</span>
          <span>브라우저에서 바로 변환</span>
        </div>
      </section>

      <section className="converter-card" id="converter" aria-label="동영상 변환기">
        <ol className="step-strip" aria-label="변환 순서">
          <li
            className={file ? "is-done" : "is-current"}
            aria-current={!file ? "step" : undefined}
          >
            1. 파일
          </li>
          <li
            className={
              isActive || phase === "complete"
                ? "is-done"
                : file
                  ? "is-current"
                  : ""
            }
            aria-current={file && !isActive && phase !== "complete" ? "step" : undefined}
          >
            2. 설정
          </li>
          <li
            className={
              phase === "complete" ? "is-done" : isActive ? "is-current" : ""
            }
            aria-current={isActive ? "step" : undefined}
          >
            3. 변환
          </li>
        </ol>

        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {statusText}
        </div>

        {!file ? (
          <div className="upload-section">
            <button
              className={`drop-zone ${isDragging ? "is-dragging" : ""}`}
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                  setIsDragging(false);
                }
              }}
              onDrop={handleDrop}
              aria-label="동영상 파일 선택 또는 끌어놓기"
            >
              <span className="upload-icon" aria-hidden="true">
                <span>↑</span>
              </span>
              <strong>동영상을 여기에 놓아주세요</strong>
              <span>또는 눌러서 파일 선택</span>
              <small>MP4, MOV, WebM 등 · 최대 1GB</small>
            </button>
            {error && (
              <div className="error-message upload-error" role="alert">
                <span aria-hidden="true">!</span>
                <div>
                  <strong>파일을 열 수 없어요</strong>
                  <p>{error}</p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="workspace">
            <section className="source-panel" aria-labelledby="source-title">
              <div className="panel-heading">
                <div>
                  <p className="section-kicker">SOURCE</p>
                  <h2 id="source-title">선택한 동영상</h2>
                </div>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isActive}
                >
                  다른 파일
                </button>
              </div>

              <div
                className="video-frame"
                aria-busy={phase === "inspecting"}
              >
                {metadata?.previewAvailable && sourceUrl ? (
                  <video controls preload="metadata" src={sourceUrl}>
                    이 브라우저는 동영상 미리보기를 지원하지 않아요.
                  </video>
                ) : (
                  <div className="preview-placeholder">
                    {phase === "inspecting" ? (
                      <span className="inspection-spinner" aria-hidden="true" />
                    ) : (
                      <span aria-hidden="true">▶</span>
                    )}
                    <p>
                      {phase === "inspecting"
                        ? "미리보기를 준비하고 있어요"
                        : "미리보기를 표시할 수 없어요"}
                    </p>
                  </div>
                )}
              </div>

              {inspectionWarning && (
                <p className="inline-note">{inspectionWarning}</p>
              )}

              <div className="file-heading">
                <span className="file-type" aria-hidden="true">
                  {fileExtension(file.name).slice(0, 4).toUpperCase() || "VID"}
                </span>
                <div>
                  <strong title={file.name}>{file.name}</strong>
                  <span>
                    {file.type || "동영상 파일"} · {formatBytes(file.size)}
                  </span>
                </div>
              </div>

              <dl className="metadata-grid">
                <div>
                  <dt>길이</dt>
                  <dd>{formatDuration(metadata?.duration ?? null)}</dd>
                </div>
                <div>
                  <dt>해상도</dt>
                  <dd>
                    {metadata?.width && metadata.height
                      ? `${metadata.width} × ${metadata.height}`
                      : "확인 불가"}
                  </dd>
                </div>
                <div>
                  <dt>원본 FPS</dt>
                  <dd title="브라우저에서 영상 프레임을 짧게 재생해 측정한 값">
                    {phase === "inspecting"
                      ? "측정 중"
                      : formatSourceFrameRate(metadata?.fps ?? null)}
                  </dd>
                </div>
                <div>
                  <dt>화면 비율</dt>
                  <dd>
                    {formatAspect(
                      metadata?.width ?? null,
                      metadata?.height ?? null,
                    )}
                  </dd>
                </div>
              </dl>
              {metadata?.fps && (
                <p className="metadata-note">
                  원본 FPS는 브라우저가 영상 일부를 재생해 측정한 근사값이에요.
                </p>
              )}
            </section>

            <section className="settings-panel" aria-labelledby="settings-title">
              <div className="panel-heading settings-heading">
                <div>
                  <p className="section-kicker">OUTPUT</p>
                  <h2 id="settings-title" tabIndex={-1}>어떻게 만들까요?</h2>
                </div>
                <span className="summary-chip">{outputSummary}</span>
              </div>

              <fieldset className="format-fieldset" disabled={controlsDisabled}>
                <legend>파일 형식</legend>
                <div className="format-options">
                  <label className={format === "apng" ? "is-selected" : ""}>
                    <input
                      type="radio"
                      name="format"
                      value="apng"
                      checked={format === "apng"}
                      onChange={() => setFormat("apng")}
                    />
                    <span className="format-name">
                      <strong>움직이는 PNG</strong>
                      <em>APNG · 선명한 색</em>
                    </span>
                    <small>색과 선명함을 더 잘 유지해요.</small>
                  </label>
                  <label className={format === "gif" ? "is-selected" : ""}>
                    <input
                      type="radio"
                      name="format"
                      value="gif"
                      checked={format === "gif"}
                      onChange={() => setFormat("gif")}
                    />
                    <span className="format-name">
                      <strong>GIF</strong>
                      <em>넓은 호환성</em>
                    </span>
                    <small>호환성이 넓지만 최대 256색으로 표현돼요.</small>
                  </label>
                </div>
              </fieldset>

              <fieldset className="mode-fieldset" disabled={controlsDisabled}>
                <legend>경험 수준</legend>
                <div className="mode-options">
                  {MODE_COPY.map((option) => (
                    <label
                      key={option.name}
                      className={mode === option.name ? "is-selected" : ""}
                    >
                      <input
                        type="radio"
                        name="mode"
                        value={option.name}
                        checked={mode === option.name}
                        onChange={() => handleModeChange(option.name)}
                      />
                      <span>
                        {option.label}
                        <em>{option.name}</em>
                      </span>
                      <small>{option.eyebrow}</small>
                    </label>
                  ))}
                </div>
                <p className="mode-description">
                  {
                    MODE_COPY.find((option) => option.name === mode)
                      ?.description
                  }
                </p>
              </fieldset>

              {mode === "Beginner" && (
                <div className="beginner-summary">
                  <span className="spark" aria-hidden="true">
                    ✦
                  </span>
                  <div>
                    <strong>
                      {phase === "inspecting"
                        ? "영상에 맞는 설정을 찾는 중이에요"
                        : file
                          ? "이 영상에 맞춰 조정했어요"
                          : "파일을 고르면 맞춰 드릴게요"}
                    </strong>
                    <p>
                      {file
                        ? fpsAdjustmentCopy(
                            metadata?.fps ?? null,
                            automaticRecommendation.settings.fps,
                            adaptiveRationale(automaticRecommendation.rationale),
                          )
                        : "영상 길이와 해상도에 따라 프레임과 크기가 달라져요."}
                    </p>
                  </div>
                  <dl>
                    <div>
                      <dt>출력 FPS</dt>
                      <dd>
                        {phase === "inspecting"
                          ? "계산 중"
                          : `${formatFrameRate(normalized.fps)} FPS`}
                      </dd>
                    </div>
                    <div>
                      <dt>크기</dt>
                      <dd>
                        {phase === "inspecting"
                          ? "계산 중"
                          : `최대 ${automaticRecommendation.output.width}px`}
                      </dd>
                    </div>
                    <div>
                      <dt>반복</dt>
                      <dd>{phase === "inspecting" ? "계산 중" : "계속"}</dd>
                    </div>
                  </dl>
                </div>
              )}

              {mode === "Intermediate" && (
                <div className="disclosed-controls">
                  <fieldset
                    className="preset-fieldset"
                    disabled={controlsDisabled}
                  >
                    <legend>어떤 결과가 좋으세요?</legend>
                    <div className="preset-options">
                      {PRESET_COPY.map((option) => {
                        const recommendation =
                          intermediateRecommendations[option.id];
                        const nameId = `preset-${option.id}-name`;
                        const descriptionId = `preset-${option.id}-description`;
                        const detailsId = `preset-${option.id}-details`;
                        const estimateId = `preset-${option.id}-estimate`;
                        const describedBy = [
                          descriptionId,
                          detailsId,
                          file && phase !== "inspecting" ? estimateId : null,
                        ]
                          .filter(Boolean)
                          .join(" ");
                        return (
                          <label
                            key={option.id}
                            className={`${
                              preset === option.id ? "is-selected " : ""
                            }${option.id === "auto" ? "is-auto" : ""}`}
                          >
                            <input
                              type="radio"
                              name="preset"
                              value={option.id}
                              checked={preset === option.id}
                              onChange={() => setPreset(option.id)}
                              aria-labelledby={nameId}
                              aria-describedby={describedBy}
                            />
                            <strong id={nameId}>{option.name}</strong>
                            {preset === option.id && (
                              <small
                                className="preset-selected-state"
                                aria-hidden="true"
                              >
                                선택됨
                              </small>
                            )}
                            <small
                              className="preset-description"
                              id={descriptionId}
                            >
                              {option.id === "auto" && file
                                ? adaptiveRationale(recommendation.rationale)
                                : option.description}
                            </small>
                            <small className="preset-specs" id={detailsId}>
                              {phase === "inspecting"
                                ? "영상 분석 중"
                                : !file
                                  ? "파일을 고르면 계산"
                                  : `${formatPresetGeometry(
                                      recommendation.output.width,
                                      recommendation.output.height,
                                    )} · ${formatFrameRate(
                                      recommendation.settings.fps,
                                    )} FPS`}
                            </small>
                            {file && phase !== "inspecting" && (
                              <small className="preset-estimate" id={estimateId}>
                                {recommendation.canConvert === false
                                  ? "구간을 줄여야 해요"
                                  : formatPresetEstimate(recommendation.estimate)}
                              </small>
                            )}
                          </label>
                        );
                      })}
                    </div>
                    <p className="preset-help">
                      추천 FPS가 원본보다 낮다면 예상 용량과 브라우저 부담을
                      줄이기 위해서예요. 아래에서 원본 기준이나 표준 FPS를 직접
                      선택할 수 있어요.
                    </p>
                  </fieldset>
                  <section className="fps-selector" aria-label="출력 FPS 설정">
                    <Selector
                      label="출력 FPS"
                      description={
                        phase === "inspecting"
                          ? "원본 FPS를 측정한 뒤 선택 가능한 표준값을 보여드릴게요."
                          : metadata?.fps
                          ? `원본은 약 ${formatFrameRate(metadata.fps)} FPS예요. 원본보다 높지 않은 표준 옵션을 모두 보여줘요.`
                          : "원본 FPS를 확인하지 못해 1-60 FPS 표준 옵션을 모두 보여줘요."
                      }
                      options={intermediateFpsOptions}
                      value={fpsPreference}
                      onChange={(value) =>
                        setFpsPreference(value as FpsPreference)
                      }
                      size="md"
                      width="100%"
                      isDisabled={controlsDisabled}
                      disabledMessage="영상 확인이나 변환이 끝난 뒤 바꿀 수 있어요."
                    />
                    {format === "gif" && normalized.fps >= 48 && (
                      <p className="fps-selector-note">
                        GIF는 50 FPS 이상에서 재생 간격이 조금 다르게 보일 수
                        있어요.
                      </p>
                    )}
                  </section>
                  <div className="control-grid two-columns">
                    <label>
                      <span>시작 위치 <small>초</small></span>
                      <input
                        type="number"
                        min="0"
                        max={
                          metadata?.duration
                            ? Math.max(0, metadata.duration - 0.1)
                            : undefined
                        }
                        step="0.1"
                        value={start}
                        onChange={(event) => setStart(Number(event.target.value))}
                        disabled={controlsDisabled}
                      />
                    </label>
                    <label>
                      <span>변환 길이 <small>초</small></span>
                      <input
                        type="number"
                        min="0.1"
                        max={
                          metadata?.duration
                            ? Math.max(0.1, metadata.duration - start)
                            : undefined
                        }
                        step="0.1"
                        value={duration}
                        onChange={(event) =>
                          setDuration(Number(event.target.value))
                        }
                        disabled={controlsDisabled}
                      />
                    </label>
                  </div>
                </div>
              )}

              {mode === "Advanced" && (
                <div className="disclosed-controls advanced-controls">
                  <section
                    className="advanced-recommendation"
                    aria-label="추천 설정"
                  >
                    <p>
                      <strong>이 영상 추천</strong>
                      <span>
                        {phase === "inspecting" ? (
                          "영상 분석 중"
                        ) : (
                          <>
                            {formatFrameRate(
                              automaticRecommendation.settings.fps,
                            )} FPS / 최대{" "}
                            {automaticRecommendation.output.width}px
                          </>
                        )}
                      </span>
                    </p>
                    <Button
                      label={
                        advancedRecommendationMatches
                          ? "추천값 적용됨"
                          : advancedDirty
                          ? "추천값으로 다시 설정"
                          : "이 영상 추천값 불러오기"
                      }
                      variant="secondary"
                      size="sm"
                      onClick={loadRecommendedSettings}
                      isDisabled={controlsDisabled || advancedRecommendationMatches}
                    />
                  </section>
                  <section
                    className="fps-selector advanced-fps-selector"
                    aria-label="FPS 빠른 선택"
                  >
                    <Selector
                      label="FPS 빠른 선택"
                      description={
                        phase === "inspecting"
                          ? "원본 FPS를 측정한 뒤 선택 가능한 표준값을 보여드릴게요."
                          : metadata?.fps
                          ? `원본 약 ${formatFrameRate(metadata.fps)} FPS 이하의 표준값을 바로 적용할 수 있어요.`
                          : "1-60 FPS 표준값을 바로 적용하거나 아래에 직접 입력하세요."
                      }
                      options={directFpsOptions}
                      value={
                        advancedFpsValue &&
                        advancedFpsOptionValues.has(advancedFpsValue)
                          ? advancedFpsValue
                          : undefined
                      }
                      placeholder={
                        Number.isFinite(fps)
                          ? `직접 입력 중 (${formatFrameRate(fps)} FPS)`
                          : "표준 FPS 선택"
                      }
                      onChange={(value) => {
                        const nextFps = frameRateFromPreference(
                          value as FpsPreference,
                        );
                        if (nextFps !== null) {
                          updateAdvancedSetting(() => setFps(nextFps));
                        }
                      }}
                      size="md"
                      width="100%"
                      isDisabled={controlsDisabled}
                      disabledMessage="영상 확인이나 변환이 끝난 뒤 바꿀 수 있어요."
                    />
                    {format === "gif" && fps >= 48 && (
                      <p className="fps-selector-note">
                        GIF는 50 FPS 이상에서 재생 간격이 조금 다르게 보일 수
                        있어요.
                      </p>
                    )}
                  </section>
                  <div className="control-grid three-columns">
                    <label>
                      <span>시작 <small>초</small></span>
                      <input
                        type="number"
                        min="0"
                        max={
                          metadata?.duration
                            ? Math.max(0, metadata.duration - 0.1)
                            : undefined
                        }
                        step="0.1"
                        value={start}
                        onChange={(event) =>
                          updateAdvancedSetting(() =>
                            setStart(Number(event.target.value)),
                          )
                        }
                        disabled={controlsDisabled}
                      />
                    </label>
                    <label>
                      <span>길이 <small>초</small></span>
                      <input
                        type="number"
                        min="0.1"
                        max={
                          metadata?.duration
                            ? Math.max(0.1, metadata.duration - start)
                            : undefined
                        }
                        step="0.1"
                        value={duration}
                        onChange={(event) =>
                          updateAdvancedSetting(() =>
                            setDuration(Number(event.target.value)),
                          )
                        }
                        disabled={controlsDisabled}
                      />
                    </label>
                    <label>
                      <span>반복 <small>총 재생</small></span>
                      <select
                        value={plays}
                        onChange={(event) =>
                          updateAdvancedSetting(() =>
                            setPlays(Number(event.target.value)),
                          )
                        }
                        disabled={controlsDisabled}
                      >
                        <option value="0">계속</option>
                        <option value="1">1회</option>
                        <option value="2">2회</option>
                        <option value="3">3회</option>
                        <option value="5">5회</option>
                        <option value="10">10회</option>
                      </select>
                    </label>
                    <label>
                      <span>FPS 직접 입력 <small>1-60</small></span>
                      <input
                        type="number"
                        min="1"
                        max="60"
                        step="0.001"
                        aria-describedby="fps-input-help"
                        value={fps}
                        onChange={(event) =>
                          updateAdvancedSetting(() =>
                            setFps(Number(event.target.value)),
                          )
                        }
                        disabled={controlsDisabled}
                      />
                      <small className="field-help" id="fps-input-help">
                        23.976, 29.97, 59.94처럼 소수 FPS도 사용할 수 있어요.
                      </small>
                    </label>
                    <label>
                      <span>최대 너비 <small>px</small></span>
                      <input
                        type="number"
                        min="160"
                        max="1920"
                        step="10"
                        value={width}
                        onChange={(event) =>
                          updateAdvancedSetting(() =>
                            setWidth(Number(event.target.value)),
                          )
                        }
                        disabled={controlsDisabled}
                      />
                    </label>
                    {format === "apng" && (
                      <label>
                        <span>압축 <small>0-9</small></span>
                        <input
                          type="number"
                          min="0"
                          max="9"
                          aria-describedby="apng-compression-help"
                          value={apngCompression}
                          onChange={(event) =>
                            updateAdvancedSetting(() =>
                              setApngCompression(Number(event.target.value)),
                            )
                          }
                          disabled={controlsDisabled}
                        />
                        <small className="field-help" id="apng-compression-help">
                          높을수록 파일은 작아지지만 변환은 느려져요.
                        </small>
                      </label>
                    )}
                  </div>

                  {format === "gif" && (
                    <div className="control-grid three-columns format-controls">
                      <label>
                        <span>색상 수</span>
                        <input
                          type="number"
                          min="2"
                          max="256"
                          aria-describedby="gif-colors-help"
                          value={gifColors}
                          onChange={(event) =>
                            updateAdvancedSetting(() =>
                              setGifColors(Number(event.target.value)),
                            )
                          }
                          disabled={controlsDisabled}
                        />
                        <small className="field-help" id="gif-colors-help">
                          많을수록 색은 정확하고 파일은 커져요.
                        </small>
                      </label>
                      <label>
                        <span>색상 분석</span>
                        <select
                          value={gifStats}
                          aria-describedby="gif-stats-help"
                          onChange={(event) =>
                            updateAdvancedSetting(() =>
                              setGifStats(event.target.value),
                            )
                          }
                          disabled={controlsDisabled}
                        >
                          <option value="diff">움직임 중심</option>
                          <option value="full">전체 프레임</option>
                        </select>
                        <small className="field-help" id="gif-stats-help">
                          움직임 중심은 대부분의 영상에 가장 효율적이에요.
                        </small>
                      </label>
                      <label>
                        <span>디더링</span>
                        <select
                          value={gifDither}
                          aria-describedby="gif-dither-help"
                          onChange={(event) =>
                            updateAdvancedSetting(() =>
                              setGifDither(event.target.value),
                            )
                          }
                          disabled={controlsDisabled}
                        >
                          <option value="sierra2_4a">Sierra (균형)</option>
                          <option value="floyd_steinberg">Floyd-Steinberg</option>
                          <option value="bayer">Bayer</option>
                          <option value="none">사용 안 함</option>
                        </select>
                        <small className="field-help" id="gif-dither-help">
                          그라데이션의 띠 현상을 줄이는 색 혼합 방식이에요.
                        </small>
                      </label>
                    </div>
                  )}
                </div>
              )}

              <section
                className={`prediction-card ${
                  sizeEstimate.sizeClass === "very-large"
                    ? "is-very-large"
                    : sizeEstimate.sizeClass === "large"
                    ? "is-large"
                    : settingsError || sizeEstimate.status === "unavailable"
                      ? "is-unavailable"
                      : ""
                }`}
                hidden={workflow === "batch"}
                aria-labelledby="prediction-title"
                aria-busy={phase === "inspecting"}
              >
                {phase === "inspecting" ? (
                  <>
                    <p className="prediction-label" id="prediction-title">
                      예상 결과 용량
                    </p>
                    <p className="prediction-value">계산 중</p>
                    <p className="prediction-uncertainty" id="prediction-help">
                      영상 길이와 해상도를 확인하고 있어요.
                    </p>
                  </>
                ) : settingsError ? (
                  <>
                    <p className="prediction-label" id="prediction-title">
                      예상 결과 용량
                    </p>
                    <p className="prediction-value">설정을 확인해 주세요</p>
                    <p className="prediction-uncertainty" id="prediction-help">
                      올바른 값을 입력하면 예상 범위를 바로 다시 계산할게요.
                    </p>
                  </>
                ) : sizeEstimate.status === "available" ? (
                  <>
                    <div className="prediction-heading">
                      <div>
                        <p className="prediction-label" id="prediction-title">
                          {isActive ? "변환 전 예상" : "예상 결과 용량"}
                        </p>
                        <output
                          className="prediction-value"
                          aria-labelledby="prediction-title"
                          aria-describedby="prediction-help"
                        >
                          {predictionRangeText}
                        </output>
                      </div>
                    </div>

                    {mode !== "Beginner" && (
                      <dl className="prediction-metrics">
                        <div>
                          <dt>출력 크기</dt>
                          <dd>
                            {sizeEstimate.output.width} ×{" "}
                            {sizeEstimate.output.height}px
                          </dd>
                        </div>
                        <div>
                          <dt>예상 프레임</dt>
                          <dd>{sizeEstimate.output.frameCount}장</dd>
                        </div>
                        <div>
                          <dt>확실성</dt>
                          <dd>참고용 범위</dd>
                        </div>
                      </dl>
                    )}

                    <p className="prediction-uncertainty" id="prediction-help">
                      실제 용량은 영상의 움직임과 색 변화에 따라 달라질 수 있어요.
                    </p>

                    {mode === "Advanced" && (
                      <details className="prediction-assumptions">
                        <summary>계산 기준과 한계</summary>
                        <p>
                          영상 메타데이터와 현재 설정을 사용하며, 원본 파일 크기는
                          약한 복잡도 신호로만 반영해요. 프레임을 미리 분석하거나
                          변환하지 않습니다.
                        </p>
                        <p>
                          반복 횟수는 파일 크기를 늘리지 않아요. GIF 디더링과 색상
                          분석 방식은 실측 보정값으로만 반영해 영상마다 결과
                          순서가 달라질 수 있어요. 목표 용량 탐색에서는 일반
                          비교에 예상 중심값, 보수적 비교에 범위 상한을 사용할 수
                          있어요. 모델{" "}
                          {OUTPUT_SIZE_MODEL_VERSION}
                        </p>
                        {sizeEstimate.capped && (
                          <p>
                            이 값은 모델의 최대 표시 한도에 닿아 후보끼리 직접
                            비교하기 어려워요.
                          </p>
                        )}
                      </details>
                    )}

                    {sizeEstimate.sizeClass !== "normal" && (
                      <div className="prediction-large-warning">
                        <strong>
                          {sizeEstimate.sizeClass === "very-large"
                            ? "파일이 매우 커질 수 있어요"
                            : "용량이 큰 편이에요"}
                        </strong>
                        <p>
                          길이, FPS 또는 최대 너비를 낮추면 용량을 줄일 수 있어요.
                        </p>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <p className="prediction-label" id="prediction-title">
                      예상 결과 용량
                    </p>
                    <p className="prediction-value">
                      예상 용량을 계산할 수 없어요
                    </p>
                    <p className="prediction-uncertainty" id="prediction-help">
                      영상 정보를 확인하지 못했어요. 변환 후 실제 용량은 확인할
                      수 있습니다.
                    </p>
                  </>
                )}
                {recommendationWarning &&
                  phase !== "inspecting" &&
                  !settingsError && (
                    <aside
                      className={`prediction-performance-warning is-${recommendationWarning.level}`}
                      aria-label="변환 부담 안내"
                    >
                      <strong>{recommendationWarning.title}</strong>
                      <p>{recommendationWarning.description}</p>
                    </aside>
                  )}
              </section>

              {workflow === "batch" && (
                <section
                  className="batch-builder"
                  aria-labelledby="batch-builder-title"
                >
                  <header className="batch-builder-heading">
                    <div>
                      <p className="section-kicker">MULTI OUTPUT</p>
                      <h3 id="batch-builder-title" tabIndex={-1}>
                        여러 버전 만들기
                      </h3>
                      <p>
                        한 영상에서 용량과 선명도가 다른 결과를 한 번에 만들어요.
                      </p>
                    </div>
                    <Button
                      label="단일 변환으로 돌아가기"
                      variant="ghost"
                      size="sm"
                      isDisabled={isActive}
                      onClick={leaveBatchMode}
                    />
                  </header>

                  <div className="batch-toolbar">
                    <p>
                      추천 3종을 준비했어요. 각 결과를 눌러 형식, FPS, 크기와
                      세부 품질을 바꿀 수 있어요.
                    </p>
                    <div className="batch-toolbar-actions">
                      <Button
                        label="현재 설정 추가"
                        variant="secondary"
                        size="sm"
                        isDisabled={isActive || batchJobs.length >= MAX_BATCH_JOBS}
                        onClick={addCurrentBatchJob}
                      />
                      <Button
                        label="추천 3종 되돌리기"
                        variant="ghost"
                        size="sm"
                        isDisabled={isActive}
                        onClick={() => setBatchJobs(recommendedBatchJobs())}
                      />
                    </div>
                  </div>

                  {batchJobs.length === 0 ? (
                    <div className="batch-empty">
                      <strong>만들 결과가 없어요</strong>
                      <p>추천 3종을 다시 담거나 현재 설정을 추가해 주세요.</p>
                      <Button
                        label="추천 3종 담기"
                        variant="secondary"
                        size="sm"
                        onClick={() => setBatchJobs(recommendedBatchJobs())}
                      />
                    </div>
                  ) : (
                    <ol className="batch-job-list">
                      {batchJobsWithEstimates.map(
                        ({ job, estimate, validationError }, index) => (
                        <li
                          className={`batch-job is-${job.status}`}
                          id={`batch-job-${job.id}`}
                          key={job.id}
                          tabIndex={-1}
                        >
                          <Collapsible
                            defaultIsOpen={false}
                            trigger={
                              <span className="batch-job-trigger">
                                <span className="batch-job-number">
                                  {index + 1}
                                </span>
                                <span className="batch-job-copy">
                                  <strong>{job.label || `결과 ${index + 1}`}</strong>
                                  <small>{settingsSummary(job.settings)}</small>
                                </span>
                                <span
                                  className={`batch-job-status ${
                                    validationError
                                      ? "is-failed"
                                      : `is-${job.status}`
                                  }`}
                                >
                                  {validationError
                                    ? "설정 확인"
                                    : BATCH_STATUS_COPY[job.status]}
                                </span>
                              </span>
                            }
                          >
                            <div className="batch-job-editor">
                              <div className="batch-job-overview">
                                <span>{job.settings.format.toUpperCase()}</span>
                                <span>
                                  {estimate.status === "available"
                                    ? formatEstimatedRange(
                                        estimate.rangeBytes.lower,
                                        estimate.rangeBytes.upper,
                                      )
                                    : "예상 용량 확인 불가"}
                                </span>
                              </div>

                              <div className="batch-control-grid two-columns">
                                <label>
                                  <span>결과 이름</span>
                                  <input
                                    type="text"
                                    maxLength={36}
                                    value={job.label}
                                    disabled={isActive}
                                    onChange={(event) =>
                                      updateBatchLabel(job.id, event.target.value)
                                    }
                                  />
                                </label>
                                <label>
                                  <span>형식</span>
                                  <select
                                    value={job.settings.format}
                                    disabled={isActive}
                                    onChange={(event) =>
                                      updateBatchPreset(
                                        job.id,
                                        event.target.value as Format,
                                        job.preset,
                                      )
                                    }
                                  >
                                    <option value="gif">GIF</option>
                                    <option value="apng">움직이는 PNG</option>
                                  </select>
                                </label>
                                <label>
                                  <span>품질 기준</span>
                                  <select
                                    value={job.preset}
                                    disabled={isActive}
                                    onChange={(event) =>
                                      updateBatchPreset(
                                        job.id,
                                        job.settings.format,
                                        event.target.value as BatchPreset,
                                      )
                                    }
                                  >
                                    {job.preset === "custom" && (
                                      <option value="custom">직접 조정</option>
                                    )}
                                    {BATCH_PRESET_COPY.map((option) => (
                                      <option key={option.id} value={option.id}>
                                        {option.label}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label>
                                  <span>FPS</span>
                                  <select
                                    value={formatFrameRate(job.settings.fps)}
                                    disabled={isActive}
                                    onChange={(event) =>
                                      updateBatchSettings(job.id, {
                                        fps: Number(event.target.value),
                                      })
                                    }
                                  >
                                    {!batchFpsValues.some(
                                      (value) =>
                                        Math.abs(value - job.settings.fps) < 0.0005,
                                    ) && (
                                      <option value={job.settings.fps}>
                                        {formatFrameRate(job.settings.fps)} FPS
                                      </option>
                                    )}
                                    {batchFpsValues.map((value) => (
                                      <option
                                        key={formatFrameRate(value)}
                                        value={formatFrameRate(value)}
                                      >
                                        {formatFrameRate(value)} FPS
                                        {metadata?.fps &&
                                        Math.abs(
                                          Math.min(metadata.fps, 60) - value,
                                        ) < 0.0005
                                          ? " (원본)"
                                          : ""}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              </div>

                              <div className="batch-control-grid four-columns">
                                <label>
                                  <span>시작 <small>초</small></span>
                                  <input
                                    type="number"
                                    min="0"
                                    max={metadata?.duration ?? undefined}
                                    step="0.1"
                                    value={job.settings.start}
                                    disabled={isActive}
                                    onChange={(event) =>
                                      updateBatchSettings(job.id, {
                                        start: Number(event.target.value),
                                      })
                                    }
                                  />
                                </label>
                                <label>
                                  <span>길이 <small>초</small></span>
                                  <input
                                    type="number"
                                    min="0.1"
                                    max={metadata?.duration ?? undefined}
                                    step="0.1"
                                    value={job.settings.duration}
                                    disabled={isActive}
                                    onChange={(event) =>
                                      updateBatchSettings(job.id, {
                                        duration: Number(event.target.value),
                                      })
                                    }
                                  />
                                </label>
                                <label>
                                  <span>너비 <small>px</small></span>
                                  <input
                                    type="number"
                                    min="160"
                                    max="1920"
                                    step="10"
                                    value={job.settings.width}
                                    disabled={isActive}
                                    onChange={(event) =>
                                      updateBatchSettings(job.id, {
                                        width: Number(event.target.value),
                                      })
                                    }
                                  />
                                </label>
                                <label>
                                  <span>재생 횟수</span>
                                  <select
                                    value={job.settings.plays}
                                    disabled={isActive}
                                    onChange={(event) =>
                                      updateBatchSettings(job.id, {
                                        plays: Number(event.target.value),
                                      })
                                    }
                                  >
                                    <option value="0">계속 반복</option>
                                    <option value="1">1번</option>
                                    <option value="2">2번</option>
                                    <option value="3">3번</option>
                                  </select>
                                </label>
                              </div>

                              {job.settings.format === "gif" ? (
                                <div className="batch-control-grid three-columns">
                                  <label>
                                    <span>색상 수</span>
                                    <input
                                      type="number"
                                      min="2"
                                      max="256"
                                      value={job.settings.gifColors}
                                      disabled={isActive}
                                      onChange={(event) =>
                                        updateBatchSettings(job.id, {
                                          gifColors: Number(event.target.value),
                                        })
                                      }
                                    />
                                  </label>
                                  <label>
                                    <span>색상 분석</span>
                                    <select
                                      value={job.settings.gifStats}
                                      disabled={isActive}
                                      onChange={(event) =>
                                        updateBatchSettings(job.id, {
                                          gifStats: event.target
                                            .value as ResolvedConversionSettings["gifStats"],
                                        })
                                      }
                                    >
                                      <option value="diff">움직임 중심</option>
                                      <option value="full">전체 프레임</option>
                                    </select>
                                  </label>
                                  <label>
                                    <span>디더링</span>
                                    <select
                                      value={job.settings.gifDither}
                                      disabled={isActive}
                                      onChange={(event) =>
                                        updateBatchSettings(job.id, {
                                          gifDither: event.target
                                            .value as ResolvedConversionSettings["gifDither"],
                                        })
                                      }
                                    >
                                      <option value="sierra2_4a">Sierra</option>
                                      <option value="floyd_steinberg">
                                        Floyd-Steinberg
                                      </option>
                                      <option value="bayer">Bayer</option>
                                      <option value="none">사용 안 함</option>
                                    </select>
                                  </label>
                                </div>
                              ) : (
                                <div className="batch-control-grid one-column">
                                  <label>
                                    <span>APNG 압축 <small>0-9</small></span>
                                    <input
                                      type="number"
                                      min="0"
                                      max="9"
                                      value={job.settings.apngCompression}
                                      disabled={isActive}
                                      onChange={(event) =>
                                        updateBatchSettings(job.id, {
                                          apngCompression: Number(
                                            event.target.value,
                                          ),
                                        })
                                      }
                                    />
                                  </label>
                                </div>
                              )}

                              {job.status === "running" && (
                                <div className="batch-job-progress">
                                  <progress
                                    max="100"
                                    value={job.progress}
                                    aria-label={`${job.label} 변환 진행률 ${job.progress}%`}
                                  />
                                  <span>{job.stageMessage}</span>
                                </div>
                              )}
                              {job.error && (
                                <p className="batch-job-error" role="alert">
                                  {job.error}
                                </p>
                              )}
                              {validationError && (
                                <p className="batch-job-error" role="alert">
                                  {validationError}
                                </p>
                              )}

                              <div className="batch-job-actions">
                                <Button
                                  label={`${job.label} 복제`}
                                  variant="secondary"
                                  size="sm"
                                  isDisabled={
                                    isActive || batchJobs.length >= MAX_BATCH_JOBS
                                  }
                                  onClick={() => duplicateBatchJob(job.id)}
                                >
                                  복제
                                </Button>
                                {pendingBatchDelete === job.id ? (
                                  <>
                                    <Button
                                      label={`${job.label} 삭제 확인`}
                                      variant="destructive"
                                      size="sm"
                                      onClick={() => {
                                        removeBatchJob(job.id);
                                        setPendingBatchDelete(null);
                                      }}
                                    >
                                      정말 삭제
                                    </Button>
                                    <Button
                                      label="삭제 취소"
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setPendingBatchDelete(null)}
                                    >
                                      취소
                                    </Button>
                                  </>
                                ) : (
                                  <Button
                                    label={`${job.label} 삭제`}
                                    variant="ghost"
                                    size="sm"
                                    isDisabled={isActive}
                                    onClick={() => setPendingBatchDelete(job.id)}
                                  >
                                    삭제
                                  </Button>
                                )}
                              </div>
                            </div>
                          </Collapsible>
                        </li>
                      ),
                      )}
                    </ol>
                  )}

                  <footer className="batch-summary">
                    <div>
                      <strong>{batchJobs.length}개 결과</strong>
                      <span>
                        예상 합계 {batchEstimateTotals
                          ? formatEstimatedRange(
                              batchEstimateTotals.lower,
                              batchEstimateTotals.upper,
                            )
                          : "확인 불가"}
                      </span>
                    </div>
                    <p>
                      {batchInvalidCount > 0
                        ? `${batchInvalidCount}개 결과의 설정을 조정하면 시작할 수 있어요.`
                        : batchExecutionPlan.concurrency === 2
                        ? "이 기기는 메모리 여유가 확인되어 2개씩 병렬 처리해요."
                        : "브라우저 안정성을 위해 하나씩 차례로 처리해요."}
                    </p>
                    {batchJobs.length >= 4 && (
                      <small>
                        결과가 많으면 시간이 오래 걸릴 수 있어요. 최대 5개까지
                        만들 수 있습니다.
                      </small>
                    )}
                  </footer>
                </section>
              )}

              {error && (
                <div className="error-message" role="alert">
                  <span aria-hidden="true">!</span>
                  <div>
                    <strong>다시 확인해 주세요</strong>
                    <p>{error}</p>
                  </div>
                </div>
              )}

              {settingsError && !isActive && (
                <div className="settings-warning">
                  <span aria-hidden="true">i</span>
                  <p>{settingsError}</p>
                </div>
              )}

              {isActive && (
                <div className="progress-panel" aria-busy="true">
                  <div className="progress-copy">
                    <strong>
                      <span className="processing-dots" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      {stageMessage}
                    </strong>
                    <span>{phase === "palette" ? "분석 중" : `${progress}%`}</span>
                  </div>
                  <progress
                    max="100"
                    value={phase === "palette" ? undefined : progress}
                    aria-label={
                      phase === "palette"
                        ? "GIF 색상 분석 중"
                        : `변환 진행률 ${progress}%`
                    }
                  />
                  <p>진행률은 영상과 브라우저 성능에 따른 예상치예요.</p>
                </div>
              )}

              {workflow === "single" && !isActive && (
                <button
                  className="batch-entry-button"
                  type="button"
                  onClick={enterBatchMode}
                  disabled={phase === "inspecting" || Boolean(settingsError)}
                >
                  <strong>여러 버전 한 번에 만들기</strong>
                  <span>추천 3종을 먼저 담고, 결과마다 설정을 바꿀 수 있어요.</span>
                  <i aria-hidden="true">＋</i>
                </button>
              )}

              <div className="action-row">
                {isActive ? (
                  <button
                    className="secondary-action danger-action"
                    type="button"
                    onClick={cancelConversion}
                  >
                    {workflow === "batch" ? "전체 변환 취소" : "변환 취소"}
                  </button>
                ) : (
                  <button
                    className="primary-action"
                    type="button"
                    onClick={() =>
                      void (workflow === "batch"
                        ? startBatchConversion()
                        : startConversion())
                    }
                    disabled={
                      phase === "inspecting" ||
                      (workflow === "single"
                        ? Boolean(settingsError)
                        : batchRunnableCount === 0 || batchInvalidCount > 0)
                    }
                  >
                    {workflow === "batch"
                      ? batchActionLabel
                      : phase === "complete"
                        ? "다시 변환하기"
                        : `${format.toUpperCase()}로 변환하기`}
                    <span aria-hidden="true">→</span>
                  </button>
                )}
                <button
                  className="secondary-action"
                  type="button"
                  onClick={resetAll}
                  disabled={isActive}
                >
                  처음부터
                </button>
              </div>
              <p className="engine-note">
                원본과 변환 작업은 이 탭 안에서만 처리됩니다. 완료된 결과만 이
                브라우저의 최근 결과에 보관해요.
              </p>
            </section>
          </div>
        )}

        {phase === "complete" && resultUrl && (
          <section className="result-panel" aria-labelledby="result-title">
            <div className="result-copy">
              <span className="success-mark" aria-hidden="true">
                ✓
              </span>
              <div>
                <p className="section-kicker">DONE</p>
                <h2 id="result-title" ref={resultHeadingRef} tabIndex={-1}>
                  {workflow === "batch"
                    ? `${batchCompletedCount}개 결과가 준비됐어요`
                    : "움직이는 이미지가 준비됐어요"}
                </h2>
                <p>
                  {resultName} · {formatBytes(resultSize ?? 0)}
                  {workflow === "batch" && batchFailedCount > 0
                    ? ` / ${batchFailedCount}개 실패`
                    : ""}
                </p>
              </div>
            </div>
            <div className="result-body">
              <div className="result-preview">
                {showResultPreview ? (
                  // An animated image has no reliable pause control, so reduced
                  // motion users opt in before this element is mounted.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={resultUrl}
                    alt={`변환된 ${resultFormat.toUpperCase()} 미리보기`}
                  />
                ) : (
                  <div className="motion-placeholder">
                    <p>
                      움직임 줄이기 설정에 따라 자동 미리보기를 숨겼어요.
                    </p>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setShowResultPreview(true)}
                    >
                      미리보기 열기
                    </button>
                  </div>
                )}
              </div>
              <div className="result-actions">
                {workflow === "batch" ? (
                  <>
                    <button
                      className="primary-action"
                      type="button"
                      onClick={openHistoryDialog}
                    >
                      완료 결과 모두 보기
                      <span aria-hidden="true">→</span>
                    </button>
                    <a
                      className="secondary-action download-action"
                      href={resultUrl}
                      download={resultName}
                    >
                      마지막 결과 내려받기
                      <span aria-hidden="true">↓</span>
                    </a>
                  </>
                ) : (
                  <>
                    <a
                      className="primary-action download-action"
                      href={resultUrl}
                      download={resultName}
                    >
                      파일 내려받기
                      <span aria-hidden="true">↓</span>
                    </a>
                    <button
                      className="secondary-action"
                      type="button"
                      onClick={openHistoryDialog}
                    >
                      최근 결과 모두 보기
                    </button>
                  </>
                )}
                <button
                  className="text-button"
                  type="button"
                  onClick={resetAll}
                >
                  새 영상 변환
                </button>
                {reducedMotion && showResultPreview && (
                  <>
                    <button
                      className="text-button hide-preview-button"
                      type="button"
                      onClick={() => setShowResultPreview(false)}
                    >
                      움직이는 미리보기 숨기기
                    </button>
                    <p className="motion-note">
                      파일 다운로드에는 영향을 주지 않아요.
                    </p>
                  </>
                )}
              </div>
            </div>
          </section>
        )}

        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          accept="video/*,.mkv,.avi,.m4v,.mov,.mpg,.mpeg"
          onChange={handleFileInput}
          aria-label="변환할 동영상 파일 선택"
          disabled={isActive}
          tabIndex={-1}
        />
      </section>

      <Dialog
        isOpen={historyOpen}
        onOpenChange={(isOpen) => {
          if (isOpen) openHistoryDialog();
          else closeHistoryDialog();
        }}
        width={760}
        maxHeight="min(86vh, 820px)"
        purpose="info"
      >
        <Layout
          header={
            <DialogHeader
              title={`최근 결과 ${historyItems.length}개`}
              onOpenChange={(isOpen) => {
                if (isOpen) openHistoryDialog();
                else closeHistoryDialog();
              }}
            />
          }
          content={
            <LayoutContent padding={0}>
              <section
                className="history-view"
                aria-label="이 브라우저에 보관된 변환 결과"
              >
                <div
                  className="history-intro"
                  id="history-view-summary"
                  tabIndex={-1}
                >
                  <p>
                    결과 파일만 이 브라우저에 보관해요. 원본 영상은 저장하거나
                    서버로 보내지 않습니다.
                  </p>
                  <strong>
                    {historyItems.length}개 / {formatBytes(historyTotalBytes)}
                  </strong>
                </div>

                {historyNotice && (
                  <div className="history-notice">
                    <span aria-hidden="true">i</span>
                    <p>{historyNotice}</p>
                  </div>
                )}

                {historyLoading ? (
                  <div
                    className="history-empty"
                    id="history-loading"
                    tabIndex={-1}
                    aria-busy="true"
                  >
                    <span className="inspection-spinner" aria-hidden="true" />
                    <strong>최근 결과를 불러오고 있어요</strong>
                  </div>
                ) : historyItems.length === 0 ? (
                  <div className="history-empty" id="history-empty" tabIndex={-1}>
                    <span className="history-empty-mark" aria-hidden="true">
                      ◫
                    </span>
                    <strong>아직 보관한 결과가 없어요</strong>
                    <p>변환이 끝나면 이 브라우저에서 다시 확인할 수 있어요.</p>
                    <Button
                      label="첫 결과 만들기"
                      variant="secondary"
                      size="sm"
                      onClick={closeHistoryDialog}
                    />
                  </div>
                ) : (
                  <>
                    <ol className="history-list">
                      {visibleHistoryItems.map((entry) => (
                        <li
                          className="history-item"
                          id={`history-item-${entry.id}`}
                          key={entry.id}
                          tabIndex={-1}
                        >
                          <div className="history-format-tile" aria-hidden="true">
                            {entry.output.format === "gif" ? "GIF" : "PNG"}
                          </div>
                          <div className="history-item-copy">
                            <strong title={entry.output.name}>
                              {entry.output.name}
                            </strong>
                            <span>
                              {formatHistoryDate(entry.createdAt)} /{" "}
                              {formatBytes(entry.output.sizeBytes)}
                            </span>
                            <small>
                              {entry.batch?.label
                                ? `${entry.batch.label} / `
                                : ""}
                              {Number(entry.settings.duration.toFixed(1))}초 /{" "}
                              {formatFrameRate(entry.settings.fps)} FPS /{" "}
                              {entry.settings.width}px
                            </small>
                            {entry.persistence !== "saved" && (
                              <em className="history-session-state">
                                {entry.persistence === "quota-full"
                                  ? "저장공간 부족, 이번 탭만"
                                  : "이번 탭에서만 보관"}
                              </em>
                            )}
                          </div>
                          <div className="history-item-actions">
                            <Button
                              id={`history-preview-${entry.id}`}
                              label={`${entry.output.name} 미리보기`}
                              variant="ghost"
                              size="sm"
                              isLoading={historyPreviewLoadingId === entry.id}
                              onClick={() => void previewHistoryResult(entry)}
                            >
                              미리보기
                            </Button>
                            <Button
                              label={`${entry.output.name} 내려받기`}
                              variant="secondary"
                              size="sm"
                              onClick={() => void downloadHistoryResult(entry)}
                            >
                              내려받기
                            </Button>
                            {pendingHistoryDelete === entry.id ? (
                              <span className="history-delete-confirm">
                                <Button
                                  label={`${entry.output.name} 삭제 확인`}
                                  variant="destructive"
                                  size="sm"
                                  onClick={() =>
                                    void confirmDeleteHistoryResult(entry)
                                  }
                                >
                                  정말 삭제
                                </Button>
                                <Button
                                  label="삭제 취소"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setPendingHistoryDelete(null)}
                                >
                                  취소
                                </Button>
                              </span>
                            ) : (
                              <Button
                                label={`${entry.output.name} 삭제`}
                                variant="ghost"
                                size="sm"
                                onClick={() => setPendingHistoryDelete(entry.id)}
                              >
                                삭제
                              </Button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ol>
                    {historyVisibleCount < historyItems.length && (
                      <div className="history-more">
                        <Button
                          label="최근 결과 더 보기"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setHistoryVisibleCount((count) => count + 8)
                          }
                        />
                      </div>
                    )}
                  </>
                )}
              </section>
            </LayoutContent>
          }
          footer={
            historyItems.length > 0 ? (
              <LayoutFooter>
                <div className="history-footer">
                  {confirmClearHistory ? (
                    <>
                      <p>
                        {historyItems.length}개를 이 브라우저에서 지울까요?
                        내려받은 파일에는 영향이 없어요.
                      </p>
                      <Button
                        label={`${historyItems.length}개 모두 삭제`}
                        variant="destructive"
                        size="sm"
                        isDisabled={isActive}
                        onClick={() => void confirmClearAllHistory()}
                      />
                      <Button
                        label="전체 삭제 취소"
                        variant="secondary"
                        size="sm"
                        onClick={() => setConfirmClearHistory(false)}
                      >
                        취소
                      </Button>
                    </>
                  ) : (
                    <Button
                      label="최근 결과 모두 삭제"
                      variant="ghost"
                      size="sm"
                      isDisabled={isActive}
                      onClick={() => setConfirmClearHistory(true)}
                    />
                  )}
                </div>
              </LayoutFooter>
            ) : undefined
          }
        />
      </Dialog>

      {historyPreviewUrl && historyPreviewEntry && (
        <Lightbox
          isOpen={historyPreviewOpen}
          onOpenChange={(isOpen) => {
            if (!isOpen) closeHistoryPreview();
          }}
          media={{
            src: historyPreviewUrl,
            alt: `${historyPreviewEntry.output.name} 미리보기`,
            caption: `${historyPreviewEntry.output.name} / ${formatBytes(
              historyPreviewEntry.output.sizeBytes,
            )}`,
          }}
        />
      )}

      <aside className="astryx-privacy-banner" aria-label="개인정보 안내">
        <Banner
          status="info"
          title="내 영상은 내 기기에만"
          description="원본 영상은 서버로 전송하거나 저장하지 않습니다. 완료된 결과만 최근 결과를 위해 이 브라우저에 보관하며, 언제든 직접 지울 수 있어요."
          container="card"
        />
      </aside>

      <footer>
        <span>핌쥐 - 로컬 브라우저 변환기</span>
        <span>
            Powered by{" "}
            <a
              href={FFMPEG_CORE_NOTICE.projectUrl}
            target="_blank"
            rel="noreferrer"
            >
              ffmpeg.wasm wrapper {FFMPEG_CORE_NOTICE.wrapperVersion}
            </a>{" "}
            ·{" "}
            <a
              href={FFMPEG_CORE_NOTICE.wrapperLicenseUrl}
              target="_blank"
              rel="noreferrer"
            >
              MIT
            </a>{" "}
            ·{" "}
            <a
              href={FFMPEG_CORE_NOTICE.coreLicenseUrl}
              target="_blank"
              rel="noreferrer"
            >
              FFmpeg core {FFMPEG_CORE_NOTICE.coreVersion} · GPL-2.0-or-later
            </a>{" "}
            ·{" "}
            <a
              href={FFMPEG_CORE_NOTICE.faqUrl}
              target="_blank"
              rel="noreferrer"
            >
              라이선스 안내
            </a>
        </span>
      </footer>
    </main>
  );
}
