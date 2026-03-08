/**
 * MCP Skills LinkedIn Card Renderer
 * Converts package data into a 1200x630 PNG using Satori + resvg
 */

const satoriModule = require('satori');
const satori = satoriModule.default || satoriModule;
const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const path = require('path');

// Load static font files (variable fonts not supported by satori's opentype parser)
const interRegular = fs.readFileSync(path.join(__dirname, 'fonts', 'Inter-Regular.ttf'));
const interBold = fs.readFileSync(path.join(__dirname, 'fonts', 'Inter-Bold.ttf'));

// Design tokens
const COLORS = {
  bg: '#0D1117',
  surface: '#161B22',
  border: '#30363D',
  textPrimary: '#E6EDF3',
  textSecondary: '#8B949E',
  green: '#3FB950',
  amber: '#D29922',
  blue: '#58A6FF',
  teal: '#39D353',
};

const TIER_CONFIG = {
  verified: { icon: '✅', color: COLORS.green, label: 'verified' },
  established: { icon: '🟡', color: COLORS.amber, label: 'established' },
  new: { icon: '🔵', color: COLORS.blue, label: 'new' },
};

/**
 * Build Satori JSX element tree for a package card.
 * Satori uses a React-like object format: { type, props, children }
 */
function buildCardJSX(pkg) {
  const repos = pkg.repos || [];

  // Count tiers
  const verified = repos.filter(r => r.score?.tier === 'verified').length;
  const established = repos.filter(r => r.score?.tier === 'established').length;
  const newTier = repos.filter(r => r.score?.tier === 'new').length;

  // Build stats line
  const statsParts = [`${repos.length} tools`];
  if (verified > 0) statsParts.push(`${verified} verified`);
  if (established > 0) statsParts.push(`${established} established`);
  if (newTier > 0) statsParts.push(`${newTier} new`);
  const statsLine = statsParts.join(' · ');

  // Tool rows
  const toolRows = repos.map(r => {
    const tier = r.score?.tier || 'new';
    const cfg = TIER_CONFIG[tier] || TIER_CONFIG.new;

    return {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          alignItems: 'center',
          marginBottom: 10,
        },
        children: [
          // Badge
          {
            type: 'div',
            props: {
              style: {
                width: 28,
                height: 28,
                borderRadius: 14,
                backgroundColor: cfg.color + '22',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginRight: 14,
                flexShrink: 0,
              },
              children: {
                type: 'div',
                props: {
                  style: {
                    width: 12,
                    height: 12,
                    borderRadius: 6,
                    backgroundColor: cfg.color,
                  },
                },
              },
            },
          },
          // Tool name
          {
            type: 'span',
            props: {
              style: {
                fontSize: 17,
                fontWeight: 700,
                color: COLORS.textPrimary,
                marginRight: 16,
                minWidth: 180,
              },
              children: r.score?.meta?.description
                ? `${r.owner}/${r.repo}`.length > 24
                  ? r.repo
                  : `${r.owner}/${r.repo}`
                : r.repo,
            },
          },
          // Role
          {
            type: 'span',
            props: {
              style: {
                fontSize: 15,
                color: COLORS.textSecondary,
              },
              children: r.role,
            },
          },
        ],
      },
    };
  });

  // Full card
  return {
    type: 'div',
    props: {
      style: {
        width: 1200,
        height: 630,
        backgroundColor: COLORS.bg,
        display: 'flex',
        flexDirection: 'column',
        padding: '36px 48px',
        fontFamily: 'Inter',
      },
      children: [
        // Header — PackRat branding
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              marginBottom: 4,
            },
            children: {
              type: 'span',
              props: {
                style: {
                  fontSize: 15,
                  color: COLORS.textSecondary,
                  letterSpacing: 1,
                },
                children: '🔍  MCP SKILLS',
              },
            },
          },
        },

        // Title
        {
          type: 'div',
          props: {
            style: {
              fontSize: 38,
              fontWeight: 700,
              color: COLORS.textPrimary,
              marginBottom: 4,
            },
            children: pkg.name,
          },
        },

        // Tagline
        {
          type: 'div',
          props: {
            style: {
              fontSize: 18,
              color: COLORS.textSecondary,
              marginBottom: 20,
            },
            children: pkg.tagline,
          },
        },

        // Separator
        {
          type: 'div',
          props: {
            style: {
              width: '100%',
              height: 1,
              backgroundColor: COLORS.border,
              marginBottom: 22,
            },
          },
        },

        // Tool rows
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
            },
            children: toolRows,
          },
        },

        // Bottom separator
        {
          type: 'div',
          props: {
            style: {
              width: '100%',
              height: 1,
              backgroundColor: COLORS.border,
              marginBottom: 16,
              marginTop: 'auto',
            },
          },
        },

        // Footer
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            },
            children: [
              // Stats
              {
                type: 'span',
                props: {
                  style: {
                    fontSize: 14,
                    color: COLORS.green,
                    fontWeight: 600,
                  },
                  children: statsLine,
                },
              },
              // URL
              {
                type: 'span',
                props: {
                  style: {
                    fontSize: 13,
                    color: COLORS.textSecondary,
                  },
                  children: 'mcpskills.io',
                },
              },
            ],
          },
        },
      ],
    },
  };
}

/**
 * Render a package card to PNG buffer.
 * @param {object} pkg — package object from packages-scored.json
 * @returns {Buffer} PNG image data
 */
async function renderCard(pkg) {
  const jsx = buildCardJSX(pkg);

  const svg = await satori(jsx, {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Inter', data: interRegular, weight: 400, style: 'normal' },
      { name: 'Inter', data: interBold, weight: 700, style: 'normal' },
    ],
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
  });

  const pngData = resvg.render();
  return pngData.asPng();
}

module.exports = { renderCard, buildCardJSX };
