import type { Metadata, Viewport } from "next";
import { Providers } from "./providers";
import "./globals.css";

const title = "핌쥐 - 브라우저 동영상 APNG·GIF 변환기";
const description =
  "동영상을 서버에 올리지 않고 브라우저 안에서 APNG 또는 GIF로 변환하세요.";
const pagesUrl = "https://dev-jelly.github.io/ffimg/";
const pagesSocialImage = `${pagesUrl}og.png`;
const socialImageAlt =
  "핌쥐 - 동영상을 움직이는 이미지로 바꾸는 브라우저 변환기";
const keywords = [
  "동영상 GIF 변환",
  "동영상 APNG 변환",
  "브라우저 영상 변환",
  "로컬 영상 변환",
  "ffmpeg wasm",
  "핌쥐",
];

function createMetadata({
  metadataBase,
  canonical,
  socialImage,
  iconPath,
  appleIconPath,
  indexable,
}: {
  metadataBase?: URL;
  canonical: string;
  socialImage: string;
  iconPath: string;
  appleIconPath: string;
  indexable: boolean;
}): Metadata {
  return {
    metadataBase,
    title: {
      default: title,
      template: "%s | 핌쥐",
    },
    description,
    applicationName: "핌쥐",
    alternates: { canonical },
    keywords,
    authors: [{ name: "dev-jelly", url: "https://github.com/dev-jelly" }],
    creator: "dev-jelly",
    publisher: "dev-jelly",
    category: "technology",
    referrer: "origin-when-cross-origin",
    formatDetection: {
      address: false,
      email: false,
      telephone: false,
    },
    robots: indexable
      ? {
          index: true,
          follow: true,
          googleBot: {
            index: true,
            follow: true,
            "max-image-preview": "large",
            "max-snippet": -1,
            "max-video-preview": -1,
          },
        }
      : {
          index: false,
          follow: false,
          noarchive: true,
          noimageindex: true,
          googleBot: {
            index: false,
            follow: false,
            noarchive: true,
            noimageindex: true,
          },
        },
    icons: {
      icon: [{ url: iconPath, type: "image/png", sizes: "256x256" }],
      shortcut: iconPath,
      apple: [{ url: appleIconPath, type: "image/png", sizes: "180x180" }],
    },
    appleWebApp: {
      capable: true,
      title: "핌쥐",
      statusBarStyle: "default",
    },
    openGraph: {
      type: "website",
      locale: "ko_KR",
      url: canonical,
      title,
      description,
      siteName: "핌쥐",
      images: [
        {
          url: socialImage,
          secureUrl: socialImage,
          type: "image/png",
          width: 1200,
          height: 630,
          alt: socialImageAlt,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [
        {
          url: socialImage,
          secureUrl: socialImage,
          type: "image/png",
          width: 1200,
          height: 630,
          alt: socialImageAlt,
        },
      ],
    },
  };
}

export async function generateMetadata(): Promise<Metadata> {
  if (process.env.FFIMG_PAGES_EXPORT === "1") {
    return createMetadata({
      metadataBase: new URL(pagesUrl),
      canonical: pagesUrl,
      socialImage: pagesSocialImage,
      iconPath: "/ffimg/pimg-mark.png",
      appleIconPath: "/ffimg/apple-touch-icon.png",
      indexable: true,
    });
  }

  const { headers } = await import("next/headers");
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
    : pagesSocialImage;

  return createMetadata({
    metadataBase,
    canonical: pagesUrl,
    socialImage,
    iconPath: "/pimg-mark.png",
    appleIconPath: "/apple-touch-icon.png",
    indexable: false,
  });
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
    <html
      lang="ko"
      data-base-path={
        process.env.FFIMG_PAGES_EXPORT === "1" ? "/ffimg" : undefined
      }
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
