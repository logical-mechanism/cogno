/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static-export SPA (DR / L5 §10.4): self-hostable on any static host / IPFS,
  // no SSR data dependency, no backend, no telemetry.
  output: "export",
  reactStrictMode: true,
  // Static export cannot optimize images at request time.
  images: { unoptimized: true },
  // No Next telemetry; honesty/neutrality requirement (L5 §10.4/§10.5).
  // (also disabled via `next telemetry disable` env at build).
  trailingSlash: true,
};

export default nextConfig;
