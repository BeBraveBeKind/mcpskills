# @mcpskillsio/server

Trust-score any AI skill or MCP server from inside Claude Code, Cursor, or any MCP client.

14 signals across 4 dimensions with safety scanning for prompt injection, credential theft, and supply chain attacks.

## Install

### Claude Code

```bash
claude mcp add mcpskills -- npx @mcpskillsio/server
```

### Cursor

Add to your `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mcpskills": {
      "command": "npx",
      "args": ["@mcpskillsio/server"]
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcpskills": {
      "command": "npx",
      "args": ["@mcpskillsio/server"]
    }
  }
}
```

## Tools

### `check_trust_score`

Score any GitHub repo. Returns trust tier, composite score, and 4 dimension scores.

```
"Score anthropics/anthropic-sdk-typescript"
```

### `scan_safety`

Focused safety scan for AI skills. Checks for prompt injection, shell execution, network exfiltration, credential theft, and obfuscated payloads.

```
"Is this MCP server safe? modelcontextprotocol/servers"
```

### `list_packages`

Browse curated, pre-scored skill packages organized by use case.

```
"Show me safe AI skill packages for full-stack development"
```

### `get_badge`

Generate an SVG trust badge URL for your README.

```
"Get a trust badge for my repo anthropics/anthropic-sdk-typescript"
```

### `watch_repo`

Start monitoring a repo for trust score changes (requires API key).

```
"Watch modelcontextprotocol/servers for score changes"
```

### `batch_check`

Score up to 5 repos in a single call (Pro tier).

```
"Batch check these repos: anthropics/anthropic-sdk-typescript, langchain-ai/langchainjs"
```

### `auto_gate`

Get a boolean go/no-go decision with reasoning.

```
"Should I install this MCP server? 21st-dev/magic-mcp"
```

## Full Reports

Free tier returns trust tier + dimension scores (same as mcpskills.io free scans).

For full 14-signal reports with detailed safety findings inside your IDE, set your API key:

```bash
export MCPSKILLS_API_KEY=your_key_here
```

Get your API key at [mcpskills.io/api](https://mcpskills.io/api).

## How It Works

The server calls the mcpskills.io trust scoring API, which:

1. Fetches repo data from GitHub API and OpenSSF Scorecard
2. Scores 14 signals across 4 dimensions (Alive, Legit, Solid, Usable)
3. Detects AI skills/MCP servers and activates Skills Mode (+2 bonus signals)
4. Runs 5 safety scans based on ClawHavoc and ToxicSkills attack patterns
5. Assigns a trust tier: Verified (>=7.0), Established (>=4.5), New, or Blocked

## License

MIT — Built by [Michael Browne](https://linkedin.com/in/michaelbrowne03/) at [Rise Above Partners](https://rise-above.net).
