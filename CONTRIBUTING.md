# Contributing to mcpskills

Thanks for your interest in contributing to mcpskills.

## Development Setup

```bash
git clone https://github.com/BeBraveBeKind/mcpskills.git
cd mcpskills
npm install
cd mcp-server && npm install
```

### Running locally

```bash
# Website + API (Netlify Dev)
npm run dev

# MCP server (standalone)
cd mcp-server && npm start
```

### Running tests

```bash
cd mcp-server && npm test
```

## Project Structure

```
mcpskills/
  lib/           # Shared libraries (scorer, skills detector, auth, recommender)
  mcp-server/    # MCP server npm package (@mcpskillsio/server)
  netlify/functions/  # Serverless API endpoints
  public/        # Static website (mcpskills.io)
  data/          # Registry, score cache, packages
  scripts/       # CLI utilities (scan, batch-scan)
```

## Pull Request Process

1. Fork the repo and create a feature branch from `main`
2. Make your changes with clear, descriptive commits
3. Ensure tests pass: `cd mcp-server && npm test`
4. Update documentation if your change affects the API or MCP tools
5. Open a PR with a description of what changed and why

## Code Style

- Vanilla JavaScript (no TypeScript, no transpilation)
- No external linters enforced — keep code readable and consistent with existing patterns
- Prefer explicit error handling over silent failures
- Functions should do one thing well

## Reporting Bugs

Open a GitHub issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- MCP client you're using (Claude Code, Cursor, etc.)

## Security Vulnerabilities

See [SECURITY.md](SECURITY.md) for responsible disclosure.
