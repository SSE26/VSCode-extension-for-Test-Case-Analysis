#!/usr/bin/env node
'use strict';

/**
 * setup-node-test-dataset.js
 *
 * Downloads a subset of the Node.js built-in test suite and prepares it
 * so every file can be run with: node --test
 *
 * Usage:
 *   node setup-node-test-dataset.js
 *   node setup-node-test-dataset.js --combined   (merge into one file)
 *   node setup-node-test-dataset.js --out ./my-dir
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const COMBINED_MODE = args.includes('--combined');
const outIndex = args.indexOf('--out');
const OUTPUT_DIR = outIndex !== -1 ? args[outIndex + 1] : path.join(__dirname, 'node-test-dataset');
const CLONE_DIR = path.join(__dirname, '.node-src-temp');

// ─── Helpers ─────────────────────────────────────────────────────────────────
function run(cmd, cwd = __dirname) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'pipe' });
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    entry.isDirectory() ? copyDirRecursive(s, d) : fs.copyFileSync(s, d);
  }
}

function log(emoji, msg) {
  console.log(`\n${emoji}  ${msg}`);
}

// ─── Step 1: Sparse-clone nodejs/node ────────────────────────────────────────
log('📦', 'Step 1: Sparse-cloning nodejs/node from GitHub...');
log('   ', '(only test/parallel + test/common — skips the 2 GB source tree)');

if (fs.existsSync(CLONE_DIR)) {
  fs.rmSync(CLONE_DIR, { recursive: true, force: true });
}

run(`git clone --no-checkout --depth=1 https://github.com/nodejs/node.git "${CLONE_DIR}"`);
run('git sparse-checkout init', CLONE_DIR);
run('git sparse-checkout set test/parallel test/common.js test/common', CLONE_DIR);
run('git checkout main', CLONE_DIR);

log('✅', 'Clone done.');

// ─── Step 2: Decide which test files to keep ──────────────────────────────────
log('🔍', 'Step 2: Scanning test/parallel for self-contained files...');

const srcParallel = path.join(CLONE_DIR, 'test', 'parallel');
const allFiles = fs.readdirSync(srcParallel)
  .filter(f => f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.cjs'));

const kept = [];
const skipped = [];

// Patterns that mean a file relies on things we haven't downloaded
const SKIP_PATTERNS = [
  /require\(['"]\.\.\/fixtures/,      // needs test/fixtures/
  /require\(['"]\.\.\/\.\.\/lib/,     // needs Node.js internal lib/
  /require\(['"]\.\.\/testcfg/,       // build-time config
  /process\.binding/,                 // internal bindings (not public API)
  /internalBinding/,                  // same
  /require\('node:v8'\)/,             // V8-specific internals unlikely to be stable
  /WASI|wasi/,                        // WASI tests need extra setup
  /requireAddon/,                     // native addons
  /\.node['"]/,                       // native .node files
];

for (const file of allFiles) {
  const fullPath = path.join(srcParallel, file);
  const content = fs.readFileSync(fullPath, 'utf8');

  const skipReason = SKIP_PATTERNS.find(re => re.test(content));
  if (skipReason) {
    skipped.push({ file, reason: skipReason.toString() });
  } else {
    kept.push(file);
  }
}

console.log(`     Keeping  : ${kept.length} files`);
console.log(`     Skipping : ${skipped.length} files (fixtures / internals / native addons)`);

// ─── Step 3: Build output directory ──────────────────────────────────────────
log('📁', 'Step 3: Building output directory...');

if (fs.existsSync(OUTPUT_DIR)) {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
}

if (!COMBINED_MODE) {
  // ── Individual files mode ──────────────────────────────────────────────────
  const destParallel = path.join(OUTPUT_DIR, 'parallel');
  fs.mkdirSync(destParallel, { recursive: true });

  // Copy the common helper so require('../common') still resolves
  const commonJsSrc = path.join(CLONE_DIR, 'test', 'common.js');
  const commonDirSrc = path.join(CLONE_DIR, 'test', 'common');
  if (fs.existsSync(commonJsSrc)) {
    fs.copyFileSync(commonJsSrc, path.join(OUTPUT_DIR, 'common.js'));
  }
  if (fs.existsSync(commonDirSrc)) {
    copyDirRecursive(commonDirSrc, path.join(OUTPUT_DIR, 'common'));
  }

  // Copy kept test files
  for (const file of kept) {
    fs.copyFileSync(
      path.join(srcParallel, file),
      path.join(destParallel, file),
    );
  }

  // Write package.json
  const pkg = {
    name: 'node-test-dataset',
    version: '1.0.0',
    description: 'Subset of the Node.js built-in test suite — zero external deps',
    scripts: {
      test: 'node --test parallel/',
      'test:verbose': 'node --test --test-reporter=spec parallel/',
    },
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'package.json'), JSON.stringify(pkg, null, 2));

  // Write a quick README
  const readme = `# node-test-dataset

A self-contained subset of the Node.js built-in test suite.

## Running

\`\`\`bash
# Run all tests
node --test parallel/

# Verbose output
node --test --test-reporter=spec parallel/

# Run a single file
node --test parallel/test-assert.js
\`\`\`

## Structure

\`\`\`
node-test-dataset/
├── parallel/          # ${kept.length} test files  (test-*.js, runnable with node --test)
├── common.js          # Node.js test helper (required by most test files)
├── common/            # Sub-helpers
└── package.json
\`\`\`

## Notes
- All tests use only Node.js built-ins (\`node:assert\`, \`node:fs\`, etc.)
- No Jest / Mocha / Jasmine — pure \`node --test\`
- ${skipped.length} files were excluded because they need fixtures, native addons, or internal bindings
`;
  fs.writeFileSync(path.join(OUTPUT_DIR, 'README.md'), readme);

  log('✅', `Individual files written to: ${OUTPUT_DIR}/parallel/`);

} else {
  // ── Combined file mode ─────────────────────────────────────────────────────
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const lines = [
    `'use strict';`,
    `// Auto-generated combined test file`,
    `// Source: nodejs/node test/parallel (${kept.length} tests)`,
    `// Run with: node --test combined.test.js`,
    ``,
    `const test = require('node:test');`,
    `const assert = require('node:assert');`,
    ``,
  ];

  for (const file of kept) {
    const content = fs.readFileSync(path.join(srcParallel, file), 'utf8');
    const testName = file.replace(/\.(js|mjs|cjs)$/, '');

    // Wrap each original file's content inside a test() block
    // Strip the shebang / 'use strict' / top-level requires that we've already declared
    const stripped = content
      .replace(/^#!.*\n/, '')               // shebang
      .replace(/'use strict';\n?/g, '')     // 'use strict'
      .replace(/^\/\/.+\n/gm, '')          // single-line comments at line start
      .trim();

    lines.push(`test(${JSON.stringify(testName)}, () => {`);
    lines.push(`  // ── ${file} ──`);
    // Indent each line of the file body
    for (const line of stripped.split('\n')) {
      lines.push(`  ${line}`);
    }
    lines.push(`});`);
    lines.push('');
  }

  const outFile = path.join(OUTPUT_DIR, 'combined.test.js');
  fs.writeFileSync(outFile, lines.join('\n'));

  const pkg = {
    name: 'node-test-dataset',
    version: '1.0.0',
    scripts: { test: 'node --test combined.test.js' },
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'package.json'), JSON.stringify(pkg, null, 2));

  log('✅', `Combined file written to: ${outFile}`);
}

// ─── Step 4: Clean up clone ───────────────────────────────────────────────────
log('🧹', 'Step 4: Removing temporary clone...');
fs.rmSync(CLONE_DIR, { recursive: true, force: true });

// ─── Summary ─────────────────────────────────────────────────────────────────
log('🎉', 'All done!\n');
console.log('  Output directory :', OUTPUT_DIR);
console.log('  Test files       :', kept.length);
console.log('  Mode             :', COMBINED_MODE ? 'combined (combined.test.js)' : 'individual (parallel/*.js)');
console.log('');
if (!COMBINED_MODE) {
  console.log('  To run all tests:');
  console.log(`    cd "${OUTPUT_DIR}" && node --test parallel/`);
} else {
  console.log('  To run all tests:');
  console.log(`    cd "${OUTPUT_DIR}" && node --test combined.test.js`);
}
console.log('');