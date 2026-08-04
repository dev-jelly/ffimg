import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: {
        accept: "text/html",
        host: "localhost",
        "x-forwarded-proto": "http",
      },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the finished Korean converter", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html[^>]*\blang="ko"/i);
  assert.match(html, /<title>핌쥐 - 브라우저 동영상 APNG·GIF 변환기<\/title>/);
  assert.match(html, /핌쥐 변환기로 이동/);
  assert.match(html, /브라우저에서만/);
  assert.match(html, /동영상을 가볍게, 움직이는 이미지로/);
  assert.match(html, /파일은 업로드되지 않아요/);
  assert.match(html, /동영상을 여기에 놓아주세요/);
  assert.match(html, /type="file"/);
  assert.match(html, /aria-label="변환할 동영상 파일 선택"/);
  assert.match(html, /role="status"/);
  assert.match(html, /ffmpeg\.wasm/);
  assert.match(
    html,
    /<meta(?=[^>]*\bproperty="og:image")(?=[^>]*\bcontent="http:\/\/localhost\/og\.png")[^>]*>/i,
  );
  assert.match(
    html,
    /<link(?=[^>]*\brel="canonical")(?=[^>]*\bhref="https:\/\/dev-jelly\.github\.io\/ffimg\/")[^>]*>/i,
  );
  assert.match(
    html,
    /<meta(?=[^>]*\bproperty="og:url")(?=[^>]*\bcontent="https:\/\/dev-jelly\.github\.io\/ffimg\/")[^>]*>/i,
  );
  assert.match(
    html,
    /<meta(?=[^>]*\bname="robots")(?=[^>]*\bcontent="[^"]*noindex[^"]*nofollow[^"]*")[^>]*>/i,
  );
  assert.match(html, /name="twitter:card" content="summary_large_image"/i);
  assert.match(html, /name="twitter:image:alt" content="핌쥐 - 동영상을 움직이는 이미지로 바꾸는 브라우저 변환기"/i);
  assert.match(html, /property="og:image:type" content="image\/png"/i);
  assert.match(html, /property="og:image:width" content="1200"/i);
  assert.match(html, /property="og:image:height" content="630"/i);
  assert.match(
    html,
    /<link(?=[^>]*\brel="icon")(?=[^>]*\bhref="http:\/\/localhost\/pimg-mark\.png")[^>]*>/i,
  );
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Codex is working/);
});

test("source includes both formats, all modes, and conversion recovery actions", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /움직이는 PNG/);
  assert.match(page, /<strong>GIF<\/strong>/);
  assert.match(page, /name: "Beginner"/);
  assert.match(page, /name: "Intermediate"/);
  assert.match(page, /name: "Advanced"/);
  assert.match(page, /name: "자동 추천"/);
  assert.match(page, /name: "용량 작게"/);
  assert.match(page, /name: "균형 있게"/);
  assert.match(page, /name: "더 선명하게"/);
  assert.match(page, /name: "원본 가깝게"/);
  assert.match(page, /어떤 결과가 좋으세요/);
  assert.match(page, /formatPresetEstimate/);
  assert.match(page, /max="1920"/);
  assert.match(page, /aria-labelledby=\{nameId\}/);
  assert.match(page, /aria-describedby=\{describedBy\}/);
  assert.match(page, /canConvert === false/);
  assert.match(page, /변환 길이를 줄이거나 더 선명하게를 선택해 주세요/);
  assert.match(page, /resolveAdaptivePreset/);
  assert.match(page, /이 영상에 맞춰 조정했어요/);
  assert.match(page, /추천값으로 다시 설정/);
  assert.match(page, /추천값 적용됨/);
  assert.match(page, /원본 FPS/);
  assert.match(page, /출력 FPS/);
  assert.match(page, /requestVideoFrameCallback/);
  assert.match(page, /presentedFrames/);
  assert.match(page, /mediaTime/);
  assert.match(page, /원본보다 높지 않은 표준 옵션/);
  assert.match(page, /프리셋 추천 \(자동 계산\)/);
  assert.match(page, /max="60"/);
  assert.match(page, /step="0\.001"/);
  assert.match(page, /23\.976, 29\.97, 59\.94/);
  assert.match(page, /fpsTarget: selectedFpsTarget/);
  assert.match(page, /변환 부담이 큰 편이에요/);
  assert.match(page, /이 준비됐어요/);
  assert.match(page, /변환 취소/);
  assert.match(page, /파일 내려받기/);
  assert.match(page, /처음부터/);
  assert.match(page, /role="alert"/);
});

test("source progressively discloses Korean output-size predictions", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /estimateOutputSize/);
  assert.match(page, /예상 결과 용량/);
  assert.match(page, /계산 중/);
  assert.match(page, /설정을 확인해 주세요/);
  assert.match(page, /\) : settingsError \? \(/);
  assert.match(page, /예상 용량을 계산할 수 없어요/);
  assert.match(page, /실제 용량은 영상의 움직임과 색 변화에 따라 달라질 수 있어요/);
  assert.match(page, /용량이 큰 편이에요/);
  assert.match(page, /파일이 매우 커질 수 있어요/);
  assert.match(page, /길이, FPS 또는 최대 너비를 낮추면/);
  assert.match(
    page,
    /mode !== "Beginner"[\s\S]*className="prediction-metrics"/,
  );
  assert.match(
    page,
    /mode === "Advanced"[\s\S]*className="prediction-assumptions"/,
  );
  assert.match(page, /OUTPUT_SIZE_MODEL_VERSION/);
  assert.match(page, /window\.setTimeout\([\s\S]*500/);
  assert.match(page, /announcedPrediction/);
  assert.equal(page.match(/role="status"/g)?.length, 1);
  assert.match(page, /role="status" aria-live="polite" aria-atomic="true"/);
});

test("starter preview and starter assets are removed", async () => {
  const [packageJson, layout, css] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(packageJson, /react-loading-skeleton|site-creator-vinext-starter/);
  assert.match(packageJson, /"@ffmpeg\/ffmpeg": "0\.12\.15"/);
  assert.doesNotMatch(layout, /Starter Project|codex-preview|next\/font/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);

  await Promise.all(
    [
      "app/_sites-preview",
      "public/file.svg",
      "public/globe.svg",
      "public/window.svg",
    ].map((path) =>
      assert.rejects(access(new URL(path, projectRoot)), { code: "ENOENT" }),
    ),
  );
  await access(new URL("public/og.png", projectRoot));
  await access(new URL("public/pimg-logo.png", projectRoot));
  await access(new URL("public/pimg-mark.png", projectRoot));
  await access(new URL("public/apple-touch-icon.png", projectRoot));
  await access(new URL("public/favicon.ico", projectRoot));
});
