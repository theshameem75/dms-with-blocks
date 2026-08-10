import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets the dev server (and its HMR websocket) respond to requests on the
  // project's custom local domain, not just localhost.
  allowedDevOrigins: ["ssdlik.dev.slsblx.com", "dntdxj.dev.slsblx.com"],
};

export default nextConfig;
