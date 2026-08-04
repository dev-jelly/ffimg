import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const outputRoot = path.join(projectRoot, "out");
const pagesBasePath = "/ffimg";
const pagesUrl = "https://dev-jelly.github.io/ffimg/";

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(entryPath) : entryPath;
    }),
  );
  return files.flat();
}

test("Pages export contains the converter and canonical metadata", async () => {
  const indexPath = path.join(outputRoot, "index.html");
  await Promise.all([
    access(indexPath),
    access(path.join(outputRoot, "og.png")),
    access(path.join(outputRoot, "pimg-mark.png")),
    access(path.join(outputRoot, "apple-touch-icon.png")),
    access(path.join(outputRoot, "favicon.ico")),
  ]);

  const html = await readFile(indexPath, "utf8");
  assert.match(html, /<html[^>]*\blang="ko"/i);
  assert.match(html, /<html[^>]*\bdata-base-path="\/ffimg"/i);
  assert.match(html, /동영상을 가볍게, 움직이는 이미지로/);
  assert.match(
    html,
    new RegExp(
      `<link(?=[^>]*\\brel="canonical")(?=[^>]*\\bhref="${pagesUrl}")[^>]*>`,
      "i",
    ),
  );
  assert.match(
    html,
    new RegExp(
      `<meta(?=[^>]*\\bproperty="og:url")(?=[^>]*\\bcontent="${pagesUrl}")[^>]*>`,
      "i",
    ),
  );

  for (const property of ["og:image", "twitter:image"]) {
    assert.match(
      html,
      new RegExp(
        `<meta(?=[^>]*\\b(?:property|name)="${property}")(?=[^>]*\\bcontent="${pagesUrl}og\\.png")[^>]*>`,
        "i",
      ),
    );
  }
  assert.match(
    html,
    /<link(?=[^>]*\brel="icon")(?=[^>]*\bhref="\/ffimg\/pimg-mark\.png")[^>]*>/i,
  );
});

test("HTML assets stay under the repository base path and exist", async () => {
  const htmlFiles = (await listFiles(outputRoot)).filter(
    (file) => path.extname(file) === ".html",
  );
  assert.ok(htmlFiles.length > 0, "expected exported HTML");

  for (const htmlFile of htmlFiles) {
    const html = await readFile(htmlFile, "utf8");
    const references = Array.from(
      html.matchAll(/\b(?:href|src)="([^"]+)"/gi),
      (match) => match[1],
    );
    const localReferences = references.filter((reference) =>
      reference.startsWith("/"),
    );

    assert.ok(localReferences.length > 0, `expected assets in ${htmlFile}`);
    for (const reference of localReferences) {
      assert.ok(
        reference.startsWith(`${pagesBasePath}/`),
        `asset escaped ${pagesBasePath}: ${reference}`,
      );

      const pathname = decodeURIComponent(
        new URL(reference, "https://pages.test").pathname,
      );
      const relativePath = pathname.slice(`${pagesBasePath}/`.length);
      const artifactPath =
        !relativePath || relativePath.endsWith("/")
          ? path.join(outputRoot, relativePath, "index.html")
          : path.join(outputRoot, relativePath);
      await access(artifactPath);
    }

    assert.doesNotMatch(html, /(?:href|src)="\/_next\//i);
    assert.doesNotMatch(html, /\/_vinext\/image|\/api\//i);
  }
});

test("the unbundled FFmpeg worker is preserved and selected at runtime", async () => {
  for (const name of ["worker.js", "const.js", "errors.js"]) {
    const exportedWorkerFile = await readFile(
      path.join(outputRoot, "ffmpeg", name),
      "utf8",
    );
    const packageWorkerFile = await readFile(
      path.join(
        projectRoot,
        "node_modules",
        "@ffmpeg",
        "ffmpeg",
        "dist",
        "esm",
        name,
      ),
      "utf8",
    );
    assert.equal(
      exportedWorkerFile,
      packageWorkerFile,
      `${name} drifted from @ffmpeg/ffmpeg`,
    );
  }

  const workerSource = await readFile(
    path.join(outputRoot, "ffmpeg", "worker.js"),
    "utf8",
  );
  assert.match(workerSource, /await import\([\s\S]*_coreURL\)/);
  assert.doesNotMatch(workerSource, /webpackEmptyAsyncContext|Cannot find module/);

  const files = await listFiles(outputRoot);
  const javascriptFiles = files.filter((file) => path.extname(file) === ".js");
  const bundles = await Promise.all(
    javascriptFiles.map(async (file) => ({
      file,
      source: await readFile(file, "utf8"),
    })),
  );
  const javascript = bundles.map(({ source }) => source).join("\n");
  const applicationBundles = bundles.filter(({ file }) =>
    file.includes(`${path.sep}chunks${path.sep}app${path.sep}page-`),
  );

  assert.equal(applicationBundles.length, 1, "expected one application bundle");
  assert.ok(
    applicationBundles[0].source.includes("ffmpeg/worker.js"),
    "application does not select the unbundled FFmpeg worker",
  );
  assert.ok(
    applicationBundles[0].source.includes("classWorkerURL"),
    "application does not pass the custom worker URL",
  );
  assert.ok(
    applicationBundles[0].source.includes("예상 결과 용량"),
    "application bundle does not contain the prediction UI",
  );
  assert.ok(
    applicationBundles[0].source.includes("영상의 움직임과 색 변화"),
    "application bundle does not contain uncertainty guidance",
  );
  assert.ok(
    applicationBundles[0].source.includes("ffimg-size-v2"),
    "application bundle does not contain the estimator model version",
  );
  assert.ok(
    applicationBundles[0].source.includes("ffimg-adaptive-v2"),
    "application bundle does not contain the adaptive preset policy",
  );
  assert.ok(
    javascript.includes(`${pagesBasePath}/_next/`),
    "webpack public path does not include the repository base path",
  );
  assert.doesNotMatch(javascript, /\/_vinext\/image/i);
  assert.doesNotMatch(applicationBundles[0].source, /["']\/api(?:\/|["'])/i);
});
