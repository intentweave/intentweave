// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.IW_SERVER_PORT ?? "3100"}`,
        changeOrigin: true,
      },
      "/health": {
        target: `http://localhost:${process.env.IW_SERVER_PORT ?? "3100"}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
