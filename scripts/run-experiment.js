#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DATASET_DIR = path.join(__dirname, 'node-test-dataset/parallel');
const OUTPUT_DIR = path.join(__dirname, 'experiment-results');

const NUM_RUNS = 25;
const SAMPLE_SIZE = 50;

// ─────────────────────────────────────────────

function getAllTests() {
  return fs.readdirSync(DATASET_DIR)
    .filter(f => f.endsWith('.js'))
    .map(f => path.join(DATASET_DIR, f));
}

function sampleWithReplacement(arr, n) {
  return Array.from({ length: n }, () =>
    arr[Math.floor(Math.random() * arr.length)]
  );
}

function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

// ─────────────────────────────────────────────
// CORE EXECUTION
// ─────────────────────────────────────────────

function runCommand(command, testFile) {
  const tempOutput = path.join(__dirname, 'temp-output.json');

  if (fs.existsSync(tempOutput)) {
    fs.unlinkSync(tempOutput);
  }

  const cmd = `
    TEST_FILE="${testFile}" \
    OUTPUT_PATH="${tempOutput}" \
    code --headless \
    --disable-extensions-except test-case-analysis \
    --command ${command}
  `;

  try {
    execSync(cmd, { stdio: 'ignore' });
  } catch (e) {
    console.error(`Error running ${command} for ${testFile}`);
    return null;
  }

  if (!fs.existsSync(tempOutput)) {
    console.error(`No output for ${command}`);
    return null;
  }

  return JSON.parse(fs.readFileSync(tempOutput, 'utf-8'));
}

// ─────────────────────────────────────────────

function runExperiment() {
  const allTests = getAllTests();
  const results = [];

  for (let run = 0; run < NUM_RUNS; run++) {
    console.log(`Run ${run + 1}/${NUM_RUNS}`);

    let sample = sampleWithReplacement(allTests, SAMPLE_SIZE);
    sample = shuffle(sample);

    for (const test of sample) {
      const profiling = runCommand(
        'testCaseAnalysis.profileTests',
        test
      );

      const efficient = runCommand(
        'testCaseAnalysis.runTestsEfficiently',
        test
      );

      if (!profiling || !efficient) continue;

      results.push({
        run,
        test,
        profiling_energy: profiling.energy,
        efficient_energy: efficient.energy,
        profiling_time: profiling.duration,
        efficient_time: efficient.duration,
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────

function aggregate(results) {
  const grouped = {};

  for (const r of results) {
    if (!grouped[r.test]) grouped[r.test] = [];
    grouped[r.test].push(r);
  }

  return Object.entries(grouped).map(([test, entries]) => {
    const avg = (key) =>
      entries.reduce((sum, e) => sum + e[key], 0) / entries.length;

    return {
      test,
      samples: entries.length,
      avg_profiling_energy: avg('profiling_energy'),
      avg_efficient_energy: avg('efficient_energy'),
      avg_profiling_time: avg('profiling_time'),
      avg_efficient_time: avg('efficient_time'),
    };
  });
}

// ─────────────────────────────────────────────

function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR);
  }

  console.log('Starting experiment...\n');

  // Warm-up (important)
  const warmupTest = getAllTests()[0];
  for (let i = 0; i < 3; i++) {
    runCommand('testCaseAnalysis.profileTests', warmupTest);
  }

  const results = runExperiment();
  const summary = aggregate(results);

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'raw.json'),
    JSON.stringify(results, null, 2)
  );

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'summary.json'),
    JSON.stringify(summary, null, 2)
  );

  console.log('\nExperiment complete.');
}

main();