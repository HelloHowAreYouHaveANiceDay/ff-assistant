// Auth status for the Copilot. The Agent SDK rides the `claude` login (subscription OAuth) stored
// at ~/.claude/.credentials.json. We consider the session usable while the REFRESH token is valid
// (the SDK auto-refreshes the short-lived access token). Reads structure only -- never returns or
// logs any token value.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AuthStatus = { authenticated: boolean; source: "subscription" | "expired" | "none"; subscriptionType?: string; refreshExpiresAt?: number };

export function authStatus(): AuthStatus {
  try {
    const cred = JSON.parse(readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8")) as { claudeAiOauth?: { refreshTokenExpiresAt?: number; subscriptionType?: string } };
    const o = cred.claudeAiOauth;
    if (o?.refreshTokenExpiresAt && o.refreshTokenExpiresAt > Date.now()) {
      return { authenticated: true, source: "subscription", subscriptionType: o.subscriptionType, refreshExpiresAt: o.refreshTokenExpiresAt };
    }
    return { authenticated: false, source: o ? "expired" : "none" };
  } catch {
    return { authenticated: false, source: "none" };
  }
}
