#!/usr/bin/env node

/**
 * MCP Skills — Trust Score Server
 *
 * An MCP server that provides AI skill and repo trust scoring
 * directly inside Claude Code, Cursor, and any MCP client.
 *
 * Tools:
 *   - check_trust_score: Score any GitHub repo
 *   - scan_safety: Run safety-only scan for AI skills
 *   - list_packages: Browse curated safe skill packages
 *
 * Free tier returns tier + dimension scores.
 * Full reports (all 12 signals + safety findings) require an API key.
 * Get your key at https://mcpskills.io/api
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE = "https://mcpskills.io/.netlify/functions";
const PACKAGES_URL = "https://mcpskills.io/.netlify/functions/packages";

// --- API Client ---

async function fetchScore(repo, apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;

  const res = await fetch(`${API_BASE}/score`, {
    method: "POST",
    headers,
    body: JSON.stringify({ repo }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `API error: ${res.status}`);
  }

  return res.json();
}

async function fetchPackages() {
  const res = await fetch(PACKAGES_URL);
  if (!res.ok) throw new Error("Could not fetch packages");
  return res.json();
}

// --- Format Helpers ---

function formatTier(tier) {
  const icons = { verified: "✅", established: "🟡", new: "⚪", blocked: "🚫" };
  return `${icons[tier] || "❓"} ${tier.charAt(0).toUpperCase() + tier.slice(1)}`;
}

function formatDimensions(dims) {
  return [
    `  Alive:  ${dims.alive}/10 (maintained?)`,
    `  Legit:  ${dims.legit}/10 (credible author?)`,
    `  Solid:  ${dims.solid}/10 (secure?)`,
    `  Usable: ${dims.usable}/10 (good docs?)`,
  ].join("\n");
}

function formatRecommendations(recs) {
  if (!recs || (!recs.alternatives?.length && !recs.crossCategory?.length)) return [];

  const lines = ["", "## Recommendations"];

  if (recs.alternatives?.length > 0) {
    lines.push("");
    lines.push(`**Alternatives in ${recs.categories?.[0]?.name || "this category"}:**`);
    for (const alt of recs.alternatives) {
      const scoreStr = alt.score ? ` — ${alt.score}/10 ${alt.tier ? formatTier(alt.tier) : ""}` : " — not yet scored";
      lines.push(`  → **${alt.repo}** (${alt.label})${scoreStr}`);
    }
  }

  if (recs.crossCategory?.length > 0) {
    lines.push("");
    lines.push("**You might also need:**");
    for (const sug of recs.crossCategory) {
      const scoreStr = sug.score ? ` (${sug.score}/10)` : "";
      lines.push(`  → **${sug.repo}**${scoreStr} — ${sug.label} (${sug.reason})`);
    }
  }

  return lines;
}

function formatFreeResult(data) {
  const lines = [
    `# Trust Score: ${data.repo}`,
    "",
    `**Score:** ${data.composite}/10`,
    `**Tier:** ${formatTier(data.tier)}`,
    `**Mode:** ${data.mode === "skills" ? "Skills Mode (AI skill detected)" : "Standard Mode"}`,
    "",
    `## Dimensions`,
    formatDimensions(data.dimensions),
    "",
    `⭐ ${data.meta.stars.toLocaleString()} stars | 🍴 ${data.meta.forks.toLocaleString()} forks | 📄 ${data.meta.license}`,
  ];

  if (data.mode === "skills" && data.skill) {
    lines.push("", `## Skill Info`);
    lines.push(`  Type: ${data.skill.type}`);
    lines.push(`  Safety: ${data.skill.safety?.summary || "Not scanned"}`);
  }

  // Recommendations
  if (data.recommendations) {
    lines.push(...formatRecommendations(data.recommendations));
  }

  lines.push(
    "",
    "---",
    "🔒 Full report (all signals + safety findings) → https://mcpskills.io",
    "Set MCPSKILLS_API_KEY for full reports in-context."
  );

  return lines.join("\n");
}

function formatFullResult(data) {
  const lines = [
    `# Trust Score: ${data.repo}`,
    "",
    `**Score:** ${data.composite}/10`,
    `**Tier:** ${formatTier(data.tier)}`,
    `**Mode:** ${data.mode === "skills" ? "Skills Mode (AI skill detected)" : "Standard Mode"}`,
    "",
    `## Dimensions`,
    formatDimensions(data.dimensions),
    "",
    `## All Signals`,
  ];

  const signalLabels = {
    commit_recency: "Commit Recency",
    release_cadence: "Release Cadence",
    issue_responsiveness: "Issue Response",
    author_credibility: "Author Credibility",
    community_adoption: "Community Adoption",
    contributor_diversity: "Contributor Diversity",
    download_adoption: "Download Adoption",
    security_posture: "Security Posture",
    dependency_health: "Dependency Health",
    readme_quality: "README Quality",
    file_structure: "File Structure",
    skill_spec_compliance: "Spec Compliance",
    license_clarity: "License Clarity",
    tool_safety: "Tool Safety",
    supply_chain_safety: "Supply Chain Safety",
  };

  for (const [key, val] of Object.entries(data.signals)) {
    const label = signalLabels[key] || key;
    const bar = "█".repeat(Math.round(val)) + "░".repeat(10 - Math.round(val));
    lines.push(`  ${bar} ${val}/10  ${label}`);
  }

  lines.push(
    "",
    `⭐ ${data.meta.stars.toLocaleString()} stars | 🍴 ${data.meta.forks.toLocaleString()} forks | 📄 ${data.meta.license}`
  );

  if (data.mode === "skills" && data.skill) {
    lines.push("", `## Skill Details`);
    lines.push(`  Type: ${data.skill.type}`);
    lines.push(`  Indicators: ${data.skill.indicators.join(", ")}`);

    if (data.skill.specChecks) {
      lines.push("", `  ### Spec Compliance`);
      for (const [check, passed] of Object.entries(data.skill.specChecks)) {
        lines.push(`    ${passed ? "✅" : "❌"} ${check}`);
      }
    }

    lines.push("", `  ### Safety Scan`);
    lines.push(`  Summary: ${data.skill.safety?.summary || "Not scanned"}`);
    if (data.skill.safety?.findings?.length > 0) {
      for (const f of data.skill.safety.findings) {
        lines.push(
          `    ⚠️ [${f.severity}] ${f.check} in ${f.file}: ${f.snippet}`
        );
      }
    } else {
      lines.push("  ✅ No threat patterns detected");
    }
  }

  if (data.disqualifiers?.length > 0) {
    lines.push("", `## ⚠️ Disqualifiers: ${data.disqualifiers.join(", ")}`);
  }

  // Recommendations
  if (data.recommendations) {
    lines.push(...formatRecommendations(data.recommendations));
  }

  lines.push("", `Scanned at: ${data.scannedAt}`);
  lines.push("Powered by mcpskills.io");

  return lines.join("\n");
}

function formatSafetyResult(data) {
  if (data.mode !== "skills" || !data.skill) {
    return [
      `# Safety Scan: ${data.repo}`,
      "",
      "This repo was not detected as an AI skill or MCP server.",
      "Safety scanning only runs on repos identified as skills.",
      "",
      `Mode: ${data.mode}`,
      `Score: ${data.composite}/10 | Tier: ${formatTier(data.tier)}`,
    ].join("\n");
  }

  const lines = [
    `# Safety Scan: ${data.repo}`,
    "",
    `**Skill Type:** ${data.skill.type}`,
    `**Safety Score:** ${data.signals.tool_safety}/10`,
    `**Status:** ${data.skill.safety?.summary || "Unknown"}`,
    "",
  ];

  if (data.skill.safety?.isBlocked) {
    lines.push("🚫 **BLOCKED** — This skill has confirmed threat patterns and should NOT be installed.");
    lines.push("");
  }

  lines.push("## Safety Checks");
  const checks = [
    "Prompt injection (hidden instructions in SKILL.md/README)",
    "Shell execution (piped curl|sh, eval with network content)",
    "Network exfiltration (Discord webhooks, raw IP C2, pastebin)",
    "Credential access (SSH keys, AWS creds, browser storage)",
    "Obfuscated payloads (base64, hex encoding, charCode chains)",
  ];

  if (data.skill.safety?.findings?.length > 0) {
    const foundChecks = new Set(data.skill.safety.findings.map((f) => f.check));
    for (const check of checks) {
      const key = check.split(" (")[0].toLowerCase().replace(/ /g, "_");
      const found = [...foundChecks].some((f) => f.includes(key.split("_")[0]));
      lines.push(`  ${found ? "⚠️" : "✅"} ${check}`);
    }
    lines.push("", "## Findings");
    for (const f of data.skill.safety.findings) {
      lines.push(`  ⚠️ [${f.severity.toUpperCase()}] ${f.check}`);
      lines.push(`     File: ${f.file}`);
      lines.push(`     Match: ${f.snippet}`);
      lines.push("");
    }
  } else {
    for (const check of checks) {
      lines.push(`  ✅ ${check}`);
    }
    lines.push("", "✅ No threat patterns detected. Clean scan.");
  }

  lines.push("", "---", "Powered by mcpskills.io");
  return lines.join("\n");
}

// --- MCP Server ---

const server = new Server(
  {
    name: "mcpskills",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "check_trust_score",
        description:
          "Score any GitHub repo for trustworthiness. Returns a trust score (0-10) across 4 dimensions: Alive (maintained?), Legit (credible author?), Solid (secure?), Usable (good docs?). AI skills and MCP servers get enhanced scanning with 5 safety checks. Set MCPSKILLS_API_KEY env var for full 12-signal reports.",
        inputSchema: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description:
                'GitHub repo in "owner/repo" format (e.g., "anthropics/anthropic-sdk-typescript")',
            },
          },
          required: ["repo"],
        },
      },
      {
        name: "scan_safety",
        description:
          "Run a focused safety scan on an AI skill or MCP server repo. Checks for prompt injection, shell execution, network exfiltration, credential theft, and obfuscated payloads. Returns detailed findings with file locations. Only works on repos detected as AI skills.",
        inputSchema: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description:
                'GitHub repo in "owner/repo" format (e.g., "modelcontextprotocol/servers")',
            },
          },
          required: ["repo"],
        },
      },
      {
        name: "list_packages",
        description:
          "Browse curated, pre-scored AI skill packages organized by use case. Each package contains vetted skills with trust scores. Available packages: Claude Power User, Full-Stack Vibe Coder, Data & Research, DevOps & Infrastructure, Content & Marketing.",
        inputSchema: {
          type: "object",
          properties: {
            package_name: {
              type: "string",
              description:
                'Optional: filter by package name (e.g., "claude-power-user"). Omit to list all packages.',
            },
          },
        },
      },
      {
        name: "get_badge",
        description:
          "Get a trust badge URL for any GitHub repo. Returns a shields.io-style SVG badge showing the trust score and tier. Embed in READMEs to show verified trust status. Badge auto-updates hourly.",
        inputSchema: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description: 'GitHub repo in "owner/repo" format',
            },
          },
          required: ["repo"],
        },
      },
      {
        name: "watch_repo",
        description:
          "Start monitoring a repo for trust score changes. You'll be alerted when a repo's score changes significantly (±0.3 points or tier change). Free tier: up to 20 repos.",
        inputSchema: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description: 'GitHub repo in "owner/repo" format',
            },
            email: {
              type: "string",
              description: "Email address for alerts",
            },
          },
          required: ["repo", "email"],
        },
      },
      {
        name: "check_watched",
        description:
          "Re-scan all watched repos and check for score changes. Returns any repos whose trust score changed significantly since last check.",
        inputSchema: {
          type: "object",
          properties: {
            email: {
              type: "string",
              description: "Email address used when watching repos",
            },
          },
          required: ["email"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const apiKey = process.env.MCPSKILLS_API_KEY || null;

  try {
    switch (name) {
      case "check_trust_score": {
        const repo = args.repo;
        if (!repo || !repo.includes("/")) {
          return {
            content: [
              {
                type: "text",
                text: 'Invalid repo format. Use "owner/repo" (e.g., "anthropics/anthropic-sdk-typescript").',
              },
            ],
            isError: true,
          };
        }

        const data = await fetchScore(repo, apiKey);
        const formatted = apiKey
          ? formatFullResult(data)
          : formatFreeResult(data);

        return { content: [{ type: "text", text: formatted }] };
      }

      case "scan_safety": {
        const repo = args.repo;
        if (!repo || !repo.includes("/")) {
          return {
            content: [
              {
                type: "text",
                text: 'Invalid repo format. Use "owner/repo".',
              },
            ],
            isError: true,
          };
        }

        const data = await fetchScore(repo, apiKey);
        const formatted = formatSafetyResult(data);
        return { content: [{ type: "text", text: formatted }] };
      }

      case "list_packages": {
        const raw = await fetchPackages();
        const packages = raw.packages || raw;
        const filter = args.package_name?.toLowerCase();

        let filtered = packages;
        if (filter) {
          filtered = packages.filter(
            (p) =>
              p.id.includes(filter) ||
              p.name.toLowerCase().includes(filter)
          );
        }

        if (filtered.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No packages found${filter ? ` matching "${filter}"` : ""}. Available: ${packages.map((p) => p.id).join(", ")}`,
              },
            ],
          };
        }

        const lines = ["# MCP Skills — Curated Packages", ""];
        for (const pkg of filtered) {
          lines.push(`## ${pkg.name}`);
          lines.push(pkg.tagline || pkg.description || "");
          lines.push("");
          const items = pkg.skills || pkg.repos || [];
          for (const item of items) {
            const name = item.name || `${item.owner}/${item.repo}`;
            const desc = item.description || item.role || "";
            lines.push(`  - **${name}** — ${desc}`);
          }
          lines.push("");
        }

        lines.push("---", "All packages vetted by mcpskills.io");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "get_badge": {
        const repo = args.repo;
        if (!repo || !repo.includes("/")) {
          return {
            content: [{ type: "text", text: 'Invalid repo format. Use "owner/repo".' }],
            isError: true,
          };
        }

        const badgeUrl = `https://mcpskills.io/.netlify/functions/badge?repo=${encodeURIComponent(repo)}`;
        const reportUrl = `https://mcpskills.io/?repo=${encodeURIComponent(repo)}`;

        const lines = [
          `# Trust Badge for ${repo}`,
          "",
          "## Badge URL",
          `\`${badgeUrl}\``,
          "",
          "## Embed in README.md",
          "```markdown",
          `[![MCP Skills Trust Score](${badgeUrl})](${reportUrl})`,
          "```",
          "",
          "## Embed in HTML",
          "```html",
          `<a href="${reportUrl}"><img src="${badgeUrl}" alt="MCP Skills Trust Score" /></a>`,
          "```",
          "",
          "The badge auto-updates hourly. It shows the current trust score, tier, and links to the full report.",
          "",
          "---",
          "Verified by mcpskills.io",
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "watch_repo": {
        const repo = args.repo;
        const email = args.email;
        if (!repo || !repo.includes("/")) {
          return {
            content: [{ type: "text", text: 'Invalid repo format. Use "owner/repo".' }],
            isError: true,
          };
        }
        if (!email || !email.includes("@")) {
          return {
            content: [{ type: "text", text: "Invalid email address." }],
            isError: true,
          };
        }

        const res = await fetch(`${API_BASE}/monitor`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "watch", repo, email }),
        });
        const data = await res.json();

        const lines = [
          `# Watching ${repo}`,
          "",
          `**Current Score:** ${data.currentScore ?? "Scanning..."}`,
          `**Current Tier:** ${data.currentTier ? formatTier(data.currentTier) : "Unknown"}`,
          `**Total Watched:** ${data.totalWatched || 1}`,
          "",
          `You'll be notified at ${email} when this repo's trust score changes by ±0.3 points or its tier changes.`,
          "",
          "Use **check_watched** to manually re-scan all your watched repos.",
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "check_watched": {
        const email = args.email;
        if (!email || !email.includes("@")) {
          return {
            content: [{ type: "text", text: "Invalid email address." }],
            isError: true,
          };
        }

        const res = await fetch(`${API_BASE}/monitor`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "check", email }),
        });
        const data = await res.json();

        const lines = [
          `# Monitoring Report`,
          "",
          `**Repos Checked:** ${data.checked || 0}`,
          `**Changes Detected:** ${data.changes?.length || 0}`,
          "",
        ];

        if (data.changes?.length > 0) {
          lines.push("## Score Changes");
          for (const c of data.changes) {
            const arrow = c.delta > 0 ? "↑" : "↓";
            const emoji = c.delta > 0 ? "📈" : "📉";
            lines.push(`  ${emoji} **${c.repo}** ${c.oldScore} → ${c.newScore} (${arrow}${Math.abs(c.delta)})`);
            if (c.tierChanged) {
              lines.push(`     Tier: ${c.oldTier} → ${c.newTier}`);
            }
          }
        } else {
          lines.push("✅ All watched repos are stable. No significant changes.");
        }

        lines.push("", "---", "Powered by mcpskills.io");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${err.message}\n\nIf this persists, try scanning at https://mcpskills.io`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP Skills server failed to start:", err);
  process.exit(1);
});
