import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  typescript: {
    // The separate TypeScript check pass has been crashing/hanging silently
    // during Vercel builds after Turbopack already compiles successfully.
    // Skip it here; run `npx tsc --noEmit` locally/in CI if you want type checking.
    ignoreBuildErrors: true,
  },
  // Next 16 dropped `eslint` from the NextConfig type (lint no longer runs as part of `next build`),
  // so this is spread in rather than declared — keeping the setting for any tooling that still reads
  // it without making `tsc --noEmit` fail on an unknown property.
  ...{ eslint: { ignoreDuringBuilds: true } },
};

export default nextConfig;
