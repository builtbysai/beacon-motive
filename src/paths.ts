import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

export function dataDir(): string {
  if (process.env.MOTIVE_HOME) return path.resolve(process.env.MOTIVE_HOME);
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "beacon-motive");
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "beacon-motive");
}

export function dbPath(): string {
  return path.join(dataDir(), "motive.db");
}

/** Creates the API token once, readable only by the current user. Never printed by the server. */
export function apiToken(): string {
  const file = path.join(dataDir(), "api-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dataDir(), { recursive: true });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(file, token, { mode: 0o600 });
  if (process.platform === "win32") {
    try {
      execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:(R,W)`], { stdio: "ignore" });
    } catch {
      /* the folder is already under the user's profile */
    }
  } else {
    chmodSync(file, 0o600);
  }
  return token;
}

export function tokenFile(): string {
  return path.join(dataDir(), "api-token");
}
