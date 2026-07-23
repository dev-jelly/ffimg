# 움짤공방

브라우저에서 로컬 동영상을 APNG 또는 GIF로 변환하는 단일 페이지
애플리케이션입니다. 원본 바이트와 FFmpeg 작업은 사용자 브라우저 안에만
머물며, 업로드·계정·영구 저장소·분석 도구를 사용하지 않습니다.

공개 버전은 <https://dev-jelly.github.io/ffimg/>에서 사용할 수 있습니다.

## 실행

Node.js 22.13 이상이 필요합니다.

```bash
npm install
npm run dev
```

검증은 다음 명령으로 실행합니다.

```bash
npm run lint
npm test
npm run test:pages
```

`npm run build:pages`는 GitHub Pages의 `/ffimg` 하위 경로에 맞춘 완전한
정적 사이트를 `out/`에 만듭니다. 기존 `npm run build`의
vinext/Vite/Sites 출력은 그대로 유지됩니다.

`main` 브랜치에 푸시하면 GitHub Actions가 두 빌드의 검사와 Pages 정적
내보내기를 실행하고 `out/`만 배포합니다. 저장소의 Pages 소스는
**GitHub Actions**로 설정해야 합니다.

## 변환 구조

- `@ffmpeg/ffmpeg` 브라우저 래퍼를 애플리케이션 번들에 포함하고, 동적
  Core 로딩을 보존한 공식 ESM Worker를 앱과 함께 제공합니다.
- 첫 변환 시 단일 스레드 `@ffmpeg/core` 0.12.10 JavaScript와 WASM을
  CDN에서 내려받아 Blob URL로 로드합니다.
- APNG는 FFmpeg APNG 인코더를 사용합니다.
- GIF는 `palettegen` 후 `paletteuse`를 실행하는 2단계 색상표 흐름을
  사용합니다.
- 취소 또는 완료 시 FFmpeg Worker, 가상 파일, Blob URL을 정리합니다.

Cloudflare Worker 호환 출력은 기존 vinext/Vite/Sites 구성을 그대로
사용합니다. 데이터베이스와 객체 저장소 바인딩은 필요하지 않습니다.

## 개인정보

애플리케이션은 동영상 파일을 네트워크 요청 본문에 넣지 않습니다. 네트워크는
앱 리소스와 고정된 FFmpeg 엔진을 내려받는 데만 사용됩니다. 결과 다운로드는
브라우저 메모리의 Blob URL에서 만들어집니다.
