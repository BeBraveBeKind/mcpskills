/**
 * MCP Skills — Skill-Specific Signals
 * Signal 11: Skill Spec Compliance
 * Signal 12: Tool Safety Analysis
 *
 * These activate when a repo is detected as an AI skill or MCP server.
 */

// --- Skill Detection ---

/**
 * Determine if a repo is a skill/MCP server based on its file tree.
 * Returns { isSkill, skillType, indicators }
 */
function detectSkill(treeData, packageJsonContent, repoData) {
  if (!treeData) return { isSkill: false, skillType: null, indicators: [] };

  const files = (treeData.tree || []).map(f => (f.path || '').toLowerCase());
  const indicators = [];

  // Check repo name, description, AND owner name for MCP/skill keywords
  if (repoData) {
    const ownerName = (repoData.owner?.login || repoData.full_name || '').toLowerCase();
    const nameDesc = (ownerName + ' ' + (repoData.name || '') + ' ' + (repoData.description || '')).toLowerCase();
    if (nameDesc.includes('mcp') || nameDesc.includes('model context protocol') ||
        nameDesc.includes('model-context-protocol') || nameDesc.includes('modelcontextprotocol') ||
        nameDesc.includes('agent-skill') || nameDesc.includes('agent skill') ||
        nameDesc.includes('mcp-server') || nameDesc.includes('mcp server')) {
      indicators.push('repo-metadata-mcp');
    }
  }

  // Check topics
  if (repoData?.topics) {
    const topics = repoData.topics.map(t => t.toLowerCase());
    if (topics.some(t => t.includes('mcp') || t.includes('agent-skill'))) {
      indicators.push('github-topic-mcp');
    }
  }

  // Check for SKILL.md
  const hasSkillMd = files.some(f => f === 'skill.md' || f.endsWith('/skill.md'));
  if (hasSkillMd) indicators.push('SKILL.md');

  // Check for server.json / mcp.json
  const hasServerJson = files.some(f =>
    f === 'server.json' || f === 'mcp.json' || f.endsWith('/server.json')
  );
  if (hasServerJson) indicators.push('server.json');

  // Check for MCP-related tool definitions
  const hasToolDefs = files.some(f =>
    (f.startsWith('tools/') && (f.endsWith('.json') || f.endsWith('.yaml'))) ||
    f === 'tools.json' || f === 'tools.yaml'
  );
  if (hasToolDefs) indicators.push('tool-definitions');

  // Check package.json for MCP keywords
  if (packageJsonContent) {
    const lower = packageJsonContent.toLowerCase();
    if (lower.includes('"mcp"') || lower.includes('model-context-protocol') ||
        lower.includes('mcp-server') || lower.includes('agent-skill')) {
      indicators.push('package.json-mcp-keyword');
    }
  }

  // Check for MCP publisher workflow
  const hasMcpPublisher = files.some(f =>
    f.includes('mcp-publish') || f.includes('mcp_publish')
  );
  if (hasMcpPublisher) indicators.push('mcp-publisher-workflow');

  // Check for common MCP server patterns
  const hasMcpSrc = files.some(f =>
    f.includes('mcp-server') || f.includes('mcpserver') ||
    f.includes('/mcp/') || f === 'src/index.ts' || f === 'src/index.js'
  );
  const hasMcpInReadme = files.some(f => f === 'readme.md' || f === 'skill.md');

  // Determine skill type — SKILL.md is the primary signal (agent-skill),
  // MCP server metadata is secondary. SKILL.md repos get highest confidence.
  let skillType = null;
  let confidence = 0;
  if (hasSkillMd) {
    skillType = 'agent-skill';
    confidence = 3; // Highest — explicit skill declaration
  } else if (hasServerJson) {
    skillType = 'mcp-server';
    confidence = 2; // Strong — structured MCP metadata
  } else if (indicators.includes('package.json-mcp-keyword')) {
    skillType = 'mcp-server';
    confidence = 2;
  } else if (hasToolDefs) {
    skillType = 'tool-provider';
    confidence = 2;
  } else if (indicators.includes('repo-metadata-mcp') || indicators.includes('github-topic-mcp')) {
    // Repos owned by the official MCP org get higher confidence
    const ownerLogin = (repoData?.owner?.login || '').toLowerCase();
    const isOfficialMcpOrg = ownerLogin === 'modelcontextprotocol';
    skillType = 'mcp-related';
    confidence = isOfficialMcpOrg ? 2 : 1; // Official org repos get full skill treatment
  }

  // Require at least 1 indicator AND a determined type to activate Skills Mode.
  // Metadata-only repos (confidence 1) need 2+ indicators to reduce false positives.
  const isSkill = skillType !== null && (confidence >= 2 || indicators.length >= 2);

  return { isSkill, skillType, indicators };
}

// --- Signal 11: Skill Spec Compliance ---

/**
 * Score how well the skill follows established standards.
 * 5 checks, 2 points each, max 10. Bonus for MCP Registry listing.
 */
function scoreSkillSpecCompliance(treeData, skillMdContent, serverJsonContent, packageJsonContent) {
  if (!treeData) return { score: 0, checks: {} };

  const files = (treeData.tree || []).map(f => (f.path || '').toLowerCase());
  let score = 0;
  const checks = {};

  // Check 1: Spec file exists (2 pts)
  const hasSpecFile = files.some(f =>
    f === 'skill.md' || f.endsWith('/skill.md') ||
    f === 'server.json' || f === 'mcp.json'
  );
  checks.specFileExists = hasSpecFile;
  if (hasSpecFile) score += 2;

  // Check 2: Identity fields — name, version, description (2 pts)
  let hasIdentity = false;
  if (serverJsonContent) {
    try {
      const sj = JSON.parse(serverJsonContent);
      hasIdentity = !!(sj.name && sj.version && sj.description);
    } catch {}
  }
  if (!hasIdentity && skillMdContent) {
    // SKILL.md uses markdown headings and frontmatter
    const lower = skillMdContent.toLowerCase();
    const hasName = /^#\s+\S/m.test(skillMdContent); // Has a heading
    const hasDesc = skillMdContent.length > 100; // Has meaningful content
    hasIdentity = hasName && hasDesc;
  }
  if (!hasIdentity && packageJsonContent) {
    try {
      const pj = JSON.parse(packageJsonContent);
      hasIdentity = !!(pj.name && pj.version && pj.description);
    } catch {}
  }
  checks.identityFields = hasIdentity;
  if (hasIdentity) score += 2;

  // Check 3: Tool definitions documented (2 pts)
  let hasToolDocs = false;
  if (serverJsonContent) {
    try {
      const sj = JSON.parse(serverJsonContent);
      hasToolDocs = !!(sj.tools && Array.isArray(sj.tools) && sj.tools.length > 0);
    } catch {}
  }
  if (!hasToolDocs && skillMdContent) {
    const lower = skillMdContent.toLowerCase();
    hasToolDocs = (lower.includes('## tools') || lower.includes('## commands') ||
                   lower.includes('## capabilities') || lower.includes('## functions'));
  }
  if (!hasToolDocs) {
    hasToolDocs = files.some(f =>
      (f.startsWith('tools/') || f === 'tools.json') &&
      (f.endsWith('.json') || f.endsWith('.yaml'))
    );
  }
  checks.toolDefinitions = hasToolDocs;
  if (hasToolDocs) score += 2;

  // Check 4: Install/config instructions (2 pts)
  let hasInstall = false;
  const allContent = [skillMdContent, serverJsonContent, packageJsonContent]
    .filter(Boolean).join(' ').toLowerCase();
  if (allContent.includes('install') || allContent.includes('getting started') ||
      allContent.includes('setup') || allContent.includes('configuration') ||
      allContent.includes('npx') || allContent.includes('npm install')) {
    hasInstall = true;
  }
  // server.json with package info counts
  if (serverJsonContent) {
    try {
      const sj = JSON.parse(serverJsonContent);
      if (sj.packages || sj.repository || sj.npm) hasInstall = true;
    } catch {}
  }
  checks.installInstructions = hasInstall;
  if (hasInstall) score += 2;

  // Check 5: Transport/runtime specified (2 pts)
  let hasTransport = false;
  if (serverJsonContent) {
    try {
      const sj = JSON.parse(serverJsonContent);
      hasTransport = !!(sj.transport || sj.runtime || sj.command);
    } catch {}
  }
  if (!hasTransport && skillMdContent) {
    const lower = skillMdContent.toLowerCase();
    hasTransport = (lower.includes('stdio') || lower.includes('http') ||
                    lower.includes('transport') || lower.includes('npx') ||
                    lower.includes('docker'));
  }
  checks.transportSpecified = hasTransport;
  if (hasTransport) score += 2;

  return { score: Math.min(score, 10), checks };
}

// --- Signal 12: Tool Safety Analysis ---

// Threat pattern definitions
const THREAT_PATTERNS = {
  // Check 1: Prompt injection patterns
  promptInjection: {
    severity: 'critical',
    penalty: 3.0,
    patterns: [
      // Hidden HTML comments with instructions
      /<!--[\s\S]*?(ignore\s+previous|system\s*:|you\s+are\s+now|override|forget\s+your|new\s+instructions)/i,
      // Direct injection phrases (in markdown, not code)
      /(?:^|\n)[^`]*(?:ignore\s+(?:all\s+)?previous\s+instructions|you\s+are\s+now\s+a|override\s+system\s+prompt|disregard\s+(?:all\s+)?prior)/i,
      // Zero-width characters (potential hidden text)
      /[\u200B\u200C\u200D\uFEFF\u2060]{3,}/,
      // RTL override characters (text direction manipulation)
      /[\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069]{2,}/,
    ],
  },

  // Check 2: Shell execution patterns
  shellExecution: {
    severity: 'high',
    penalty: 2.0,
    patterns: [
      // Piped execution from network
      /curl\s+[^\n]*\|\s*(?:sh|bash|zsh|python)/i,
      /wget\s+[^\n]*\|\s*(?:sh|bash|zsh|python)/i,
      // Base64 decode to execution
      /base64\s+(?:-d|--decode)\s*\|\s*(?:sh|bash)/i,
      // Eval with dynamic content (not in test files)
      /eval\s*\(\s*(?:fetch|require|import|process|Buffer)/i,
      // Python dangerous exec
      /(?:exec|eval)\s*\(\s*(?:compile|__import__|open|requests\.get)/i,
      // os.system with variable interpolation
      /os\.system\s*\(\s*f['"]/i,
    ],
  },

  // Check 3: Network exfiltration
  networkExfiltration: {
    severity: 'high',
    penalty: 2.0,
    patterns: [
      // Discord webhooks (common exfil channel)
      /discord(?:app)?\.com\/api\/webhooks\//i,
      // Telegram bot API
      /api\.telegram\.org\/bot/i,
      // Ngrok tunnels
      /[a-z0-9]+\.ngrok\.io/i,
      // Raw IP addresses with port (potential C2)
      /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)/,
      // Pastebin/hastebin (data exfil)
      /(?:pastebin|hastebin|paste\.ee|dpaste)\.com/i,
    ],
  },

  // Check 4: Credential access
  credentialAccess: {
    severity: 'high',
    penalty: 2.5,
    patterns: [
      // Reading SSH keys
      /(?:readFile|readFileSync|open)\s*\([^)]*\.ssh\//i,
      // AWS credentials
      /(?:readFile|readFileSync|open)\s*\([^)]*\.aws\/credentials/i,
      // Browser credential stores
      /(?:Login\s+Data|Cookies|Local\s+State|Keychain)/i,
      // Broad env file access patterns beyond normal
      /(?:readFile|readFileSync|open)\s*\([^)]*(?:\.env\.local|\.env\.production)/i,
      // Clipboard access (steal copied content)
      /(?:clipboard|pbcopy|pbpaste|xclip|xsel)/i,
    ],
  },

  // Check 5: Obfuscation patterns
  obfuscation: {
    severity: 'medium',
    penalty: 1.5,
    patterns: [
      // Long base64 strings (potential encoded payloads)
      /[A-Za-z0-9+\/]{100,}={0,2}/,
      // Hex-encoded strings > 50 chars
      /\\x[0-9a-f]{2}(?:\\x[0-9a-f]{2}){24,}/i,
      // String.fromCharCode chains (building strings to avoid detection)
      /String\.fromCharCode\s*\([^)]{20,}\)/,
      // Multiple layers of encoding
      /atob\s*\(\s*atob/i,
      /Buffer\.from\s*\(\s*Buffer\.from/i,
    ],
  },
};

// Files to exclude from safety scanning (test files, docs, etc.)
const SAFE_FILE_PATTERNS = [
  /^test[s]?\//i,
  /^__tests__\//i,
  /\.test\./i,
  /\.spec\./i,
  /^docs?\//i,
  /^examples?\//i,
  /^node_modules\//i,
  /\.lock$/i,
  /\.md$/i, // Markdown checked separately for prompt injection only
];

/**
 * Run all 5 safety checks against file contents.
 * Returns { score, findings, summary }
 */
function scoreToolSafety(fileContents, markdownContents) {
  const BASELINE = 8.0;
  let totalPenalty = 0;
  const findings = [];

  // Scan markdown files for prompt injection (Check 1 only)
  for (const [filename, content] of Object.entries(markdownContents || {})) {
    for (const pattern of THREAT_PATTERNS.promptInjection.patterns) {
      const match = content.match(pattern);
      if (match) {
        findings.push({
          check: 'prompt_injection',
          severity: 'critical',
          file: filename,
          snippet: match[0].substring(0, 100),
          penalty: THREAT_PATTERNS.promptInjection.penalty,
        });
        totalPenalty += THREAT_PATTERNS.promptInjection.penalty;
      }
    }
  }

  // Scan source files for all threat patterns
  for (const [filename, content] of Object.entries(fileContents || {})) {
    // Skip safe files
    if (SAFE_FILE_PATTERNS.some(p => p.test(filename))) continue;

    for (const [checkName, check] of Object.entries(THREAT_PATTERNS)) {
      if (checkName === 'promptInjection') continue; // Already handled via markdown

      for (const pattern of check.patterns) {
        const match = content.match(pattern);
        if (match) {
          findings.push({
            check: checkName,
            severity: check.severity,
            file: filename,
            snippet: match[0].substring(0, 100),
            penalty: check.penalty,
          });
          totalPenalty += check.penalty;
          break; // One finding per check per file is enough
        }
      }
    }
  }

  // Cap: 2+ prompt injection findings = max penalty
  const injectionCount = findings.filter(f => f.check === 'prompt_injection').length;
  if (injectionCount >= 2) totalPenalty = Math.max(totalPenalty, 7.0);

  const score = Math.max(0, Math.min(10, BASELINE - totalPenalty));

  // Classify
  const hasCritical = findings.some(f => f.severity === 'critical');
  const summary = score === 0 ? 'BLOCKED — confirmed threat patterns'
    : hasCritical ? 'Critical safety concerns detected'
    : findings.length > 0 ? `${findings.length} concern(s) flagged`
    : 'Clean — no threat patterns detected';

  return { score, findings, summary, isBlocked: score === 0 };
}

/**
 * Fetch key source files for safety scanning.
 * Returns { fileContents, markdownContents } with filename→content maps.
 * Selective: only fetches files likely to contain threats.
 */
async function fetchScanTargets(owner, repo, treeData, token) {
  if (!treeData) return { fileContents: {}, markdownContents: {} };

  const ghApi = async (path) => {
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'MCPSkills-Scorer/1.0',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const res = await fetch(`https://api.github.com${path}`, { headers });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  };

  const files = (treeData.tree || []).map(f => f.path || '');

  // Select markdown files to scan (SKILL.md, README.md, and any root .md files)
  const mdTargets = files.filter(f =>
    /^(?:skill|readme|contributing|install|setup)\.md$/i.test(f) ||
    f.toLowerCase() === 'skill.md'
  ).slice(0, 5);

  // Select source files to scan — entry points and config
  const srcTargets = files.filter(f => {
    const lower = f.toLowerCase();
    // Entry points
    if (/^(?:src\/)?index\.[jt]s$/.test(lower)) return true;
    if (/^(?:src\/)?main\.[jt]s$/.test(lower)) return true;
    if (/^(?:src\/)?server\.[jt]s$/.test(lower)) return true;
    if (/^(?:src\/)?app\.[jt]s$/.test(lower)) return true;
    // Python entry
    if (/^(?:src\/)?(?:main|server|app|__main__)\.py$/.test(lower)) return true;
    // Shell scripts at root
    if (/^[^/]+\.sh$/.test(lower)) return true;
    // MCP/skill config
    if (lower === 'server.json' || lower === 'mcp.json') return true;
    // package.json scripts (can contain exec commands)
    if (lower === 'package.json') return true;
    return false;
  }).slice(0, 8);

  // Fetch in parallel
  const fetchFile = async (filepath) => {
    const data = await ghApi(`/repos/${owner}/${repo}/contents/${encodeURIComponent(filepath)}`);
    if (!data || !data.content) return null;
    try {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    } catch { return null; }
  };

  const [mdResults, srcResults] = await Promise.all([
    Promise.all(mdTargets.map(async f => [f, await fetchFile(f)])),
    Promise.all(srcTargets.map(async f => [f, await fetchFile(f)])),
  ]);

  const markdownContents = Object.fromEntries(
    mdResults.filter(([, content]) => content !== null)
  );
  const fileContents = Object.fromEntries(
    srcResults.filter(([, content]) => content !== null)
  );

  return { fileContents, markdownContents };
}

module.exports = {
  detectSkill,
  scoreSkillSpecCompliance,
  scoreToolSafety,
  fetchScanTargets,
  THREAT_PATTERNS,
};
