import path from "path";
import { defineConfig } from "vitest/config";
import dts from "vite-plugin-dts";
import pkg from "./package.json";

export default defineConfig((env) => ({
  plugins: [
    dts({
      rollupTypes: true,
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src/provider"),
    },
  },
  build: {
    minify: false,
    rollupOptions: {
      external: [
        ...Object.keys(pkg.dependencies || {}),
        "fs",
        "path",
        "util",
        "crypto",
        "stream",
        "http",
        "https",
        "url",
        "zlib",
        "os",
        "assert",
        "events",
        "dns",
        "net",
        "tls",
      ],
      output: {
        globals: Object.fromEntries(
          Object.keys(pkg.dependencies || {}).map((v) => [v, v]),
        ),
      },
    },
    outDir: "lib",
    lib: {
      entry: path.resolve(__dirname, "src/provider/index.ts"),
      name: "index",
      formats: ["cjs", "es"],
      fileName: (format) => {
        if (format === "cjs") return "index.js";
        return `index.${format === "es" ? "mjs" : "js"}`;
      },
    },
  },
}));
