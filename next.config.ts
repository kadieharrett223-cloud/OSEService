import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Next defaults Server Action bodies to 1 MB. The OCC intentionally accepts
    // photos and PDFs, so leave room for a normal attachment plus multipart data
    // while staying below Vercel's 4.5 MB Function request ceiling.
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
};

export default nextConfig;
