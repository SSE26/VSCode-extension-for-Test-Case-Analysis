#!/usr/bin/env node
'use strict';

/**
 * probe-extension-output.js
 *
 * Fires each VSCode extension command once against the first test file it can
 * find, then pretty-prints whatever the extension wrote to the temp file.
 *
 * Usage:
 *   node probe-extension-output.js
 *   node probe-extension-output.js --dataset ./node-test-dataset/parallel
 */

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const datasetDir = argv[argv.indexOf('--dataset') + 1]
  ?? path.join(__dirname, 'node-test-dataset', 'parallel');

const TEMP_OUTPUT = path.join(__dirname, '.probe-output.json');
const COMMANDS = [
  'testCaseAnalysis.profileTests',
  'testCaseAnalysis.runTestsEfficiently',
];

// ── Find a test file ──────────────────────────────────────────────────────────

if (!fs.existsSync(datasetDir)) {
  console.error(`\n✗ Dataset directory not found: ${datasetDir}`);
  console.error('  Run setup-node-test-dataset.js first, or pass --dataset <path>');
  process.exit(1);
}

const testFile = fs.readdirSync(datasetDir)
  .filter(f => f.endsWith('.js'))
  .map(f => path.join(datasetDir, f))[0];

if (!testFile) {
  console.error(`\n✗ No .js files found in ${datasetDir}`);
  process.exit(1);
}

console.log(`\nUsing test file: ${testFile}\n`);

// ── Fire each command and print output ───────────────────────────────────────

for (const command of COMMANDS) {
  console.log('═'.repeat(60));
  console.log(`Command: ${command}`);
  console.log('═'.repeat(60));

  if (fs.existsSync(TEMP_OUTPUT)) fs.unlinkSync(TEMP_OUTPUT);

  const result = spawnSync(
    'code',
    [
      '--headless',
      '--disable-extensions-except', 'test-case-analysis',
      '--command', command,
    ],
    {
      env     : { ...process.env, TEST_FILE: testFile, OUTPUT_PATH: TEMP_OUTPUT },
      encoding: 'utf8',
      timeout : 60_000,
    },
  );

  console.log(`Exit code : ${result.status}`);

  if (result.stdout) console.log(`stdout    :\n${result.stdout}`);
  if (result.stderr) console.log(`stderr    :\n${result.stderr}`);
  if (result.error)  console.log(`Error     : ${result.error.message}`);

  if (fs.existsSync(TEMP_OUTPUT)) {
    const raw = fs.readFileSync(TEMP_OUTPUT, 'utf-8');
    console.log(`\nRaw file contents (${TEMP_OUTPUT}):\n`);
    console.log(raw);

    try {
      const parsed = JSON.parse(raw);
      console.log('\nParsed JSON (with types):\n');
      for (const [k, v] of Object.entries(parsed)) {
        console.log(`  ${k.padEnd(25)} = ${JSON.stringify(v).padEnd(20)}  (${typeof v})`);
      }
    } catch {
      console.log('\n⚠  File is not valid JSON — raw text shown above is all there is.');
    }
  } else {
    console.log('\n⚠  No output file was written.');
    console.log('   Either the extension did not run, or it does not write to OUTPUT_PATH.');
  }

  console.log('');
}

// Cleanup
if (fs.existsSync(TEMP_OUTPUT)) fs.unlinkSync(TEMP_OUTPUT);

console.log('Done. Share the output above and we can update run-experiment.js accordingly.');