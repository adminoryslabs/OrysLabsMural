import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone so the production Docker image stays small.
  output: "standalone",
  reactStrictMode: true,
  // Native argon2 bindings must not be bundled by the server compiler.
  serverExternalPackages: ["@node-rs/argon2", "postgres"],
};

export default nextConfig;
