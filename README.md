# 핌쥐

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

## 예상 용량 모델

`lib/output-size-estimator.mjs`는 UI와 FFmpeg에서 분리된 순수 함수입니다.
`estimateOutputSize({ settings, media })`에 `normalizeSettings`가 반환한 설정과
브라우저에서 확인한 원본 길이·너비·높이·파일 크기를 전달합니다. 파일 크기는
선택적인 약한 복잡도 신호일 뿐이며, 함수는 프레임을 읽거나 인코딩하지 않습니다.

반환값은 다음 안정된 계약을 사용합니다.

- `status`: `available` 또는 `unavailable`
- `reason`: 사용할 수 없을 때 `missing-metadata` 또는 `invalid-input`
- `rangeBytes`: 정수 `lower`·`likely`·`upper` 바이트 범위 또는 `null`
- `output`: 예상 출력 너비·높이·프레임 수 또는 각각 `null`
- `confidence`: `limited` 또는 `unavailable`
- `primaryUncertainty`: `visual-complexity` 또는 `null`
- `sizeClass`: `normal`, `large`, `very-large`, 또는 `unavailable`
- `modelVersion`: 고정 fixture와 호출자를 위한 모델 버전
- `capped`: 4GB 모델 상한에 닿아 후보 비교가 무의미해졌는지 여부

사용 가능한 범위는 항상 1KB 이상 4GB 이하의 유한한 정수이며 하한이 상한보다
크지 않고 `likely`가 그 안에 있습니다. 같은 형식과 메타데이터에서는 길이,
FPS, 축소 중인 너비를 높여도 범위가 작아지지 않습니다. GIF 색상 수를 높여도
작아지지 않고, APNG 압축 단계를 높여도 커지지 않습니다. APNG 압축 0은 거의
원시 RGBA에 가까워질 수 있어 1-9와 별도 구간으로 계산합니다.

범위는 보장이 아닙니다. 가장 큰 불확실성은 실제 장면의 움직임과 색 변화이며,
원본 컨테이너 크기는 로그 스케일의 약한 힌트로만 사용합니다. GIF 색상 수,
디더링, 색상 분석, APNG 압축은 작은 로컬 실측 모음으로 보정했지만 영상마다
관계가 달라질 수 있습니다. 반복 횟수는 인코딩 프레임을 복제하지 않으므로
용량에 곱하지 않습니다. 정확도 백분율은 표시하지 않습니다.

향후 목표 용량 탐색기는 같은 순수 함수를 후보마다 반복 호출합니다. 균형
정책은 `likely`, 보수 정책은 `upper`를 비교 기준으로 사용하고 `capped` 후보는
순위를 매기지 않습니다. 목표 용량을 직접 입력하는 자동 탐색 UI는 아직
제공하지 않습니다.

## 적응형 프리셋

`lib/adaptive-presets.mjs`는 영상 길이, 원본 해상도, 파일 크기와 출력 형식을
함께 보고 FPS·최대 너비·색상 수·압축 설정을 결정합니다. 초보자 모드는 자동
추천을 바로 적용하고, 중급자 모드는 영상별 자동·가볍게·균형·선명하게 값을
보여 줍니다. 고급 모드는 추천값을 명시적으로 불러올 때만 수동 설정을
변경합니다.

## 개인정보

애플리케이션은 동영상 파일을 네트워크 요청 본문에 넣지 않습니다. 네트워크는
앱 리소스와 고정된 FFmpeg 엔진을 내려받는 데만 사용됩니다. 결과 다운로드는
브라우저 메모리의 Blob URL에서 만들어집니다.
