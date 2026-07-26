"use client";

import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  buildApngCommand,
  buildGifCommands,
  normalizeSettings,
  outputFileFor,
  safeDownloadName,
  VIRTUAL_FILES,
} from "@/lib/ffmpeg-commands.mjs";
import {
  FFMPEG_CORE_NOTICE,
  loadBrowserFfmpeg,
  mountLocalFile,
  setFfmpegProgressListener,
  type BrowserFfmpeg,
  unmountLocalFile,
} from "@/lib/ffmpeg-runtime";
import {
  estimateOutputSize,
  OUTPUT_SIZE_MODEL_VERSION,
} from "@/lib/output-size-estimator.mjs";

type Format = "apng" | "gif";
type Mode = "Beginner" | "Intermediate" | "Advanced";
type Preset = "light" | "balanced" | "crisp";
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
  previewAvailable: boolean;
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
  { id: "light", name: "가볍게", description: "8 FPS · 최대 360px" },
  { id: "balanced", name: "균형", description: "12 FPS · 최대 480px" },
  { id: "crisp", name: "선명하게", description: "15 FPS · 최대 720px" },
];

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

function formatDuration(duration: number | null) {
  if (!duration || !Number.isFinite(duration)) return "확인 불가";
  const minutes = Math.floor(duration / 60);
  const seconds = Math.floor(duration % 60);
  return minutes ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b ? greatestCommonDivisor(b, a % b) : a;
}

function formatAspect(width: number | null, height: number | null) {
  if (!width || !height) return "확인 불가";
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function fileExtension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function inspectVideo(url: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const finish = () => {
      video.removeAttribute("src");
      video.load();
    };

    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => {
      const metadata = {
        duration: Number.isFinite(video.duration) ? video.duration : null,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
        previewAvailable: true,
      };
      finish();
      resolve(metadata);
    };
    video.onerror = () => {
      finish();
      reject(new Error("Browser preview unavailable"));
    };
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
  const [preset, setPreset] = useState<Preset>("balanced");
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const sourceUrlRef = useRef<string | null>(null);
  const resultUrlRef = useRef<string | null>(null);
  const engineRef = useRef<BrowserFfmpeg | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const operationRef = useRef(0);
  const reducedMotionRef = useRef(false);
  const completedSettingsRef = useRef<string | null>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);

  const isActive = ACTIVE_PHASES.has(phase);
  const normalized = normalizeSettings(
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
  );
  const settingsFingerprint = [
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
  ].join("|");
  const sourceDuration = metadata?.duration ?? null;
  const sizeEstimate = estimateOutputSize({
    settings: normalized,
    media: {
      durationSeconds: metadata?.duration,
      width: metadata?.width,
      height: metadata?.height,
      sizeBytes: file?.size,
    },
  });
  const settingsError = (() => {
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
      if (!Number.isInteger(fps) || fps < 1 || fps > 30) {
        return "프레임은 1-30 FPS 사이의 정수로 입력해 주세요.";
      }
      if (!Number.isInteger(width) || width < 160 || width > 1280) {
        return "최대 너비는 160-1280px 사이의 정수로 입력해 주세요.";
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

  useEffect(
    () => () => {
      operationRef.current += 1;
      abortRef.current?.abort();
      engineRef.current?.dispose();
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    },
    [],
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
      phase === "complete" &&
      completedSettingsRef.current !== null &&
      completedSettingsRef.current !== settingsFingerprint
    ) {
      clearResult();
      setProgress(0);
      setPhase("ready");
      setStageMessage("설정이 바뀌었어요. 새 설정으로 다시 변환해 주세요.");
    }
  }, [clearResult, phase, settingsFingerprint]);

  useEffect(() => {
    if (phase !== "complete") return;
    const heading = resultHeadingRef.current;
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({
      behavior: reducedMotionRef.current ? "auto" : "smooth",
      block: "nearest",
    });
  }, [phase]);

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
    engineRef.current?.dispose();
    engineRef.current = null;
    abortRef.current = null;
    clearResult();
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);

    const nextUrl = URL.createObjectURL(nextFile);
    sourceUrlRef.current = nextUrl;
    setSourceUrl(nextUrl);
    setFile(nextFile);
    setMetadata(null);
    setInspectionWarning(largeFileWarning);
    setError(null);
    setProgress(0);
    setPhase("inspecting");
    setStageMessage("동영상 정보를 확인하는 중이에요.");

    try {
      const nextMetadata = await inspectVideo(nextUrl);
      if (operationRef.current !== operation) return;
      setMetadata(nextMetadata);
      setDuration(Math.min(6, nextMetadata.duration ?? 6));
    } catch {
      if (operationRef.current !== operation) return;
      setMetadata({
        duration: null,
        width: null,
        height: null,
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
    engineRef.current?.dispose();
    engineRef.current = null;
    setPhase("cancelled");
    setStageMessage("변환을 취소했어요. 설정을 바꾸고 다시 시작할 수 있어요.");
  }

  function resetAll() {
    operationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    engineRef.current?.dispose();
    engineRef.current = null;
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
    setPreset("balanced");
    setStart(0);
    setDuration(6);
    setFps(12);
    setWidth(480);
    setPlays(0);
    setGifColors(128);
    setGifStats("diff");
    setGifDither("sierra2_4a");
    setApngCompression(6);
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

    let engine: BrowserFfmpeg | null = null;
    let removeProgressListener: (() => void) | null = null;

    const ensureCurrent = () => {
      if (
        operationRef.current !== operation ||
        controller.signal.aborted
      ) {
        throw new DOMException("Aborted", "AbortError");
      }
    };

    try {
      engine = await loadBrowserFfmpeg({
        signal: controller.signal,
        onProgress: ({ ratio, label }) => {
          if (operationRef.current !== operation) return;
          setProgress(Math.round(1 + ratio * 14));
          setStageMessage(`${label} · 처음 한 번만 오래 걸릴 수 있어요.`);
        },
      });
      ensureCurrent();
      engineRef.current = engine;

      setPhase("preparing");
      setProgress(15);
      setStageMessage("동영상 파일을 안전하게 연결하는 중이에요.");
      await mountLocalFile(
        engine.ffmpeg,
        file,
        VIRTUAL_FILES.input,
        controller.signal,
      );
      ensureCurrent();
      setProgress(20);

      if (format === "gif") {
        const commands = buildGifCommands(normalized, metadata?.duration);
        setPhase("palette");
        setStageMessage("GIF 색상표를 만들고 있어요.");
        removeProgressListener = setFfmpegProgressListener(
          engine.ffmpeg,
          ({ progress: ratio }) => {
            if (operationRef.current === operation) {
              setProgress(
                Math.round(20 + Math.min(1, Math.max(0, ratio)) * 25),
              );
            }
          },
        );
        const paletteExit = await engine.ffmpeg.exec(
          commands.palette,
          -1,
          { signal: controller.signal },
        );
        if (paletteExit !== 0) throw new Error("GIF palette command failed");
        ensureCurrent();
        removeProgressListener();
        removeProgressListener = null;

        setPhase("encoding");
        setProgress(45);
        setStageMessage("GIF 프레임을 조합하고 있어요.");
        removeProgressListener = setFfmpegProgressListener(
          engine.ffmpeg,
          ({ progress: fallbackRatio, time }) => {
            if (operationRef.current === operation) {
              const ratio = normalized.duration
                ? time / (normalized.duration * 1_000_000)
                : fallbackRatio;
              setProgress(
                Math.round(45 + Math.min(1, Math.max(0, ratio)) * 50),
              );
            }
          },
        );
        const encodeExit = await engine.ffmpeg.exec(commands.encode, -1, {
          signal: controller.signal,
        });
        if (encodeExit !== 0) throw new Error("GIF encode command failed");
      } else {
        setPhase("encoding");
        setStageMessage("APNG 프레임을 인코딩하고 있어요.");
        removeProgressListener = setFfmpegProgressListener(
          engine.ffmpeg,
          ({ progress: fallbackRatio, time }) => {
            if (operationRef.current === operation) {
              const ratio = normalized.duration
                ? time / (normalized.duration * 1_000_000)
                : fallbackRatio;
              setProgress(
                Math.round(20 + Math.min(1, Math.max(0, ratio)) * 75),
              );
            }
          },
        );
        const exitCode = await engine.ffmpeg.exec(
          buildApngCommand(normalized, metadata?.duration),
          -1,
          { signal: controller.signal },
        );
        if (exitCode !== 0) throw new Error("APNG encode command failed");
      }

      ensureCurrent();
      removeProgressListener?.();
      removeProgressListener = null;
      setPhase("finalizing");
      setProgress(95);
      setStageMessage("결과 파일을 마무리하고 있어요.");

      const output = outputFileFor(format);
      const data = await engine.ffmpeg.readFile(output.virtualName, "binary", {
        signal: controller.signal,
      });
      ensureCurrent();
      if (typeof data === "string") throw new Error("Unexpected text output");
      const outputBuffer = data.buffer;
      if (!(outputBuffer instanceof ArrayBuffer)) {
        throw new Error("Unexpected shared output buffer");
      }
      const exactOutputBuffer =
        data.byteOffset === 0 && data.byteLength === outputBuffer.byteLength
          ? outputBuffer
          : outputBuffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const blob = new Blob([exactOutputBuffer], { type: output.mimeType });
      const nextResultUrl = URL.createObjectURL(blob);
      const nextResultName = safeDownloadName(file.name, format);

      completedSettingsRef.current = settingsFingerprint;
      resultUrlRef.current = nextResultUrl;
      setResultUrl(nextResultUrl);
      setResultSize(blob.size);
      setResultName(nextResultName);
      setShowResultPreview(!reducedMotionRef.current);
      setProgress(100);
      setPhase("complete");
      setStageMessage("변환이 끝났어요. 결과를 확인하고 내려받아 주세요.");
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
      removeProgressListener?.();
      if (engine) {
        await unmountLocalFile(engine.ffmpeg, VIRTUAL_FILES.input);
        if (format === "gif") {
          try {
            await engine.ffmpeg.deleteFile(VIRTUAL_FILES.palette);
          } catch {}
        }
        engine.dispose();
      }
      if (engineRef.current === engine) engineRef.current = null;
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  const outputSummary =
    format === "gif"
      ? `${Number(normalized.duration.toFixed(1))}초, ${normalized.fps} FPS, ${normalized.width}px, ${normalized.gifColors}색`
      : `${Number(normalized.duration.toFixed(1))}초, ${normalized.fps} FPS, ${normalized.width}px, 압축 ${normalized.apngCompression}`;
  const predictionRangeText =
    sizeEstimate.status === "available" && !settingsError
      ? formatEstimatedRange(
          sizeEstimate.rangeBytes.lower,
          sizeEstimate.rangeBytes.upper,
        )
      : null;
  const predictionLiveText =
    phase === "inspecting"
      ? "동영상 정보를 확인하고 예상 용량을 계산하는 중이에요."
      : settingsError
        ? "설정을 확인하면 예상 용량을 다시 계산할게요."
      : predictionRangeText
        ? `예상 출력 용량은 ${predictionRangeText}예요.`
        : metadata
          ? "영상 길이 또는 해상도를 확인할 수 없어 예상 용량을 계산할 수 없어요."
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
        ([stageMessage, announcedPrediction, inspectionWarning]
          .filter(Boolean)
          .join(" ") ||
          stageMessage);

  return (
    <main className="site-shell">
      <header className="site-header">
        <a className="brand" href="#converter" aria-label="움짤공방 변환기로 이동">
          <span className="brand-mark" aria-hidden="true">
            F
          </span>
          <span>움짤공방</span>
        </a>
        <span className="local-badge">
          <span aria-hidden="true">●</span>
          Browser only
        </span>
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
                  <dt>화면 비율</dt>
                  <dd>
                    {formatAspect(
                      metadata?.width ?? null,
                      metadata?.height ?? null,
                    )}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="settings-panel" aria-labelledby="settings-title">
              <div className="panel-heading settings-heading">
                <div>
                  <p className="section-kicker">OUTPUT</p>
                  <h2 id="settings-title">어떻게 만들까요?</h2>
                </div>
                <span className="summary-chip">{outputSummary}</span>
              </div>

              <fieldset className="format-fieldset" disabled={isActive}>
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

              <fieldset className="mode-fieldset" disabled={isActive}>
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
                        onChange={() => setMode(option.name)}
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
                    <strong>알아서 균형 있게 만들게요</strong>
                    <p>처음부터 최대 6초를 균형 설정으로 변환해요.</p>
                  </div>
                  <dl>
                    <div>
                      <dt>속도</dt>
                      <dd>12 FPS</dd>
                    </div>
                    <div>
                      <dt>크기</dt>
                      <dd>최대 480px</dd>
                    </div>
                    <div>
                      <dt>반복</dt>
                      <dd>계속</dd>
                    </div>
                  </dl>
                </div>
              )}

              {mode === "Intermediate" && (
                <div className="disclosed-controls">
                  <fieldset className="preset-fieldset" disabled={isActive}>
                    <legend>품질 프리셋</legend>
                    <div className="preset-options">
                      {PRESET_COPY.map((option) => (
                        <label
                          key={option.id}
                          className={preset === option.id ? "is-selected" : ""}
                        >
                          <input
                            type="radio"
                            name="preset"
                            value={option.id}
                            checked={preset === option.id}
                            onChange={() => setPreset(option.id)}
                          />
                          <strong>{option.name}</strong>
                          <small>{option.description}</small>
                        </label>
                      ))}
                    </div>
                  </fieldset>
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
                        disabled={isActive}
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
                        disabled={isActive}
                      />
                    </label>
                  </div>
                </div>
              )}

              {mode === "Advanced" && (
                <div className="disclosed-controls advanced-controls">
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
                        onChange={(event) => setStart(Number(event.target.value))}
                        disabled={isActive}
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
                          setDuration(Number(event.target.value))
                        }
                        disabled={isActive}
                      />
                    </label>
                    <label>
                      <span>반복 <small>총 재생</small></span>
                      <select
                        value={plays}
                        onChange={(event) => setPlays(Number(event.target.value))}
                        disabled={isActive}
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
                      <span>프레임 <small>FPS</small></span>
                      <input
                        type="number"
                        min="1"
                        max="30"
                        value={fps}
                        onChange={(event) => setFps(Number(event.target.value))}
                        disabled={isActive}
                      />
                    </label>
                    <label>
                      <span>최대 너비 <small>px</small></span>
                      <input
                        type="number"
                        min="160"
                        max="1280"
                        step="10"
                        value={width}
                        onChange={(event) => setWidth(Number(event.target.value))}
                        disabled={isActive}
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
                            setApngCompression(Number(event.target.value))
                          }
                          disabled={isActive}
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
                            setGifColors(Number(event.target.value))
                          }
                          disabled={isActive}
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
                          onChange={(event) => setGifStats(event.target.value)}
                          disabled={isActive}
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
                          onChange={(event) => setGifDither(event.target.value)}
                          disabled={isActive}
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
              </section>

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

              <div className="action-row">
                {isActive ? (
                  <button
                    className="secondary-action danger-action"
                    type="button"
                    onClick={cancelConversion}
                  >
                    변환 취소
                  </button>
                ) : (
                  <button
                    className="primary-action"
                    type="button"
                    onClick={() => void startConversion()}
                    disabled={phase === "inspecting" || Boolean(settingsError)}
                  >
                    {phase === "complete" ? "다시 변환하기" : `${format.toUpperCase()}로 변환하기`}
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
                처음 변환할 때 변환 엔진을 내려받습니다. 이후 원본과 변환 작업은
                이 탭 안에 머물러요.
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
                  움직이는 이미지가 준비됐어요
                </h2>
                <p>
                  {resultName} · {formatBytes(resultSize ?? 0)}
                </p>
              </div>
            </div>
            <div className="result-body">
              <div className="result-preview">
                {showResultPreview ? (
                  // An animated image has no reliable pause control, so reduced
                  // motion users opt in before this element is mounted.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={resultUrl} alt={`변환된 ${format.toUpperCase()} 미리보기`} />
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

      <aside className="privacy-note" aria-label="개인정보 안내">
        <span className="privacy-icon" aria-hidden="true">
          ◉
        </span>
        <div>
          <strong>내 영상은 내 기기에만</strong>
          <p>
            영상 파일은 서버로 전송하거나 저장하지 않습니다. 탭을 닫으면 변환
            결과도 브라우저 메모리에서 사라져요.
          </p>
        </div>
      </aside>

      <footer>
        <span>움짤공방 · 로컬 브라우저 변환기</span>
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
