import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "fs/promises";

// Bundle selected server deps to reduce cold start openat(2) syscalls.
// Keep this list aligned with actual server/runtime deps.
const allowlist = [
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "@azure/identity",
  "@azure/keyvault-secrets",
  "cookie-parser",
  "express",
  "mssql",
  "openai",
  "uuid",
  "ws",
  "zod",
  "zod-validation-error",
  "nanoid",
];

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  // allow either "https://example.com" or "example.com"
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.replace(/\/+$/, "");
  }
  return `https://${trimmed.replace(/\/+$/, "")}`;
}

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  // Ensure PUBLIC_BASE_URL is in a consistent form for the Vite plugin
  const normalized = normalizeBaseUrl(process.env.PUBLIC_BASE_URL);
  if (normalized) {
    process.env.PUBLIC_BASE_URL = normalized;
    if (process.env.NODE_ENV === "production") {
      console.log("[build] PUBLIC_BASE_URL:", normalized);
    }
  }

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];

  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
