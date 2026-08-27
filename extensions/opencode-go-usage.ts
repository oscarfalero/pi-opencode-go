/**
 * opencode-go usage — status bar for OpenCode Go subscription
 *
 * Shows ultra-compact usage in the footer only when:
 *   1. opencode-go provider is configured (auth.json / env)
 *   2. current model provider is "opencode-go"
 *   3. compact is enabled (toggle via /go-status)
 *
 * Refresh: post-turn (turn_end / agent_settled) + session_start + model_select.
 * No time-based interval.
 *
 * Endpoint: GET https://opencode.ai/zen/go/v1/usage
 *   Header: authorization: Bearer <OPENCODE_API_KEY>
 *   200: { usage: { rolling:{status, percent, resetsAt}, weekly:{...}, monthly:{...} } }
 *
 * Status key: "opencode-go-usage"
 * Color: fixed pastel yellow (mdHeading #f0c674) — no conditional warning/error.
 *
 * Toggle: /go-status — persists to <agent-dir>/opencode-go-usage.json (rebrand-safe via getAgentDir()).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATUS_KEY = "opencode-go-usage";
const PROD_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const CONFIG_PATH = join(getAgentDir(), "opencode-go-usage.json");

type UsageBucket = {
  status: "ok" | "rate-limited";
  percent: number;
  resetsAt: string;
};

type UsageResponse = {
  usage: {
    rolling: UsageBucket;
    weekly: UsageBucket;
    monthly: UsageBucket;
  };
};

function loadCompactVisible(): boolean {
  try {
    if (!existsSync(CONFIG_PATH)) return true;
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const data = JSON.parse(raw) as { visible?: boolean };
    // explicit false disables, anything else enables (default true)
    return data.visible !== false;
  } catch {
    return true;
  }
}

function saveCompactVisible(visible: boolean): void {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify({ visible }, null, 2) + "\n", "utf8");
  } catch {}
}

export default function (pi: ExtensionAPI) {
  let cached: UsageResponse["usage"] | null = null;
  let isFetching = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let compactVisible = loadCompactVisible();

  function isGoActive(ctx: ExtensionContext): boolean {
    if (!compactVisible) return false;
    const auth = ctx.modelRegistry.getProviderAuthStatus("opencode-go");
    if (!auth.configured) return false;
    return ctx.model?.provider === "opencode-go";
  }

  function isProviderConfigured(ctx: ExtensionContext): boolean {
    return ctx.modelRegistry.getProviderAuthStatus("opencode-go").configured;
  }

  function getUsageUrl(ctx: ExtensionContext): string {
    const provider = ctx.modelRegistry.getProvider("opencode-go") as unknown as
      | { baseUrl?: string; api?: string }
      | undefined;

    const candidates: (string | undefined)[] = [
      (provider as any)?.baseUrl,
      (provider as any)?.api,
      (ctx.model as any)?.baseUrl,
    ];

    for (const base of candidates) {
      if (!base || base.includes("localhost") || base.includes("127.0.0.1")) continue;
      if (base.includes("/zen/go/v1")) {
        return base.replace(/\/$/, "") + "/usage";
      }
    }
    return PROD_USAGE_URL;
  }

  function formatResetsIn(iso: string): string {
    const diff = new Date(iso).getTime() - Date.now();
    if (diff <= 0) return "now";
    const mins = Math.round(diff / 60000);
    if (mins < 60) return `${mins}m`;
    if (mins < 1440) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return m === 0 ? `${h}h` : `${h}h ${m}m`;
    }
    const days = Math.floor(mins / 1440);
    const rem = mins % 1440;
    const h = Math.floor(rem / 60);
    const m = rem % 60;
    const parts: string[] = [`${days}d`];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    return parts.join(" ");
  }

  // Fixed pastel yellow — no conditional colors. Uses mdHeading (#f0c674) which is the
  // built-in pastel yellow in both dark/light themes.
  function pastel(theme: ExtensionContext["ui"]["theme"], text: string): string {
    try {
      return theme.fg("mdHeading", text);
    } catch {
      // fallback to warning (yellow) if theme lacks mdHeading for some reason
      return theme.fg("warning", text);
    }
  }

  function renderCompact(usage: UsageResponse["usage"], theme: ExtensionContext["ui"]["theme"]): string {
    const text = `Go ${usage.rolling.percent}/${usage.weekly.percent}/${usage.monthly.percent}%`;
    return pastel(theme, text);
  }

  async function fetchUsage(ctx: ExtensionContext): Promise<UsageResponse["usage"]> {
    const apiKey = await ctx.modelRegistry.getApiKeyForProvider("opencode-go");
    if (!apiKey) throw new Error("Missing OPENCODE_API_KEY");

    const url = getUsageUrl(ctx);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);

    // Merge the agent's turn signal (so Esc aborts) with our own timeout, and
    // always detach the listener afterwards so we never leak handlers on a
    // long-lived signal.
    let onAbort: (() => void) | undefined;
    if (ctx.signal) {
      if (ctx.signal.aborted) controller.abort();
      else {
        onAbort = () => controller.abort();
        ctx.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });

      if (res.status === 401) throw new Error("401 Unauthorized — check OPENCODE_API_KEY");
      if (res.status === 403) throw new Error("403 No OpenCode Go subscription for this key");
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

      const json = (await res.json()) as UsageResponse;
      if (!json.usage?.rolling || !json.usage?.weekly || !json.usage?.monthly) {
        throw new Error("Unexpected usage response shape");
      }
      return json.usage;
    } finally {
      clearTimeout(t);
      if (onAbort && ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
    }
  }

  /** UI setters can throw when pi invalidates ctx after session replacement/reload. Never let that escape as an unhandled rejection. */
  function safeSetStatus(ctx: ExtensionContext, value: string | undefined) {
    try {
      ctx.ui.setStatus(STATUS_KEY, value);
    } catch {}
  }

  async function refresh(ctx: ExtensionContext) {
    if (!isGoActive(ctx)) {
      safeSetStatus(ctx, undefined);
      return;
    }
    if (isFetching) return;
    isFetching = true;
    try {
      const usage = await fetchUsage(ctx);
      cached = usage;
      safeSetStatus(ctx, renderCompact(usage, ctx.ui.theme));
    } catch {
      if (cached) {
        safeSetStatus(ctx, pastel(ctx.ui.theme, `Go ${cached.rolling.percent}/${cached.weekly.percent}/${cached.monthly.percent}%`));
      } else {
        safeSetStatus(ctx, pastel(ctx.ui.theme, "Go --"));
      }
    } finally {
      isFetching = false;
    }
  }

  function scheduleRefresh(ctx: ExtensionContext) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void refresh(ctx).catch(() => {});
    }, 800);
  }

  // --- lifecycle ---

  pi.on("session_start", async (_evt, ctx) => {
    // Reload persisted preference on each session start (covers external edits)
    compactVisible = loadCompactVisible();
    if (!isGoActive(ctx)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, pastel(ctx.ui.theme, "Go …"));
    await refresh(ctx);
  });

  pi.on("model_select", async (_evt, ctx) => {
    if (!isGoActive(ctx)) {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, pastel(ctx.ui.theme, "Go …"));
    await refresh(ctx);
  });

  pi.on("turn_end", async (_evt, ctx) => {
    if (!isGoActive(ctx)) return;
    scheduleRefresh(ctx);
  });

  pi.on("agent_settled", async (_evt, ctx) => {
    if (!isGoActive(ctx)) return;
    scheduleRefresh(ctx);
  });

  pi.on("session_shutdown", async (_evt, ctx) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  // --- command: /go-usage (details) ---
  pi.registerCommand("go-usage", {
    description: "Show OpenCode Go usage (Rolling / Weekly / Monthly)",
    handler: async (_args, ctx) => {
      if (!isProviderConfigured(ctx)) {
        ctx.ui.notify("opencode-go not configured — set OPENCODE_API_KEY in auth.json or env", "warning");
        return;
      }

      const hint = ctx.model?.provider !== "opencode-go"
        ? " (current model is not opencode-go — status bar hidden until you select a Go model)"
        : "";

      try {
        const usage = await fetchUsage(ctx);
        cached = usage;
        if (isGoActive(ctx)) {
          ctx.ui.setStatus(STATUS_KEY, renderCompact(usage, ctx.ui.theme));
        }

        const fmtPct = (n: number) => `${String(n).padStart(3)}%`;
        const fmtStatus = (s: UsageBucket["status"]) => (s === "rate-limited" ? "rate-limited ⚠ — " : "");
        const fmtLine = (label: string, pct: number, status: UsageBucket["status"], resets: string) => {
          const spaces = " ".repeat(8 - label.length); // align % vertically (max label 7 + colon = 8)
          return `   ${label}:${spaces}${fmtPct(pct)} — ${fmtStatus(status)}resets in ${resets}`;
        };
        const lines = [
          `OpenCode Go usage${hint}:`,
          fmtLine("Rolling", usage.rolling.percent, usage.rolling.status, formatResetsIn(usage.rolling.resetsAt)),
          fmtLine("Weekly", usage.weekly.percent, usage.weekly.status, formatResetsIn(usage.weekly.resetsAt)),
          fmtLine("Monthly", usage.monthly.percent, usage.monthly.status, formatResetsIn(usage.monthly.resetsAt)),
          ``,
          `   Toggle compact status with /go-status`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.ui.notify(`Go usage fetch failed: ${msg}`, "error");
      }
    },
  });

  // --- command: /go-status (toggle compact bar) ---
  pi.registerCommand("go-status", {
    description: "Toggle OpenCode Go compact status bar",
    handler: async (_args, ctx) => {
      compactVisible = !compactVisible;
      saveCompactVisible(compactVisible);

      if (!compactVisible) {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        safeSetStatus(ctx, undefined);
        ctx.ui.notify("Go compact: off — hidden from status bar", "info");
      } else {
        if (isProviderConfigured(ctx) && ctx.model?.provider === "opencode-go") {
          ctx.ui.setStatus(STATUS_KEY, pastel(ctx.ui.theme, "Go …"));
          ctx.ui.notify("Go compact: on — fetching…", "info");
          await refresh(ctx);
        } else if (!isProviderConfigured(ctx)) {
          ctx.ui.notify("Go compact: on — will appear when opencode-go is configured and a Go model is selected", "info");
        } else {
          ctx.ui.notify("Go compact: on — will appear when a Go model is selected", "info");
          safeSetStatus(ctx, undefined);
        }
      }
    },
  });
}
