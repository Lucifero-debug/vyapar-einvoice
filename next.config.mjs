/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // No `eslint` key: Next.js 16 removed it (and `next lint` with it) -- the
  // installed 16.2.4 warns "`eslint` configuration in next.config.mjs is no
  // longer supported" and ignores it. `next build` no longer lints at all, so
  // `ignoreDuringBuilds` was already doing nothing. Linting is `npm run lint`,
  // which runs ESLint directly against eslint.config.mjs.
};

export default nextConfig;
