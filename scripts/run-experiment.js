#!/usr/bin/env node
'use strict';

/**
 * run-experiment.js
 *
 * Experiment runner for: "Does energy-aware test ordering save energy?"
 *
 * Realistic experiment design
 * ─────────────────────────
 * The extension does not profile and execute one file in isolation as the
 * experiment unit. Instead, one experiment run works on a full sampled set
 * of files:
 *
 *   1. Randomly sample 200 files from the dataset
 *   2. Run 1 warm-up iteration on that sampled set (discarded)
 *   3. Run 3 measured iterations on that same sampled set
 *   4. For each measured iteration:
 *        a. profile all test cases across all sampled files
 *        b. run all sampled files efficiently using that profile
 *   5. Record both the 3 individual iterations and their average
 *
 * Defaults therefore represent:
 *   30 sampled runs × 200 files/run × 3 measured iterations/run
 *
 * Note
 * ────
 * Efficient execution stops within a file as soon as the first failing test
 * in that file is encountered, matching the extension behaviour.
 *
 * Prerequisites
 * ─────────────
 *   npm install pidusage
 *
 * Usage
 * ─────
 *   node run-experiment.js
 *   node run-experiment.js --runs 30 --sample 200
 *   node run-experiment.js --dataset ./node-test-dataset/parallel
 *   node run-experiment.js --out ./my-results
 *   node run-experiment.js --dry-run
 */

const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const { spawn } = require('child_process');
const pidusage  = require('pidusage');

// ─── Configuration ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function getArg(flag, def) {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : def;
}

const CONFIG = {
  datasetDir         : getArg('--dataset',  path.join(__dirname, 'node-test-dataset', 'parallel')),
  outputDir          : getArg('--out',      path.join(__dirname, 'experiment-results')),
  numRuns            : parseInt(getArg('--runs',     '30'),  10),
  sampleSize         : parseInt(getArg('--sample',   '200'), 10),
  cooldownMs         : parseInt(getArg('--cooldown', '500'), 10),
  warmupReps         : parseInt(getArg('--warmup',   '1'),   10),
  measuredIterations : parseInt(getArg('--iterations', '3'), 10),
  pollMs             : 100, // CPU sampling interval — matches testCommandRunner.ts
  dryRun             : argv.includes('--dry-run'),
};

// ─── CPU / TDP (mirrors cpuEnergyEstimator.ts) ────────────────────────────────

function detectTdpWatts() {
  const model = os.cpus()[0]?.model ?? '';
  const table = [
    [/i9|Ryzen 9|HX/i,          45],
    [/i7|Ryzen 7|H\b/i,         35],
    [/i5|Ryzen 5/i,             28],
    [/i3|Ryzen 3/i,             15],
    [/Celeron|Pentium|Atom/i,   10],
    [/Apple M[123]/i,           20],
    [/EPYC|Xeon|Threadripper/i, 65],
  ];
  for (const [re, tdp] of table) if (re.test(model)) return tdp;
  return 15;
}

const TDP_W           = detectTdpWatts();
const IDLE_BASELINE_W = TDP_W * 0.1;

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sampleWithReplacement(arr, n) {
  return Array.from({ length: n }, () => arr[Math.floor(Math.random() * arr.length)]);
}

function log(emoji, msg) { console.log(`\n${emoji}  ${msg}`); }
function progress(msg)   { process.stdout.write(`\r  ${msg}`.padEnd(100)); }

// ─── Runtime parser (mirrors getReportedRuntimeMs in testCommandRunner.ts) ────

function parseRuntimeMs(stdout, stderr) {
  const combined = [stdout, stderr].filter(Boolean).join('\n');

  const summaryMatch = combined.match(
    /(?:^|\n)[^\S\r\n]*[iℹ]\s+duration_ms\s+([0-9.]+)\s*(?:\n|$)/
  );
  if (summaryMatch?.[1]) return Number(summaryMatch[1]);

  const diagnosticMatches = [...combined.matchAll(/duration_ms:\s*([0-9.]+)/g)];
  if (diagnosticMatches.length > 0) {
    return Number(diagnosticMatches[diagnosticMatches.length - 1][1]);
  }

  return undefined;
}

// ─── Test discovery ───────────────────────────────────────────────────────────

function discoverTests(testFilePath) {
  return new Promise((resolve) => {
    if (CONFIG.dryRun) {
      const n = 2 + Math.floor(Math.random() * 4);
      resolve(Array.from({ length: n }, (_, i) => `dry-run-test-${i + 1}`));
      return;
    }

    let stdout = '';
    let stderr = '';

    const child = spawn(
      process.execPath,
      ['--test', '--test-reporter=json', testFilePath],
      { windowsHide: true, shell: false }
    );

    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    child.on('close', () => {
      const names = [];
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.type === 'test:start' && obj.data?.name) {
            names.push(obj.data.name);
          }
        } catch { /* ignore */ }
      }
      resolve(names.length > 0 ? names : [path.basename(testFilePath)]);
    });

    child.on('error', () => resolve([path.basename(testFilePath)]));
  });
}

// ─── Single test measurement (mirrors executeSingleTestCase) ──────────────────

function measureTestCase(testFilePath, testName) {
  return new Promise((resolve) => {
    if (CONFIG.dryRun) {
      const passed = Math.random() > 0.1;
      resolve({
        energyJ  : Math.random() * 0.05 + 0.001,
        runtimeMs: Math.random() * 300 + 10,
        passed,
      });
      return;
    }

    const escapedName = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const child = spawn(
      process.execPath,
      ['--test', `--test-name-pattern=${escapedName}`, testFilePath],
      { windowsHide: true, shell: false }
    );

    let stdout = '';
    let stderr = '';
    const cpuSamples = [];
    let polling = false;

    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    const poll = setInterval(() => {
      const pid = child.pid;
      if (pid === undefined || polling) return;
      polling = true;
      pidusage(pid)
        .then((stats) => { cpuSamples.push(stats.cpu); })
        .catch(() => { /* process may have exited */ })
        .finally(() => { polling = false; });
    }, CONFIG.pollMs);

    child.on('close', (code) => {
      clearInterval(poll);
      void pidusage.clear();

      const runtimeMs = parseRuntimeMs(stdout, stderr) ?? 0;
      const runtimeS  = runtimeMs / 1000;
      const avgCpuFraction = cpuSamples.length > 0
        ? cpuSamples.reduce((s, v) => s + v, 0) / cpuSamples.length / 100
        : 0;

      const energyJ = (avgCpuFraction * TDP_W + IDLE_BASELINE_W) * runtimeS;

      resolve({ energyJ, runtimeMs, passed: code === 0 });
    });

    child.on('error', (err) => {
      clearInterval(poll);
      void pidusage.clear();
      resolve({ energyJ: 0, runtimeMs: 0, passed: false, error: err.message });
    });
  });
}

// ─── Strategies ───────────────────────────────────────────────────────────────

async function runBaseline(testFilePath, testNames) {
  const perTest = [];
  let totalEnergyJ   = 0;
  let totalRuntimeMs = 0;

  for (const name of testNames) {
    const m = await measureTestCase(testFilePath, name);
    perTest.push({ testName: name, ...m });
    totalEnergyJ   += m.energyJ;
    totalRuntimeMs += m.runtimeMs;
    sleep(CONFIG.cooldownMs);
  }

  return { perTest, totalEnergyJ, totalRuntimeMs };
}

async function runEfficient(testFilePath, baselinePerTest) {
  const sorted = [...baselinePerTest].sort((a, b) => a.energyJ - b.energyJ);
  let totalEnergyJ   = 0;
  let totalRuntimeMs = 0;

  for (const { testName } of sorted) {
    const m = await measureTestCase(testFilePath, testName);
    totalEnergyJ   += m.energyJ;
    totalRuntimeMs += m.runtimeMs;

    if (!m.passed) break;
    sleep(CONFIG.cooldownMs);
  }

  return { totalEnergyJ, totalRuntimeMs };
}

// ─── Dataset-level execution ──────────────────────────────────────────────────

async function discoverSample(sampleFiles) {
  const discovered = [];

  for (let i = 0; i < sampleFiles.length; i++) {
    const filePath = sampleFiles[i];
    progress(`discovering tests [${i + 1}/${sampleFiles.length}] ${path.basename(filePath)}`);
    const testNames = await discoverTests(filePath);
    discovered.push({
      file: path.basename(filePath),
      testFilePath: filePath,
      testNames,
      testCount: testNames.length,
    });
  }

  process.stdout.write('\n');
  return discovered;
}

async function measureIteration(sampleDefinition, runNumber, iterationNumber, label) {
  let baselineEnergyJ = 0;
  let baselineDurationMs = 0;
  let efficientEnergyJ = 0;
  let efficientDurationMs = 0;

  for (let i = 0; i < sampleDefinition.length; i++) {
    const entry = sampleDefinition[i];
    progress(
      `${label} run ${runNumber}/${CONFIG.numRuns}, iteration ${iterationNumber}/${CONFIG.measuredIterations} ` +
      `[${i + 1}/${sampleDefinition.length}] ${entry.file}`
    );

    const baselineResult = await runBaseline(entry.testFilePath, entry.testNames);
    sleep(CONFIG.cooldownMs);
    const efficientResult = await runEfficient(entry.testFilePath, baselineResult.perTest);
    sleep(CONFIG.cooldownMs);

    baselineEnergyJ += baselineResult.totalEnergyJ;
    baselineDurationMs += baselineResult.totalRuntimeMs;
    efficientEnergyJ += efficientResult.totalEnergyJ;
    efficientDurationMs += efficientResult.totalRuntimeMs;
  }

  process.stdout.write('\n');

  return {
    iteration: iterationNumber,
    baseline_energy_j: baselineEnergyJ,
    efficient_energy_j: efficientEnergyJ,
    energy_saving_j: baselineEnergyJ - efficientEnergyJ,
    energy_saving_pct: baselineEnergyJ > 0
      ? ((baselineEnergyJ - efficientEnergyJ) / baselineEnergyJ) * 100
      : null,
    baseline_duration_ms: baselineDurationMs,
    efficient_duration_ms: efficientDurationMs,
    duration_saving_ms: baselineDurationMs - efficientDurationMs,
  };
}

function averageIterations(iterations) {
  const numeric = (key) => {
    const values = iterations.map((it) => it[key]).filter((v) => v != null && isFinite(v));
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };

  return {
    baseline_energy_j: numeric('baseline_energy_j'),
    efficient_energy_j: numeric('efficient_energy_j'),
    energy_saving_j: numeric('energy_saving_j'),
    energy_saving_pct: numeric('energy_saving_pct'),
    baseline_duration_ms: numeric('baseline_duration_ms'),
    efficient_duration_ms: numeric('efficient_duration_ms'),
    duration_saving_ms: numeric('duration_saving_ms'),
  };
}

async function warmUpSample(sampleDefinition, runNumber) {
  log('🔥', `Warm-up for run ${runNumber}/${CONFIG.numRuns} (${CONFIG.warmupReps} discarded iteration${CONFIG.warmupReps === 1 ? '' : 's'})`);

  for (let rep = 0; rep < CONFIG.warmupReps; rep++) {
    await measureIteration(sampleDefinition, runNumber, rep + 1, 'warm-up');
  }
}

async function measureRun(allFiles, runNumber) {
  const sampledFiles = sampleWithReplacement(allFiles, CONFIG.sampleSize);
  const sampleDefinition = await discoverSample(sampledFiles);

  await warmUpSample(sampleDefinition, runNumber);

  const iterations = [];
  for (let iteration = 1; iteration <= CONFIG.measuredIterations; iteration++) {
    const result = await measureIteration(sampleDefinition, runNumber, iteration, 'measured');
    iterations.push(result);
  }

  return {
    run: runNumber,
    timestamp: new Date().toISOString(),
    sampled_files: sampleDefinition.map((entry) => ({
      file: entry.file,
      test_count: entry.testCount,
    })),
    warmup_iterations_discarded: CONFIG.warmupReps,
    measured_iterations: iterations,
    average: averageIterations(iterations),
  };
}

// ─── Dataset ──────────────────────────────────────────────────────────────────

function getAllTestFiles() {
  if (!fs.existsSync(CONFIG.datasetDir)) {
    console.error(`\n✗ Dataset directory not found: ${CONFIG.datasetDir}`);
    console.error('  Run setup-node-test-dataset.js first, or pass --dataset <path>');
    process.exit(1);
  }

  const files = fs.readdirSync(CONFIG.datasetDir)
    .filter((f) => /\.(js|mjs|cjs)$/.test(f))
    .map((f) => path.join(CONFIG.datasetDir, f));

  if (files.length === 0) {
    console.error(`\n✗ No test files found in ${CONFIG.datasetDir}`);
    process.exit(1);
  }

  return files;
}

// ─── Experiment loop ──────────────────────────────────────────────────────────

async function runExperiment(allFiles) {
  const runs = [];

  for (let run = 1; run <= CONFIG.numRuns; run++) {
    log('🔬', `Run ${run} / ${CONFIG.numRuns}`);
    const runResult = await measureRun(allFiles, run);
    runs.push(runResult);
    writeCheckpoint(runs);
  }

  log('📊', `Collected ${runs.length} run-level observations`);
  return runs;
}

// ─── Checkpoint ───────────────────────────────────────────────────────────────

function writeCheckpoint(runResults) {
  const checkpointPath = path.join(CONFIG.outputDir, 'checkpoint-raw.json');
  fs.writeFileSync(checkpointPath, JSON.stringify(runResults, null, 2), 'utf-8');
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

function stats(values) {
  const clean = values.filter((v) => v != null && isFinite(v));
  if (clean.length === 0) return { mean: null, stddev: null, median: null, min: null, max: null, n: 0 };
  const mean   = clean.reduce((s, v) => s + v, 0) / clean.length;
  const stddev = Math.sqrt(clean.reduce((s, v) => s + (v - mean) ** 2, 0) / clean.length);
  const sorted = [...clean].sort((a, b) => a - b);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];
  return { mean, stddev, median, min: sorted[0], max: sorted[sorted.length - 1], n: clean.length };
}

function aggregateOverall(runResults) {
  const averages = runResults.map((run) => run.average);

  return {
    total_run_observations     : runResults.length,
    measured_iterations_per_run: CONFIG.measuredIterations,
    warmup_iterations_discarded: CONFIG.warmupReps,
    num_runs                   : CONFIG.numRuns,
    sample_size                : CONFIG.sampleSize,
    cpu_model                  : os.cpus()[0]?.model ?? 'unknown',
    tdp_w                      : TDP_W,
    idle_baseline_w            : IDLE_BASELINE_W,

    baseline_energy_j          : stats(averages.map((o) => o.baseline_energy_j)),
    efficient_energy_j         : stats(averages.map((o) => o.efficient_energy_j)),
    energy_saving_j            : stats(averages.map((o) => o.energy_saving_j)),
    energy_saving_pct          : stats(averages.map((o) => o.energy_saving_pct)),
    baseline_duration_ms       : stats(averages.map((o) => o.baseline_duration_ms)),
    efficient_duration_ms      : stats(averages.map((o) => o.efficient_duration_ms)),
    duration_saving_ms         : stats(averages.map((o) => o.duration_saving_ms)),

    run_summaries              : runResults.map((run) => ({
      run: run.run,
      sample_file_count: run.sampled_files.length,
      average_baseline_energy_j: run.average.baseline_energy_j,
      average_efficient_energy_j: run.average.efficient_energy_j,
      average_energy_saving_j: run.average.energy_saving_j,
      average_energy_saving_pct: run.average.energy_saving_pct,
      average_baseline_duration_ms: run.average.baseline_duration_ms,
      average_efficient_duration_ms: run.average.efficient_duration_ms,
      average_duration_saving_ms: run.average.duration_saving_ms,
    })),
    generated_at               : new Date().toISOString(),
  };
}

// ─── Output ───────────────────────────────────────────────────────────────────

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`  → ${filePath}`);
}

function writeTextSummary(filePath, overall) {
  const f  = (n, d = 4) => (n == null ? 'N/A' : Number(n).toFixed(d));
  const p  = (n) => (n == null ? 'N/A' : Number(n).toFixed(1) + ' %');
  const hr = '─'.repeat(68);
  const dhr= '═'.repeat(68);

  const es = overall.energy_saving_j;
  const ep = overall.energy_saving_pct;
  const be = overall.baseline_energy_j;
  const ee = overall.efficient_energy_j;
  const bd = overall.baseline_duration_ms;
  const ed = overall.efficient_duration_ms;

  const lines = [
    dhr,
    '  EXPERIMENT RESULTS  —  Energy-Aware Test Ordering',
    dhr,
    '',
    '  Research question : Does energy-aware ordering save energy vs baseline?',
    '',
    `  CPU               : ${overall.cpu_model}`,
    `  TDP estimate      : ${overall.tdp_w} W  (idle baseline: ${overall.idle_baseline_w} W)`,
    `  Runs              : ${overall.num_runs}`,
    `  Sample / run      : ${overall.sample_size} files`,
    `  Warm-up / run     : ${overall.warmup_iterations_discarded} discarded iteration(s)`,
    `  Measured / run    : ${overall.measured_iterations_per_run} iteration(s)`,
    `  Observation unit  : average of 3 full-sample iterations per run`,
    `  Total run records : ${overall.total_run_observations}`,
    `  Generated at      : ${overall.generated_at}`,
    '',
    hr,
    '  ENERGY  (Joules per sampled run average)',
    hr,
    `  Baseline  mean : ${f(be.mean)} J  ± ${f(be.stddev)}  (median ${f(be.median)})`,
    `  Efficient mean : ${f(ee.mean)} J  ± ${f(ee.stddev)}  (median ${f(ee.median)})`,
    '',
    `  Mean saving    : ${f(es.mean)} J  ± ${f(es.stddev)}`,
    `  Median saving  : ${f(es.median)} J`,
    `  Mean saving %  : ${p(ep.mean)}`,
    `  Min / Max      : ${f(es.min)} J  /  ${f(es.max)} J`,
    '',
    '  → Positive saving = efficient strategy used less energy',
    '',
    hr,
    '  DURATION  (milliseconds per sampled run average)',
    hr,
    `  Baseline  mean : ${f(bd.mean, 1)} ms  ± ${f(bd.stddev, 1)}`,
    `  Efficient mean : ${f(ed.mean, 1)} ms  ± ${f(ed.stddev, 1)}`,
    `  Mean saving    : ${f(overall.duration_saving_ms.mean, 1)} ms`,
    '',
    dhr,
    '',
  ];

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  console.log(`  → ${filePath}`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  if (CONFIG.dryRun) log('🧪', 'DRY RUN — no real measurements will be taken');

  log('⚙️ ', 'Configuration');
  console.log(`  Dataset           : ${CONFIG.datasetDir}`);
  console.log(`  Output            : ${CONFIG.outputDir}`);
  console.log(`  Runs              : ${CONFIG.numRuns}`);
  console.log(`  Sample/run        : ${CONFIG.sampleSize} files`);
  console.log(`  Warm-up/run       : ${CONFIG.warmupReps}`);
  console.log(`  Measured/run      : ${CONFIG.measuredIterations}`);
  console.log(`  Total file-samples planned : ${CONFIG.numRuns * CONFIG.sampleSize}`);
  console.log(`  Cooldown          : ${CONFIG.cooldownMs} ms`);
  console.log(`  CPU               : ${os.cpus()[0]?.model ?? 'unknown'}`);
  console.log(`  TDP               : ${TDP_W} W   Idle baseline : ${IDLE_BASELINE_W} W`);

  try { require.resolve('pidusage'); } catch {
    console.error('\n✗ pidusage not found. Run: npm install pidusage');
    process.exit(1);
  }

  fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  const allFiles = getAllTestFiles();
  log('📂', `Dataset: ${allFiles.length} test files`);

  const t0 = Date.now();
  log('🚀', `Starting: ${CONFIG.numRuns} runs × ${CONFIG.sampleSize} files × ${CONFIG.measuredIterations} measured iterations`);

  const rawRuns = await runExperiment(allFiles);

  const elapsed = ((Date.now() - t0) / 60000).toFixed(1);
  log('⏱ ', `Finished in ${elapsed} minutes`);

  if (rawRuns.length === 0) {
    log('❌', 'No observations collected. Check pidusage is installed and dataset is valid.');
    process.exit(1);
  }

  const overall = aggregateOverall(rawRuns);

  log('💾', 'Writing results...');
  writeJSON(path.join(CONFIG.outputDir, 'raw.json'), rawRuns);
  writeJSON(path.join(CONFIG.outputDir, 'overall.json'), overall);
  writeTextSummary(path.join(CONFIG.outputDir, 'summary.txt'), overall);

  log('🎉', `Done! Results in: ${CONFIG.outputDir}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
