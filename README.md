# mcpskills

[![Trust Score](https://mcpskills.io/badge/BeBraveBeKind/mcpskills)](https://mcpskills.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@mcpskillsio/server)](https://www.npmjs.com/package/@mcpskillsio/server)

Trust-score any AI skill or MCP server. 14 signals across 4 dimensions with safety scanning for prompt injection, credential theft, and supply chain attacks.

**Website:** [mcpskills.io](https://mcpskills.io)

## How It Works

mcpskills scores GitHub repos across 4 dimensions:

- **Alive** — Is it maintained? (commit recency, release cadence, issue responsiveness)
- **Legit** — Is the author credible? (author credibility, community adoption, contributor diversity)
- **Solid** — Is it secure? (security posture, dependency health, tool safety, supply chain safety)
- **Usable** — Is it well documented? (README quality, spec compliance, license clarity)

AI skills and MCP servers get **enhanced scanning** with 5 safety checks based on [ClawHavoc](https://mcpskills.io/blog/clawhavoc-missing-trust-layer) and ToxicSkills attack patterns.

## Quick Start

### MCP Server (Claude Code, Cursor, Claude Desktop)

Install the MCP server to score repos directly from your IDE:

```bash
claude mcp add mcpskills -- npx @mcpskillsio/server
```

See [mcp-server/README.md](mcp-server/README.md) for Cursor and Claude Desktop setup.

### Website

Scan any repo at [mcpskills.io](https://mcpskills.io) — free, no signup required.

### API

```bash
curl -X POST https://mcpskills.io/api/score \
  -H "Content-Type: application/json" \
  -d '{"repo": "anthropics/anthropic-sdk-typescript"}'
```

## Architecture

```
mcpskills/
  mcp-server/          # npm package (@mcpskillsio/server) — 8 MCP tools
  lib/                 # Shared core: scorer (14 signals), skills detector, safety scanner
  netlify/functions/   # Serverless API (score, badge, monitor, certify, webhook)
  public/              # Static website (mcpskills.io)
  data/                # Registry, score cache, curated packages
  scripts/             # CLI utilities
```

| Component | Purpose |
|-----------|---------|
| **MCP Server** | IDE integration — score repos from Claude Code, Cursor, or any MCP client |
| **API** | REST endpoints for scoring, badges, monitoring, certification |
| **Website** | Live scanner, blog, trust badge generator |
| **Scheduled Functions** | Nightly crawl (2am UTC), daily monitoring (8am UTC), weekly digest (Sunday 6pm UTC) |

## MCP Tools

| Tool | Description |
|------|-------------|
| `check_trust_score` | Score any GitHub repo (0-10, 4 dimensions, 14 signals) |
| `scan_safety` | Focused safety scan for AI skills (5 threat categories) |
| `list_packages` | Browse curated, pre-scored skill packages |
| `get_badge` | Generate SVG trust badge for READMEs |
| `watch_repo` | Monitor repos for trust score changes |
| `check_watched` | Re-scan all watched repos |
| `batch_check` | Score up to 5 repos in one call |
| `auto_gate` | Boolean go/no-go decision with reasoning |

## Trust Tiers

| Tier | Score | Meaning |
|------|-------|---------|
| Verified | >= 7.0 | High confidence across all dimensions |
| Established | >= 4.5 | Moderate confidence, sufficient signals |
| New | < 4.5 | Insufficient data or low scores |
| Blocked | — | Disqualifiers: no license, critical CVE, dangerous workflows |

## API Key

Free tier returns trust tier + dimension scores. For full 14-signal reports with safety findings:

```bash
export MCPSKILLS_API_KEY=your_key_here
```

Get your key at [mcpskills.io/api](https://mcpskills.io/api).

## License

[MIT](LICENSE) — Built by [Michael Browne](https://linkedin.com/in/michaelbrowne03/) at [Rise Above Partners](https://rise-above.net).
