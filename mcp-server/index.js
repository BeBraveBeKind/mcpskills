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
 *   - get_badge: Get trust badge URL for READMEs
 *   - watch_repo: Monitor a repo for score changes
 *   - check_watched: Re-scan all watched repos
 *   - batch_check: Check up to 5 repos in one call (Pro)
 *   - auto_gate: "Should I install this?" → boolean + reason
 *
 * Free tier returns compact agent response.
 * Full reports require MCPSKILLS_API_KEY env var.
 * Get your key at https://mcpskills.io
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
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  if (apiKey) headers["X-API-Key"] = apiKey;

  const res = await fetch(`${API_BASE}/score`, {
    method: "POST",
    headers,
    body: JSON.stringify({ repo }),
  });

  if (res.status === 429) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Rate limit exceeded. ${err.upgrade || 'Set MCPSKILLS_API_KEY for more scans.'}`);
  }

  if (res.status === 401 || res.status === 403) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Auth error: ${res.status}`);
  }

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
  if (!dims) return "  (dimensions unavailable)";
  return [
    `  Alive:  ${dims.alive ?? '?'}/10 (maintained?)`,
    `  Legit:  ${dims.legit ?? '?'}/10 (credible author?)`,
    `  Solid:  ${dims.solid ?? '?'}/10 (secure?)`,
    `  Usable: ${dims.usable ?? '?'}/10 (good docs?)`,
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

// --- Agent Response Formatting ---

function formatPartialResult(data) {
  const lines = [
    `# Limited Trust Score: ${data.package || 'Unknown Package'}`,
    "",
    `⚠️ **Limited Score — No Source Repo Found**`,
    `Score based on npm registry metadata only (${data.signalCount}/${data.totalPossibleSignals} signals).`,
    "",
    `**Score:** ${data.composite}/10`,
    `**Tier:** ${formatTier(data.tier)}`,
    "",
    "## Dimensions (limited)",
    formatDimensions(data.dimensions),
    "",
    "## Signals (npm metadata only)",
  ];

  const signalLabels = {
    publish_recency: "Publish Recency",
    publish_cadence: "Publish Cadence",
    download_adoption: "Download Adoption",
    maintainer_count: "Maintainer Count",
    package_age: "Package Age",
    dependency_count: "Dependency Count",
    license_clarity: "License Clarity",
  };

  for (const [key, val] of Object.entries(data.signals || {})) {
    const label = signalLabels[key] || key;
    const v = typeof val === 'number' && !isNaN(val) ? val : 0;
    const bar = "█".repeat(Math.round(v)) + "░".repeat(10 - Math.round(v));
    lines.push(`  ${bar} ${v}/10  ${label}`);
  }

  lines.push(
    "",
    `⚠️ ${data.limitedReason}`,
    "",
    `📦 ${data.meta?.versions || '?'} versions | 👥 ${data.meta?.maintainerCount || '?'} maintainers | 📄 ${data.meta?.license || 'Unknown'}`,
    `📥 ${(data.meta?.npmDownloads || 0).toLocaleString()} downloads/month`,
  );

  if (data.meta?.homepage) {
    lines.push(`🔗 ${data.meta.homepage}`);
  }

  lines.push("", `Scanned at: ${data.scannedAt}`, "Powered by mcpskills.io");
  return lines.join("\n");
}

function formatAgentResponse(data) {
  // Compact agent response (from free tier API)
  const rec = data.recommendation || (data.safe ? 'install' : 'caution');
  const icon = data.safe ? '✅' : data.recommendation === 'blocked' ? '🚫' : '⚠️';

  const lines = [
    `${icon} ${data.safe ? 'SAFE to install' : 'CAUTION'} — ${formatTier(data.tier)} (${data.score}/10)`,
    `Recommendation: ${rec}`,
  ];

  if (data.flags?.length > 0) {
    lines.push(`Flags: ${data.flags.join(', ')}`);
  }

  if (data.reasoning) {
    lines.push(`Analysis: ${data.reasoning}`);
  }

  if (data.certified) {
    lines.push('🏅 Certified Safe by MCP Skills');
  }

  lines.push('', 'Set MCPSKILLS_API_KEY for full 14-signal breakdown.');

  return lines.join('\n');
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

  for (const [key, val] of Object.entries(data.signals || {})) {
    const label = signalLabels[key] || key;
    const v = typeof val === 'number' && !isNaN(val) ? val : 0;
    const bar = "█".repeat(Math.round(v)) + "░".repeat(10 - Math.round(v));
    lines.push(`  ${bar} ${v}/10  ${label}`);
  }

  lines.push(
    "",
    `⭐ ${(data.meta?.stars || 0).toLocaleString()} stars | 🍴 ${(data.meta?.forks || 0).toLocaleString()} forks | 📄 ${data.meta?.license || 'Unknown'}`
  );

  if (data.mode === "skills" && data.skill) {
    lines.push("", `## Skill Details`);
    lines.push(`  Type: ${data.skill.type}`);
    if (data.skill.indicators) lines.push(`  Indicators: ${data.skill.indicators.join(", ")}`);

    // OpenClaw frontmatter
    if (data.skill.frontmatter) {
      lines.push("", `  ### SKILL.md Frontmatter`);
      const fm = data.skill.frontmatter;
      if (fm.name) lines.push(`    Name: ${fm.name}`);
      if (fm.version) lines.push(`    Version: ${fm.version}`);
      if (fm.description) lines.push(`    Description: ${fm.description}`);
      if (data.skill.transparency?.bonus > 0) {
        lines.push(`    🛡️ Transparency bonus: +${data.skill.transparency.bonus} to tool_safety`);
        const d = data.skill.transparency.details;
        if (d.hasSecuritySection) lines.push(`      ✓ Declares security posture`);
        if (d.hasAllowedTools) lines.push(`      ✓ Lists allowed tools (${d.allowedToolsCount})`);
        if (d.hasRequires) lines.push(`      ✓ Declares requirements`);
      }
    }

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

  if (data.recommendations) {
    lines.push(...formatRecommendations(data.recommendations));
  }

  lines.push("", `Scanned at: ${data.scannedAt}`);
  lines.push("Powered by mcpskills.io");

  return lines.join("\n");
}

function formatSafetyResult(data) {
  if (data.mode !== "skills" || !data.skill) {
    const score = data.composite ?? data.score ?? '?';
    return [
      `# Safety Scan: ${data.repo}`,
      "",
      "This repo was not detected as an AI skill or MCP server.",
      "Safety scanning only runs on repos identified as skills.",
      "",
      `Mode: ${data.mode || 'standard'}`,
      `Score: ${score}/10 | Tier: ${formatTier(data.tier)}`,
    ].join("\n");
  }

  const lines = [
    `# Safety Scan: ${data.repo}`,
    "",
    `**Skill Type:** ${data.skill.type}`,
    `**Safety Score:** ${data.signals?.tool_safety ?? '?'}/10`,
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
    version: "2.2.0",
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
          "Score any AI skill, MCP server, or GitHub repo for trustworthiness. Returns a trust score (0-10) across 4 dimensions: Alive, Legit, Solid, Usable. Accepts: owner/repo, GitHub URL, npm package (npm:@scope/name or @scope/name), Smithery URL, or OpenClaw URL. AI skills get enhanced safety scanning. Set MCPSKILLS_API_KEY for full reports.",
        inputSchema: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description:
                'Any of: "owner/repo", GitHub URL, "npm:@scope/package", "@scope/package", Smithery URL, or OpenClaw URL',
            },
          },
          required: ["repo"],
        },
      },
      {
        name: "scan_safety",
        description:
          "Run a focused safety scan on an AI skill or MCP server. Checks for prompt injection, shell execution, network exfiltration, credential theft, and obfuscated payloads. Accepts any input format (owner/repo, npm package, Smithery URL, etc.).",
        inputSchema: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description:
                'Any of: "owner/repo", GitHub URL, "npm:@scope/package", Smithery URL, or OpenClaw URL',
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
          "Get a trust badge URL for any repo or package. Returns a shields.io-style SVG badge showing the trust score and tier. Embed in READMEs. Badge auto-updates hourly.",
        inputSchema: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description: 'Any of: "owner/repo", GitHub URL, "npm:@scope/package", or Smithery URL',
            },
          },
          required: ["repo"],
        },
      },
      {
        name: "watch_repo",
        description:
          "Start monitoring a repo or package for trust score changes. Alerts when score changes significantly (±0.3 points or tier change). Requires a paid API key.",
        inputSchema: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description: 'Any of: "owner/repo", GitHub URL, "npm:@scope/package", or Smithery URL',
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
      {
        name: "batch_check",
        description:
          "Check up to 5 repos or packages in one call. Returns a trust assessment for each. Requires a Pro API key. Accepts any mix of formats (owner/repo, npm packages, registry URLs).",
        inputSchema: {
          type: "object",
          properties: {
            repos: {
              type: "array",
              items: { type: "string" },
              description: 'Array of repos/packages in any format (max 5). E.g., ["owner/repo", "npm:@scope/pkg", "https://smithery.ai/server/name"]',
            },
          },
          required: ["repos"],
        },
      },
      {
        name: "auto_gate",
        description:
          'Should I install this? Returns a simple go/no-go decision with reasoning. Accepts any format: owner/repo, npm package, Smithery URL, etc. Returns { proceed: true/false, reason: "..." }.',
        inputSchema: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description: 'Any of: "owner/repo", "npm:@scope/package", "@scope/package", Smithery URL, or OpenClaw URL',
            },
          },
          required: ["repo"],
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
        if (!repo || repo.trim().length === 0) {
          return {
            content: [
              {
                type: "text",
                text: 'Missing input. Accepts: "owner/repo", npm package, GitHub URL, Smithery URL, or OpenClaw URL.',
              },
            ],
            isError: true,
          };
        }

        const data = await fetchScore(repo, apiKey);

        // Determine if we got a full response, partial, or agent compact response
        let formatted;
        if (data.limited || data.mode === 'partial') {
          // Partial score — no source repo found
          formatted = formatPartialResult(data);
        } else if (data.signals && data.dimensions) {
          // Full paid response
          formatted = formatFullResult(data);
        } else if (data.safe !== undefined) {
          // Agent compact response
          formatted = formatAgentResponse(data);
        } else {
          // Human free response — format it for the agent
          formatted = `${formatTier(data.tier)} ${data.repo || data.package} — ${data.composite}/10\n\nSet MCPSKILLS_API_KEY for full signal breakdown.`;
        }

        return { content: [{ type: "text", text: formatted }] };
      }

      case "scan_safety": {
        const repo = args.repo;
        if (!repo || repo.trim().length === 0) {
          return {
            content: [
              {
                type: "text",
                text: 'Missing input. Accepts: "owner/repo", npm package, GitHub URL, Smithery URL, or OpenClaw URL.',
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
            const itemName = item.name || `${item.owner}/${item.repo}`;
            const desc = item.description || item.role || "";
            lines.push(`  - **${itemName}** — ${desc}`);
          }
          lines.push("");
        }

        lines.push("---", "All packages vetted by mcpskills.io");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "get_badge": {
        const repo = args.repo;
        if (!repo || repo.trim().length === 0) {
          return {
            content: [{ type: "text", text: 'Missing input. Accepts: "owner/repo", npm package, or registry URL.' }],
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
        if (!repo || repo.trim().length === 0) {
          return {
            content: [{ type: "text", text: 'Missing input. Accepts: "owner/repo", npm package, or registry URL.' }],
            isError: true,
          };
        }
        if (!email || !email.includes("@")) {
          return {
            content: [{ type: "text", text: "Invalid email address." }],
            isError: true,
          };
        }

        const headers = { "Content-Type": "application/json" };
        if (apiKey) headers["X-API-Key"] = apiKey;

        const res = await fetch(`${API_BASE}/monitor`, {
          method: "POST",
          headers,
          body: JSON.stringify({ action: "watch", repo, email }),
        });
        const data = await res.json();

        if (res.status === 403) {
          return {
            content: [{ type: "text", text: data.error || "Monitoring requires a paid plan. Get one at https://mcpskills.io" }],
            isError: true,
          };
        }

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

        const headers = { "Content-Type": "application/json" };
        if (apiKey) headers["X-API-Key"] = apiKey;

        const res = await fetch(`${API_BASE}/monitor`, {
          method: "POST",
          headers,
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

      case "batch_check": {
        const repos = args.repos;
        if (!Array.isArray(repos) || repos.length === 0) {
          return {
            content: [{ type: "text", text: "Provide an array of repos to check." }],
            isError: true,
          };
        }

        if (!apiKey) {
          return {
            content: [{ type: "text", text: "batch_check requires a Pro API key. Set MCPSKILLS_API_KEY env var.\nGet one at https://mcpskills.io" }],
            isError: true,
          };
        }

        const batch = repos.slice(0, 5);
        const results = [];

        for (const repo of batch) {
          if (!repo || repo.trim().length === 0) {
            results.push(`❌ (empty) — invalid input`);
            continue;
          }
          try {
            const data = await fetchScore(repo, apiKey);
            if (data.safe !== undefined) {
              const icon = data.safe ? '✅' : data.recommendation === 'blocked' ? '🚫' : '⚠️';
              results.push(`${icon} ${repo} — ${data.tier} (${data.score}/10) → ${data.recommendation}`);
            } else if (data.signals) {
              results.push(`${formatTier(data.tier)} ${repo} — ${data.composite}/10`);
            } else {
              results.push(`${formatTier(data.tier)} ${repo} — ${data.composite}/10`);
            }
          } catch (err) {
            results.push(`❌ ${repo} — ${err.message}`);
          }
        }

        const lines = [
          `# Batch Trust Check (${batch.length} repos)`,
          "",
          ...results,
          "",
          `Checked ${batch.length} of ${repos.length} repos.`,
        ];

        if (repos.length > 5) {
          lines.push(`⚠️ Max 5 per batch. ${repos.length - 5} skipped.`);
        }

        lines.push("", "---", "Powered by mcpskills.io");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "auto_gate": {
        const repo = args.repo;
        if (!repo || repo.trim().length === 0) {
          return {
            content: [{ type: "text", text: 'Missing input. Accepts: "owner/repo", npm package, or registry URL.' }],
            isError: true,
          };
        }

        const data = await fetchScore(repo, apiKey);

        let proceed, reason;

        if (data.safe !== undefined) {
          // Agent compact response
          proceed = data.safe || data.certified;
          if (data.certified) {
            reason = `Certified Safe — verified by MCP Skills (${data.score}/10)`;
          } else if (data.safe) {
            reason = `${data.tier} (${data.score}/10). ${data.reasoning || 'No disqualifiers.'}`;
          } else {
            reason = `${data.recommendation}: ${data.flags?.join(', ') || data.reasoning || 'Review needed.'}`;
          }
        } else {
          // Full or human response — derive go/no-go
          const tier = data.tier;
          const disqualifiers = data.disqualifiers || [];
          proceed = (tier === 'verified' || tier === 'established') && disqualifiers.length === 0;
          const score = data.composite ?? data.score;
          reason = proceed
            ? `${tier} (${score}/10). Safe to install.`
            : `${tier} (${score}/10). ${disqualifiers.length ? 'Disqualifiers: ' + disqualifiers.join(', ') : 'Review recommended.'}`;
        }

        const icon = proceed ? '✅' : '🚫';
        const text = [
          `${icon} ${proceed ? 'PROCEED' : 'DO NOT INSTALL'} — ${repo}`,
          '',
          reason,
        ].join('\n');

        return { content: [{ type: "text", text }] };
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
