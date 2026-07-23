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
  assert.match(html, /<title>움짤공방 — 브라우저 동영상 APNG·GIF 변환기<\/title>/);
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
    /<link(?=[^>]*\brel="icon")(?=[^>]*\bhref="http:\/\/localhost\/favicon\.ico")[^>]*>/i,
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
  await access(new URL("public/favicon.svg", projectRoot));
  await access(new URL("public/favicon.ico", projectRoot));
});
