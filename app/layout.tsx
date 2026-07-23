import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "움짤공방 — 브라우저 동영상 APNG·GIF 변환기";
const description =
  "동영상을 서버에 올리지 않고 브라우저 안에서 APNG 또는 GIF로 변환하세요.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders
    .get("x-forwarded-host")
    ?.split(",")[0]
    .trim();
  const host = forwardedHost ?? requestHeaders.get("host");
  const validHost =
    host && /^[a-z0-9.-]+(?::\d+)?$/i.test(host) ? host : null;
  const forwardedProtocol = requestHeaders
    .get("x-forwarded-proto")
    ?.split(",")[0]
    .trim();
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? forwardedProtocol
      : validHost?.startsWith("localhost")
        ? "http"
        : "https";
  const metadataBase = validHost
    ? new URL(`${protocol}://${validHost}`)
    : undefined;
  const socialImage = metadataBase
    ? new URL("/og.png", metadataBase).toString()
    : undefined;

  return {
    metadataBase,
    title,
    description,
    applicationName: "움짤공방",
    openGraph: {
      type: "website",
      locale: "ko_KR",
      title,
      description,
      siteName: "움짤공방",
      images: socialImage
        ? [
            {
              url: socialImage,
              width: 1200,
              height: 628,
              alt: "움짤공방 — 동영상을 움직이는 이미지로 바꾸는 브라우저 변환기",
            },
          ]
        : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: socialImage ? [socialImage] : undefined,
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f3efe6",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
