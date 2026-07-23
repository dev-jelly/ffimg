# Third-party notices

This application downloads and runs the following pinned open-source components
in the user's browser. This notice is informational and is not legal advice.

## ffmpeg.wasm wrapper

- Package: `@ffmpeg/ffmpeg`
- Version: `0.12.15`
- License: MIT
- Source: https://github.com/ffmpegwasm/ffmpeg.wasm
- License text: https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/LICENSE

## ffmpeg.wasm core

- Package: `@ffmpeg/core`
- Version: `0.12.10`
- Published license identifier: GPL-2.0-or-later
- Source: https://github.com/ffmpegwasm/ffmpeg.wasm
- Package record: https://www.npmjs.com/package/@ffmpeg/core/v/0.12.10
- License FAQ: https://ffmpegwasm.netlify.app/docs/faq/
- Upstream FFmpeg legal information: https://ffmpeg.org/legal.html

The runtime verifies the downloaded core JavaScript and WebAssembly assets
against pinned SHA-256 digests before execution.
