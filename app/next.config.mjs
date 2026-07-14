/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static-export SPA: self-hostable on any static host / IPFS,
  // no SSR data dependency, no backend, no telemetry.
  //
  // PRODUCTION-ONLY export: `output:'export'` forces dynamicParams=false, which makes a dev server
  // reject any /u/<addr> or /post/<id> that isn't the `_` placeholder from generateStaticParams
  // ("missing param … required with output: export"). Gating it to the production build lets `next
  // dev` render dynamic routes on demand (real local testing of profiles/threads) while `next build`
  // still emits the static export served via the nginx SPA fallback. (Dev: NODE_ENV=development.)
  ...(process.env.NODE_ENV === "production" ? { output: "export" } : {}),
  reactStrictMode: true,
  // Static export cannot optimize images at request time.
  images: { unoptimized: true },
  // No Next telemetry; honesty/neutrality requirement.
  // (also disabled via `next telemetry disable` env at build).
  trailingSlash: true,
};

export default nextConfig;
