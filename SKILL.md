---
name: mcpskills
version: 2.1.0
description: Trust-score any AI skill or MCP server with 14 signals across 4 dimensions. Safety scanning for prompt injection, credential theft, shell execution, network exfiltration, and obfuscated payloads.
transport: stdio
runtime: node
security:
  - GitHub API read-only access (public repo metadata, files, issues)
  - OpenSSF Scorecard API read-only access
  - npm registry read-only access
  - No credential storage or persistence
  - No network exfiltration
  - No shell execution
credentials:
  - name: MCPSKILLS_API_KEY
    required: false
    description: Optional API key for full 14-signal reports. Free tier returns trust tier + dimensions.
    format: "msk_" followed by 32 hex characters
allowed-tools:
  - name: check_trust_score
    description: Score any GitHub repo for trustworthiness (0-10 across 4 dimensions)
    input: repo (owner/repo format)
    output: Trust score, tier, dimensions, signals, safety findings, recommendations
  - name: scan_safety
    description: Focused safety scan for AI skills and MCP servers
    input: repo (owner/repo format)
    output: 5 safety checks with file-level findings
  - name: list_packages
    description: Browse curated, pre-scored skill packages by use case
    input: none
    output: Categorized package listings with trust scores
  - name: get_badge
    description: Generate SVG trust badge URL for READMEs
    input: repo (owner/repo format)
    output: Badge URL and markdown embed code
  - name: watch_repo
    description: Start monitoring a repo for trust score changes (paid)
    input: repo, email
    output: Confirmation with monitoring details
  - name: check_watched
    description: Re-scan all watched repos and report changes
    input: email
    output: Updated scores with delta highlights
  - name: batch_check
    description: Score up to 5 repos in one call (Pro tier)
    input: repos (array of owner/repo)
    output: Array of trust scores
  - name: auto_gate
    description: Boolean go/no-go decision with reasoning
    input: repo (owner/repo format)
    output: safe (boolean), reasoning, flags
requires:
  - Node.js >= 18.0.0
  - @modelcontextprotocol/sdk >= 1.12.0
---

# mcpskills MCP Server

Trust-score any AI skill or MCP server from inside Claude Code, Cursor, or any MCP client.

## What It Does

Scores GitHub repos across **14 signals** grouped into **4 dimensions**:

| Dimension | Question | Signals |
|-----------|----------|---------|
| **Alive** | Is it maintained? | Commit recency, release cadence, issue responsiveness |
| **Legit** | Is the author credible? | Author credibility, community adoption, contributor diversity, downloads |
| **Solid** | Is it secure? | Security posture, dependency health, tool safety, supply chain safety |
| **Usable** | Is it well documented? | README quality, spec compliance, license clarity |

AI skills and MCP servers get **enhanced scanning** with 5 safety checks:
1. Prompt injection (hidden instructions, zero-width chars)
2. Shell execution (piped curl, eval with network content)
3. Network exfiltration (Discord webhooks, Telegram, ngrok)
4. Credential access (SSH keys, AWS creds, browser storage)
5. Obfuscated payloads (base64, hex encoding, charCode chains)

## Trust Tiers

- **Verified** (>= 7.0): High confidence, meets all dimension thresholds
- **Established** (>= 4.5): Moderate confidence, sufficient signal coverage
- **New** (< 4.5): Insufficient data or low scores
- **Blocked**: Disqualifiers present (no license, critical CVE, dangerous workflow, safety block)

## Install

```bash
claude mcp add mcpskills -- npx @mcpskillsio/server
```

## API Key (Optional)

Free tier returns trust tier + dimension scores. For full 14-signal reports:

```bash
export MCPSKILLS_API_KEY=your_key_here
```

Get your key at [mcpskills.io](https://mcpskills.io).
