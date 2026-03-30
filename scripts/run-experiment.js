#!/usr/bin/env node
'use strict';

/**
 * run-experiment.js
 *
 * Standalone experiment runner for the energy-aware test prioritisation study.
 *
 * This script replicates the measurement logic from testCommandRunner.ts
 * directly — no VSCode, no extension host, no IPC needed.
 *
 * What it measures
 * ─────────────────
 * For each sampled test file it discovers the individual test cases (via
 * --test-reporter=json), then runs two strategies back-to-back:
 *
 *   profiling  — runs every test case individually in file order, records energy + duration
 *   efficient  — sorts those results by energy ascending, reruns in that order
 *                (stops on first failure, mirroring the extension's behaviour)
 *
 * Energy model (identical to testCommandRunner.ts)
 * ─────────────────────────────────────────────────
 *   energyJ = (avgCpuFraction × tdpW + idleBaselineW) × runtimeS
 *
 *   tdpW          estimated from os.cpus() model string (same heuristic as the extension)
 *   idleBaselineW = tdpW × 0.1
 *   avgCpuFraction sampled every 100 ms via pidusage
 *
 * Prerequisites
 * ──────────────
 *   npm install pidusage        (already a dependency of the extension)
 *
 * Usage
 * ──────
 *   node run-experiment.js
 *   node run-experiment.js --runs 25 --sample 50
 *   node run-experiment.js --dataset ./node-test-dataset/parallel
 *   node run-experiment.js --out ./my-results
 *   node run-experiment.js --dry-run    # smoke-test without real measurements
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
  datasetDir : getArg('--dataset',  path.join(__dirname, 'node-test-dataset', 'parallel')),
  outputDir  : getArg('--out',      path.join(__dirname, 'experiment-results')),
  numRuns    : parseInt(getArg('--runs',     '25'),  10),
  sampleSize : parseInt(getArg('--sample',   '50'),  10),
  /** ms to sleep between consecutive test executions — lets CPU frequency settle */
  cooldownMs : parseInt(getArg('--cooldown', '500'), 10),
  /** discarded warm-up executions before timed experiment begins */
  warmupReps : parseInt(getArg('--warmup',   '3'),   10),
  /** CPU polling interval — matches POLL_INTERVAL_MS in testCommandRunner.ts */
  pollMs     : 100,
  dryRun     : argv.includes('--dry-run'),
};

// ─── CPU / TDP helpers (mirrors cpuEnergyEstimator.ts) ───────────────────────

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
  for (const [re, tdp] of table) {
    if (re.test(model)) return tdp;
  }
  return 15; // conservative fallback
}

const TDP_W           = detectTdpWatts();
const IDLE_BASELINE_W = TDP_W * 0.1; // same as getIdleBaselineW() in the extension

// ─── Utility helpers ──────────────────────────────────────────────────────────

/** Synchronous sleep — keeps the script single-threaded and easy to reason about */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Fisher-Yates shuffle — avoids the biased Array#sort trick */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sampleWithReplacement(arr, n) {
  return Array.from({ length: n }, () => arr[Math.floor(Math.random() * arr.length)]);
}

function log(emoji, msg) { console.log(`\n${emoji}  ${msg}`); }
function progress(msg)   { process.stdout.write(`\r  ${msg}`.padEnd(80)); }

// ─── Runtime parser (mirrors getReportedRuntimeMs in testCommandRunner.ts) ────

function parseRuntimeMs(stdout, stderr) {
  const combined = [stdout, stderr].filter(Boolean).join('\n');

  // TAP summary line:  ℹ duration_ms 123.45
  const summaryMatch = combined.match(
    /(?:^|\n)[^\S\r\n]*[iℹ]\s+duration_ms\s+([0-9.]+)\s*(?:\n|$)/
  );
  if (summaryMatch?.[1]) return Number(summaryMatch[1]);

  // Diagnostic line inside a test block:  duration_ms: 123.45
  const diagnosticMatches = [...combined.matchAll(/duration_ms:\s*([0-9.]+)/g)];
  if (diagnosticMatches.length > 0) {
    return Number(diagnosticMatches[diagnosticMatches.length - 1][1]);
  }

  return undefined;
}

// ─── Test discovery ───────────────────────────────────────────────────────────

/**
 * Enumerate test names in a file by running it with --test-reporter=json.
 * Falls back to a single entry (run the whole file as one unit) when discovery
 * fails or finds nothing — matching the extension's fallback behaviour.
 */
function discoverTests(testFilePath) {
  return new Promise((resolve) => {
    if (CONFIG.dryRun) {
      resolve(['(dry-run-test-a)', '(dry-run-test-b)']);
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
        } catch { /* non-JSON reporter lines are fine to skip */ }
      }
      resolve(names.length > 0 ? names : [path.basename(testFilePath)]);
    });

    child.on('error', () => resolve([path.basename(testFilePath)]));
  });
}

// ─── Single test measurement (mirrors executeSingleTestCase) ──────────────────

/**
 * Runs one named test case in isolation and returns { energyJ, runtimeMs, passed }.
 * Uses the same default command template as the extension:
 *   node --test --test-name-pattern="<escaped>" <file>
 */
function measureTestCase(testFilePath, testName) {
  return new Promise((resolve) => {
    if (CONFIG.dryRun) {
      resolve({
        energyJ  : Math.random() * 0.05 + 0.001,
        runtimeMs: Math.random() * 300  + 10,
        passed   : true,
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
        .catch(() => { /* process may have just exited */ })
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

      // Identical formula to testCommandRunner.ts
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

// ─── Dataset ──────────────────────────────────────────────────────────────────

function getAllTestFiles() {
  if (!fs.existsSync(CONFIG.datasetDir)) {
    console.error(`\n✗ Dataset directory not found: ${CONFIG.datasetDir}`);
    console.error('  Run setup-node-test-dataset.js first, or pass --dataset <path>');
    process.exit(1);
  }
  const files = fs.readdirSync(CONFIG.datasetDir)
    .filter(f => /\.(js|mjs|cjs)$/.test(f))
    .map(f => path.join(CONFIG.datasetDir, f));
  if (files.length === 0) {
    console.error(`\n✗ No test files found in ${CONFIG.datasetDir}`);
    process.exit(1);
  }
  return files;
}

// ─── Strategy implementations ─────────────────────────────────────────────────

/**
 * PROFILING: runs all discovered tests individually in file order.
 * Returns per-test measurements + totals for the file.
 */
async function runProfiling(testFilePath) {
  const testNames = await discoverTests(testFilePath);
  const perTest   = [];
  let totalEnergyJ   = 0;
  let totalRuntimeMs = 0;

  for (const name of testNames) {
    const m = await measureTestCase(testFilePath, name);
    perTest.push({ testName: name, ...m });
    totalEnergyJ   += m.energyJ;
    totalRuntimeMs += m.runtimeMs;
    sleep(CONFIG.cooldownMs);
  }

  return { perTest, totalEnergyJ, totalRuntimeMs, testCount: testNames.length };
}

/**
 * EFFICIENT: reruns the same tests sorted by profiled energy ascending.
 * Stops on the first failure, mirroring the extension's behaviour.
 */
async function runEfficient(testFilePath, profilingResult) {
  const sorted = [...profilingResult.perTest].sort((a, b) => a.energyJ - b.energyJ);
  const perTest = [];
  let totalEnergyJ   = 0;
  let totalRuntimeMs = 0;
  let stoppedEarly   = false;

  for (const { testName } of sorted) {
    const m = await measureTestCase(testFilePath, testName);
    perTest.push({ testName, ...m });
    totalEnergyJ   += m.energyJ;
    totalRuntimeMs += m.runtimeMs;

    if (!m.passed) {
      stoppedEarly = true;
      break;
    }
    sleep(CONFIG.cooldownMs);
  }

  return { perTest, totalEnergyJ, totalRuntimeMs, stoppedEarly, testCount: sorted.length };
}

// ─── Warm-up ──────────────────────────────────────────────────────────────────

async function warmUp(allFiles) {
  log('🔥', `Warming up (${CONFIG.warmupReps} discarded runs)...`);
  const warmFile = allFiles[0];
  for (let i = 0; i < CONFIG.warmupReps; i++) {
    progress(`warm-up ${i + 1}/${CONFIG.warmupReps}`);
    await runProfiling(warmFile);
    sleep(CONFIG.cooldownMs);
  }
  process.stdout.write('\n');
}

// ─── Experiment loop ──────────────────────────────────────────────────────────

async function runExperiment(allFiles) {
  const observations = [];
  let skipped = 0;

  for (let run = 0; run < CONFIG.numRuns; run++) {
    log('🔬', `Run ${run + 1} / ${CONFIG.numRuns}`);

    const sample = shuffle(sampleWithReplacement(allFiles, CONFIG.sampleSize));

    for (let i = 0; i < sample.length; i++) {
      const filePath = sample[i];
      const label    = path.basename(filePath);

      progress(`[${i + 1}/${sample.length}] profiling  → ${label}`);
      let profilingResult;
      try {
        profilingResult = await runProfiling(filePath);
      } catch (e) {
        console.error(`\n  ✗ profiling failed for ${label}: ${e.message}`);
        skipped++;
        continue;
      }

      progress(`[${i + 1}/${sample.length}] efficient → ${label}`);
      let efficientResult;
      try {
        efficientResult = await runEfficient(filePath, profilingResult);
      } catch (e) {
        console.error(`\n  ✗ efficient run failed for ${label}: ${e.message}`);
        skipped++;
        continue;
      }

      observations.push({
        run       : run + 1,       // 1-indexed for human readability
        file      : label,
        file_path : filePath,
        timestamp : new Date().toISOString(),
        test_count: profilingResult.testCount,

        // ── Energy ──────────────────────────────────────────────────────
        profiling_energy_j   : profilingResult.totalEnergyJ,
        efficient_energy_j   : efficientResult.totalEnergyJ,
        // positive = efficient strategy used less energy
        energy_delta_j       : profilingResult.totalEnergyJ - efficientResult.totalEnergyJ,

        // ── Duration ────────────────────────────────────────────────────
        profiling_duration_ms: profilingResult.totalRuntimeMs,
        efficient_duration_ms: efficientResult.totalRuntimeMs,
        duration_delta_ms    : profilingResult.totalRuntimeMs - efficientResult.totalRuntimeMs,

        // ── Flags ────────────────────────────────────────────────────────
        efficient_stopped_early: efficientResult.stoppedEarly,

        // ── Per-test breakdown (keep for post-hoc analysis) ─────────────
        profiling_per_test: profilingResult.perTest,
        efficient_per_test: efficientResult.perTest,
      });
    }

    process.stdout.write('\n');
  }

  log('📊', `Collected ${observations.length} observations (${skipped} files skipped due to errors)`);
  return observations;
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

function stats(values) {
  if (values.length === 0) return { mean: null, stddev: null, min: null, max: null, n: 0 };
  const mean   = values.reduce((s, v) => s + v, 0) / values.length;
  const stddev = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  return { mean, stddev, min: Math.min(...values), max: Math.max(...values), n: values.length };
}

function aggregateByFile(observations) {
  const grouped = {};
  for (const o of observations) (grouped[o.file] ??= []).push(o);

  return Object.entries(grouped).map(([file, entries]) => ({
    file,
    samples              : entries.length,
    profiling_energy_j   : stats(entries.map(e => e.profiling_energy_j)),
    efficient_energy_j   : stats(entries.map(e => e.efficient_energy_j)),
    energy_delta_j       : stats(entries.map(e => e.energy_delta_j)),
    profiling_duration_ms: stats(entries.map(e => e.profiling_duration_ms)),
    efficient_duration_ms: stats(entries.map(e => e.efficient_duration_ms)),
    duration_delta_ms    : stats(entries.map(e => e.duration_delta_ms)),
  }));
}

function aggregateOverall(observations) {
  const byRun = {};
  for (const o of observations) (byRun[o.run] ??= []).push(o);

  const runSummaries = Object.entries(byRun).map(([run, entries]) => ({
    run                     : Number(run),
    files_measured          : entries.length,
    total_profiling_energy_j: entries.reduce((s, e) => s + e.profiling_energy_j, 0),
    total_efficient_energy_j: entries.reduce((s, e) => s + e.efficient_energy_j, 0),
    mean_energy_delta_j     : entries.reduce((s, e) => s + e.energy_delta_j, 0) / entries.length,
  }));

  return {
    total_observations    : observations.length,
    num_runs              : CONFIG.numRuns,
    sample_size           : CONFIG.sampleSize,
    cpu_model             : os.cpus()[0]?.model ?? 'unknown',
    tdp_w                 : TDP_W,
    idle_baseline_w       : IDLE_BASELINE_W,
    profiling_energy_j    : stats(observations.map(o => o.profiling_energy_j)),
    efficient_energy_j    : stats(observations.map(o => o.efficient_energy_j)),
    energy_delta_j        : stats(observations.map(o => o.energy_delta_j)),
    profiling_duration_ms : stats(observations.map(o => o.profiling_duration_ms)),
    efficient_duration_ms : stats(observations.map(o => o.efficient_duration_ms)),
    duration_delta_ms     : stats(observations.map(o => o.duration_delta_ms)),
    run_summaries         : runSummaries,
    config                : CONFIG,
    generated_at          : new Date().toISOString(),
  };
}

// ─── Output ───────────────────────────────────────────────────────────────────

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`  → ${filePath}`);
}

function writeTextSummary(filePath, overall, byFile) {
  const f4  = (n) => (n == null ? 'N/A' : n.toFixed(4));
  const f1  = (n) => (n == null ? 'N/A' : n.toFixed(1));
  const pct = (a, b) => (!a || !b ? 'N/A' : (((a - b) / b) * 100).toFixed(1) + ' %');
  const hr  = '─'.repeat(68);
  const dhr = '═'.repeat(68);

  const pe = overall.profiling_energy_j;
  const ee = overall.efficient_energy_j;
  const pd = overall.profiling_duration_ms;
  const ed = overall.efficient_duration_ms;

  const lines = [
    dhr,
    '  EXPERIMENT SUMMARY  —  Energy-Aware Test Prioritisation',
    dhr,
    '',
    `  CPU model       : ${overall.cpu_model}`,
    `  TDP estimate    : ${overall.tdp_w} W   (idle baseline: ${overall.idle_baseline_w} W)`,
    `  Runs            : ${overall.num_runs}`,
    `  Sample / run    : ${overall.sample_size}`,
    `  Observations    : ${overall.total_observations}`,
    `  Generated at    : ${overall.generated_at}`,
    '',
    hr,
    '  ENERGY  (Joules)',
    hr,
    `  Mean profiling energy   : ${f4(pe.mean)} J  ± ${f4(pe.stddev)}`,
    `  Mean efficient energy   : ${f4(ee.mean)} J  ± ${f4(ee.stddev)}`,
    `  Mean Δ (profiling−eff)  : ${f4(overall.energy_delta_j.mean)} J  ± ${f4(overall.energy_delta_j.stddev)}`,
    `  Relative saving         : ${pct(pe.mean - ee.mean, pe.mean)}`,
    '',
    hr,
    '  DURATION  (milliseconds)',
    hr,
    `  Mean profiling duration : ${f1(pd.mean)} ms  ± ${f1(pd.stddev)}`,
    `  Mean efficient duration : ${f1(ed.mean)} ms  ± ${f1(ed.stddev)}`,
    `  Mean Δ (profiling−eff)  : ${f1(overall.duration_delta_ms.mean)} ms`,
    '',
    hr,
    '  TOP 10 FILES BY MEAN ENERGY SAVING',
    hr,
    '',
    ...([...byFile]
      .filter(t => t.energy_delta_j.mean != null)
      .sort((a, b) => b.energy_delta_j.mean - a.energy_delta_j.mean)
      .slice(0, 10)
      .map(t =>
        `  ${t.file.padEnd(52)} Δ = ${f4(t.energy_delta_j.mean)} J   (n=${t.samples})`
      )),
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
  console.log(`  Dataset   : ${CONFIG.datasetDir}`);
  console.log(`  Output    : ${CONFIG.outputDir}`);
  console.log(`  Runs      : ${CONFIG.numRuns}   Sample/run: ${CONFIG.sampleSize}`);
  console.log(`  Cooldown  : ${CONFIG.cooldownMs} ms   Warm-up: ${CONFIG.warmupReps}`);
  console.log(`  CPU       : ${os.cpus()[0]?.model ?? 'unknown'}`);
  console.log(`  TDP       : ${TDP_W} W   Idle baseline: ${IDLE_BASELINE_W} W`);

  try { require.resolve('pidusage'); } catch {
    console.error('\n✗ pidusage not found.  Run:  npm install pidusage');
    process.exit(1);
  }

  fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  const allFiles = getAllTestFiles();
  log('📂', `Dataset: ${allFiles.length} test files`);

  await warmUp(allFiles);

  log('🚀', `Starting: ${CONFIG.numRuns} runs × ${CONFIG.sampleSize} files`);
  const t0 = Date.now();

  const rawObservations = await runExperiment(allFiles);
  const elapsed = ((Date.now() - t0) / 60000).toFixed(1);
  log('⏱ ', `Finished in ${elapsed} minutes`);

  if (rawObservations.length === 0) {
    log('❌', 'No observations collected — check that pidusage is installed and the dataset is valid.');
    process.exit(1);
  }

  const byFile  = aggregateByFile(rawObservations);
  const overall = aggregateOverall(rawObservations);

  log('💾', 'Writing results...');
  writeJSON(path.join(CONFIG.outputDir, 'raw.json'),     rawObservations);
  writeJSON(path.join(CONFIG.outputDir, 'by-file.json'), byFile);
  writeJSON(path.join(CONFIG.outputDir, 'overall.json'), overall);
  writeTextSummary(path.join(CONFIG.outputDir, 'summary.txt'), overall, byFile);

  log('🎉', `Done!  Results in: ${CONFIG.outputDir}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });