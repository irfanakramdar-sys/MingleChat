import { cp, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../server/wwwroot/supabase-config.js";

function isPublicKey(key) {
  if (key.startsWith("sb_publishable_")) return true;
  const encodedPayload = key.split(".")[1];
  if (!encodedPayload) return false;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    return payload.role === "anon";
  } catch {
    return false;
  }
}

if (SUPABASE_URL || SUPABASE_ANON_KEY) {
  let projectUrl;
  try {
    projectUrl = new URL(SUPABASE_URL);
  } catch {
    throw new Error("SUPABASE_URL must be a valid HTTPS Supabase project URL.");
  }

  if (projectUrl.protocol !== "https:" || projectUrl.username || projectUrl.password) {
    throw new Error("SUPABASE_URL must use HTTPS and must not contain credentials.");
  }

  if (!isPublicKey(SUPABASE_ANON_KEY)) {
    throw new Error("SUPABASE_ANON_KEY must be a publishable key or legacy anon key, never a secret or service_role key.");
  }
}

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("server/wwwroot", "dist", { recursive: true });
await build({
  entryPoints: ["server/wwwroot/app.js"],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: "dist/app.js"
});
