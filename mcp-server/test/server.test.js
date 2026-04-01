import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "index.js");
const pkgPath = join(__dirname, "..", "package.json");

const serverSource = readFileSync(serverPath, "utf-8");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

describe("package.json", () => {
  it("has required fields", () => {
    assert.ok(pkg.name, "missing name");
    assert.ok(pkg.version, "missing version");
    assert.ok(pkg.description, "missing description");
    assert.ok(pkg.license, "missing license");
    assert.ok(pkg.author, "missing author");
    assert.ok(pkg.repository, "missing repository");
    assert.ok(pkg.keywords?.length > 0, "missing keywords");
  });

  it("declares MCP SDK dependency", () => {
    assert.ok(
      pkg.dependencies["@modelcontextprotocol/sdk"],
      "missing @modelcontextprotocol/sdk dependency"
    );
  });

  it("has mcp keyword for skill detection", () => {
    assert.ok(pkg.keywords.includes("mcp"), 'missing "mcp" keyword');
  });
});

describe("MCP tool definitions", () => {
  const expectedTools = [
    "check_trust_score",
    "scan_safety",
    "list_packages",
    "get_badge",
    "watch_repo",
    "check_watched",
    "batch_check",
    "auto_gate",
  ];

  for (const tool of expectedTools) {
    it(`defines tool: ${tool}`, () => {
      assert.ok(
        serverSource.includes(`name: "${tool}"`),
        `tool "${tool}" not found in server source`
      );
    });
  }

  it("has 8 tools total", () => {
    const matches = serverSource.match(/name: "(?:check_trust_score|scan_safety|list_packages|get_badge|watch_repo|check_watched|batch_check|auto_gate)"/g);
    assert.equal(matches?.length, 8, `expected 8 tools, found ${matches?.length}`);
  });
});

describe("server configuration", () => {
  it("sets server name to mcpskills", () => {
    assert.ok(
      serverSource.includes('name: "mcpskills"'),
      "server name not set to mcpskills"
    );
  });

  it("version matches package.json", () => {
    assert.ok(
      serverSource.includes(`version: "${pkg.version}"`),
      `server version doesn't match package.json (${pkg.version})`
    );
  });

  it("uses StdioServerTransport", () => {
    assert.ok(
      serverSource.includes("StdioServerTransport"),
      "missing StdioServerTransport"
    );
  });
});

describe("format helpers", () => {
  // Extract and test formatDimensions null safety
  it("formatDimensions handles null input", () => {
    // The function should have a null guard
    assert.ok(
      serverSource.includes("if (!dims)"),
      "formatDimensions missing null guard for dims parameter"
    );
  });

  it("formatDimensions uses nullish coalescing", () => {
    // Should use ?? for safe property access
    assert.ok(
      serverSource.includes("dims.alive ??") || serverSource.includes("dims.alive??"),
      "formatDimensions should use ?? for alive dimension"
    );
  });
});

describe("security", () => {
  it("does not hardcode API keys", () => {
    // Ensure no hardcoded msk_ keys in source
    const keyPattern = /msk_[a-f0-9]{32}/;
    assert.ok(
      !keyPattern.test(serverSource),
      "found hardcoded API key in server source"
    );
  });

  it("reads API key from environment", () => {
    assert.ok(
      serverSource.includes("process.env.MCPSKILLS_API_KEY"),
      "should read API key from MCPSKILLS_API_KEY env var"
    );
  });
});
