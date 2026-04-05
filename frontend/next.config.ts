import type { NextConfig } from "next";
import { config } from "dotenv";
import { resolve } from "path";

// Load shared env from vault root (~/vault/.env)
config({ path: resolve(__dirname, "../.env") });

const nextConfig: NextConfig = {
  /* config */
};

export default nextConfig;
