import type { NextConfig } from "next";

const isPagesExport = process.env.FFIMG_PAGES_EXPORT === "1";

const nextConfig: NextConfig = {
  ...(isPagesExport
    ? {
        output: "export",
        basePath: "/ffimg",
        trailingSlash: true,
        typescript: {
          tsconfigPath: "tsconfig.pages.json",
        },
      }
    : {}),
};

export default nextConfig;
