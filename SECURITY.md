# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | Yes       |
| 1.x     | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in mcpskills, please report it responsibly.

**Email:** security@mcpskills.io

**What to include:**
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

**Response timeline:**
- Acknowledgement within 48 hours
- Initial assessment within 5 business days
- Fix timeline communicated within 10 business days

## Scope

The following are in scope for security reports:

- Trust scoring API (`/api/score`, `/api/batch-scan`)
- MCP server tool implementations (`@mcpskillsio/server`)
- Safety scanning logic (prompt injection, credential theft, exfiltration detection)
- Authentication and API key handling
- Payment webhook verification (LemonSqueezy)
- Data storage (Netlify Blobs)

## Out of Scope

- Trust scoring algorithm methodology (intended behavior, not a vulnerability)
- Free tier rate limits
- Third-party dependencies (report upstream)
- The mcpskills.io marketing website content

## Safe Harbor

We consider security research conducted in good faith to be authorized. We will not pursue legal action against researchers who:

- Make a good faith effort to avoid privacy violations, data destruction, or service disruption
- Report vulnerabilities promptly and provide reasonable time to fix before disclosure
- Do not exploit vulnerabilities beyond what is necessary to demonstrate the issue
