/**
 * lib/score-any.js — Universal scoring entry point
 *
 * Accepts any input format (owner/repo, npm:pkg, Smithery URL, etc.),
 * resolves to a GitHub repo via lib/resolver.js, scores via lib/scorer.js,
 * and falls back to lib/partial-scorer.js when no source repo exists.
 *
 * Every downstream caller should use scoreAny() instead of scoreRepo() directly.
 */

const { resolve } = require('./resolver');
const { scoreRepo } = require('./scorer');
const { partialScore } = require('./partial-scorer');

/**
 * Score any input — GitHub repo, npm package, Smithery URL, OpenClaw skill, etc.
 *
 * @param {string} input     - Any supported format
 * @param {string|null} token - GitHub API token
 * @param {object} [opts]    - Options
 * @param {boolean} [opts.skipPartial] - If true, don't attempt partial scoring for unresolvable inputs
 * @returns {object} - Full or partial score result
 *   Always includes: .inputType
 *   For resolved repos: .repo, .resolvedFrom (if not github), standard scoreRepo fields
 *   For partial scores: .limited, .limitedReason, .package, .mode='partial'
 *   On failure: .error, .inputType
 */
async function scoreAny(input, token, opts = {}) {
  if (!input || typeof input !== 'string' || input.trim().length === 0) {
    return { error: 'Empty input', inputType: 'invalid' };
  }

  // Resolve input to a GitHub repo or npm metadata
  const resolution = await resolve(input);

  if (resolution.inputType === 'invalid') {
    return { error: resolution.error, inputType: 'invalid' };
  }

  // --- Full scoring path: source repo found ---
  if (resolution.repo) {
    const [owner, repo] = resolution.repo.split('/');
    const result = await scoreRepo(owner, repo, token);

    if (result.error) {
      return { error: result.error, inputType: resolution.inputType };
    }

    // Attach resolution metadata when input wasn't already owner/repo
    result.inputType = resolution.inputType;
    if (resolution.inputType !== 'github') {
      result.resolvedFrom = {
        input,
        inputType: resolution.inputType,
        packageName: resolution.packageName,
      };
    }

    return result;
  }

  // --- Partial scoring path: no source repo, but npm metadata available ---
  if (!opts.skipPartial && resolution.npmMeta && resolution.packageName) {
    const result = await partialScore(resolution.packageName, resolution.npmMeta);
    if (result.error) {
      return { error: result.error, inputType: resolution.inputType };
    }
    result.inputType = resolution.inputType;
    return result;
  }

  // --- No resolution possible ---
  return {
    error: resolution.error || 'Could not resolve to a source repository. Trust scoring requires source code access.',
    inputType: resolution.inputType,
  };
}

module.exports = { scoreAny };
