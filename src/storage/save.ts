import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/** Decode a base64 image and persist it as {images}/<projectId>/<idx>.png. Returns the file path. */
export function saveImage(projectId: string, idx: number, b64: string): string {
  const dir = path.join(config.imagesDir, projectId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(idx).padStart(3, "0")}.png`);
  fs.writeFileSync(file, Buffer.from(b64, "base64"));
  return file;
}
