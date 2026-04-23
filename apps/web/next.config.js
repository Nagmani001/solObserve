/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@repo/ui"],
  output: "standalone",
  serverExternalPackages: ["@prisma/client", "pg"],
};

export default nextConfig;
