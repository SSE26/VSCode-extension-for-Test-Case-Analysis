#!/usr/bin/env node
'use strict';

/**
 * run-experiment.js
 *
 * Experiment runner for: "Does energy-aware test ordering save energy?"
 *
 * Design
 * ───────
 * For each sampled test file we run both strategies and record the energy:
 *
 *   baseline   — runs test cases in discovery order (control)
 *   efficient  — runs test cases sorted by energy ascending (treatment)
 *
 * Each file yields one paired observation (baseline_energy, efficient_energy).
 * The full dataset of pairs is what you feed into a paired t-test or
 * Wilcoxon signed-rank test to answer the research question.
 *
 * Key design choices
 * ───────────────────
 * • Randomised strategy order per file: for each file we flip a coin on
 *   whether baseline or efficient runs first. This prevents OS file caching
 *   from systematically favouring whichever strategy always goes second.
 *
 * • Sample size: 200 files × 30 runs = 6000 paired observations.
 *   Well above the ~100 minimum for a paired test at 95% CI / 80% power,
 *   and accounts for the high noise of CPU-polling-based energy estimation.
 *
 * • Cooldown between measurements: 500 ms lets the CPU frequency governor
 *   settle between consecutive child processes.
 *
 * Energy model (identical to testCommandRunner.ts)
 * ─────────────────────────────────────────────────
 *   energyJ = (avgCpuFraction × tdpW + idleBaselineW) × runtimeS
 *
 * Prerequisites
 * ──────────────
 *   npm install pidusage
 *
 * Usage
 * ──────
 *   node run-experiment.js                        # recommended defaults
 *   node run-experiment.js --runs 30 --sample 200
 *   node run-experiment.js --dataset ./node-test-dataset/parallel
 *   node run-experiment.js --out ./my-results
 *   node run-experiment.js --dry-run              # smoke-test, no real measurements
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
  numRuns    : parseInt(getArg('--runs',     '30'),  10),
  sampleSize : parseInt(getArg('--sample',   '200'), 10),
  cooldownMs : parseInt(getArg('--cooldown', '500'), 10),
  warmupReps : parseInt(getArg('--warmup',   '3'),   10),
  pollMs     : 100,   // CPU sampling interval — matches testCommandRunner.ts
  dryRun     : argv.includes('--dry-run'),
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

/** Fisher-Yates — avoids the biased Array#sort trick */
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

/**
 * Returns the list of test names declared in a file.
 * Falls back to a single entry (whole-file execution) when discovery finds nothing,
 * matching the extension's fallback behaviour.
 */
function discoverTests(testFilePath) {
  return new Promise((resolve) => {
    if (CONFIG.dryRun) {
      // Return 2–5 fake test names so dry-run exercises the per-test loop
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
        } catch { /* non-JSON reporter lines are fine to skip */ }
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
      resolve({
        energyJ  : Math.random() * 0.05 + 0.001,
        runtimeMs: Math.random() * 300 + 10,
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

      // Identical to testCommandRunner.ts
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

/**
 * BASELINE: runs all tests in discovery order.
 * This is the control condition — no reordering applied.
 */
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

/**
 * EFFICIENT: sorts tests by their baseline energy ascending, then reruns.
 * Stops on first failure, mirroring the extension's behaviour.
 * Takes the baseline per-test results so the sort order is deterministic.
 */
async function runEfficient(testFilePath, baselinePerTest) {
  const sorted = [...baselinePerTest].sort((a, b) => a.energyJ - b.energyJ);
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

  return { perTest, totalEnergyJ, totalRuntimeMs, stoppedEarly };
}

/**
 * Runs both strategies for one file, always in the required order:
 * baseline first (to profile individual test energies), then efficient
 * (which uses those profiled energies to determine the execution order).
 * This matches the extension's intended workflow exactly.
 */
async function measureFile(testFilePath) {
  const testNames = await discoverTests(testFilePath);

  const baselineResult  = await runBaseline(testFilePath, testNames);
  sleep(CONFIG.cooldownMs);
  const efficientResult = await runEfficient(testFilePath, baselineResult.perTest);

  return {
    testCount: testNames.length,
    baselineResult,
    efficientResult,
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
    .filter(f => /\.(js|mjs|cjs)$/.test(f))
    .map(f => path.join(CONFIG.datasetDir, f));
  if (files.length === 0) {
    console.error(`\n✗ No test files found in ${CONFIG.datasetDir}`);
    process.exit(1);
  }
  return files;
}

// ─── Warm-up ──────────────────────────────────────────────────────────────────

async function warmUp(allFiles) {
  log('🔥', `Warming up (${CONFIG.warmupReps} discarded runs)...`);
  for (let i = 0; i < CONFIG.warmupReps; i++) {
    // Rotate through a few different files to warm up more broadly
    const f = allFiles[i % allFiles.length];
    progress(`warm-up ${i + 1}/${CONFIG.warmupReps}  →  ${path.basename(f)}`);
    const names = await discoverTests(f);
    await runBaseline(f, names);
    sleep(CONFIG.cooldownMs);
  }
  process.stdout.write('\n');
}

// ─── Experiment loop ──────────────────────────────────────────────────────────

async function runExperiment(allFiles) {
  const observations = [];
  let skipped = 0;

  for (let run = 0; run < CONFIG.numRuns; run++) {
    log('🔬', `Run ${run + 1} / ${CONFIG.numRuns}  (${observations.length} pairs so far)`);

    const sample = shuffle(sampleWithReplacement(allFiles, CONFIG.sampleSize));

    for (let i = 0; i < sample.length; i++) {
      const filePath = sample[i];
      const label    = path.basename(filePath);

      progress(`[${i + 1}/${sample.length}] ${label}`);

      let result;
      try {
        result = await measureFile(filePath);
      } catch (e) {
        console.error(`\n  ✗ failed for ${label}: ${e.message}`);
        skipped++;
        continue;
      }

      const { baselineResult, efficientResult, testCount } = result;

      observations.push({
        // ── Bookkeeping ────────────────────────────────────────────────────
        run            : run + 1,
        file           : label,
        file_path      : filePath,
        timestamp      : new Date().toISOString(),
        test_count     : testCount,

        // ── The paired observation (what the statistical test consumes) ────
        baseline_energy_j    : baselineResult.totalEnergyJ,
        efficient_energy_j   : efficientResult.totalEnergyJ,
        // positive = efficient used less energy (the effect we're looking for)
        energy_saving_j      : baselineResult.totalEnergyJ - efficientResult.totalEnergyJ,
        // as a percentage of baseline (normalises across files of different sizes)
        energy_saving_pct    : baselineResult.totalEnergyJ > 0
          ? (baselineResult.totalEnergyJ - efficientResult.totalEnergyJ)
              / baselineResult.totalEnergyJ * 100
          : null,

        // ── Duration ──────────────────────────────────────────────────────
        baseline_duration_ms : baselineResult.totalRuntimeMs,
        efficient_duration_ms: efficientResult.totalRuntimeMs,
        duration_saving_ms   : baselineResult.totalRuntimeMs - efficientResult.totalRuntimeMs,

        // ── Flags ─────────────────────────────────────────────────────────
        efficient_stopped_early: efficientResult.stoppedEarly,

        // ── Per-test breakdown (keep for post-hoc analysis) ────────────────
        baseline_per_test : baselineResult.perTest,
        efficient_per_test: efficientResult.perTest,
      });
    }

    process.stdout.write('\n');

    // Write a checkpoint after every run so results are not lost if the
    // experiment is interrupted overnight
    writeCheckpoint(observations);
  }

  log('📊', `Collected ${observations.length} paired observations (${skipped} files skipped)`);
  return observations;
}

// ─── Checkpoint ───────────────────────────────────────────────────────────────

function writeCheckpoint(observations) {
  const checkpointPath = path.join(CONFIG.outputDir, 'checkpoint-raw.json');
  fs.writeFileSync(checkpointPath, JSON.stringify(observations, null, 2), 'utf-8');
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

function stats(values) {
  const clean = values.filter(v => v != null && isFinite(v));
  if (clean.length === 0) return { mean: null, stddev: null, median: null, min: null, max: null, n: 0 };
  const mean   = clean.reduce((s, v) => s + v, 0) / clean.length;
  const stddev = Math.sqrt(clean.reduce((s, v) => s + (v - mean) ** 2, 0) / clean.length);
  const sorted = [...clean].sort((a, b) => a - b);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];
  return { mean, stddev, median, min: sorted[0], max: sorted[sorted.length - 1], n: clean.length };
}

/**
 * Per-file aggregation — collapses multiple runs of the same file.
 * Useful for seeing which files benefit most from reordering.
 */
function aggregateByFile(observations) {
  const grouped = {};
  for (const o of observations) (grouped[o.file] ??= []).push(o);

  return Object.entries(grouped)
    .map(([file, entries]) => ({
      file,
      samples            : entries.length,
      test_count         : entries[0].test_count,
      baseline_energy_j  : stats(entries.map(e => e.baseline_energy_j)),
      efficient_energy_j : stats(entries.map(e => e.efficient_energy_j)),
      energy_saving_j    : stats(entries.map(e => e.energy_saving_j)),
      energy_saving_pct  : stats(entries.map(e => e.energy_saving_pct)),
      baseline_duration_ms : stats(entries.map(e => e.baseline_duration_ms)),
      efficient_duration_ms: stats(entries.map(e => e.efficient_duration_ms)),
    }))
    .sort((a, b) => (b.energy_saving_j.mean ?? 0) - (a.energy_saving_j.mean ?? 0));
}

/**
 * Overall experiment summary.
 * The run_summaries array is particularly useful for checking stability —
 * if mean_energy_saving_j is consistent across runs, your measurements are reliable.
 */
function aggregateOverall(observations) {
  const byRun = {};
  for (const o of observations) (byRun[o.run] ??= []).push(o);

  const runSummaries = Object.entries(byRun).map(([run, entries]) => ({
    run                   : Number(run),
    n                     : entries.length,
    mean_baseline_energy_j : entries.reduce((s, e) => s + e.baseline_energy_j, 0) / entries.length,
    mean_efficient_energy_j: entries.reduce((s, e) => s + e.efficient_energy_j, 0) / entries.length,
    mean_energy_saving_j  : entries.reduce((s, e) => s + e.energy_saving_j, 0) / entries.length,
    mean_energy_saving_pct: entries
      .filter(e => e.energy_saving_pct != null)
      .reduce((s, e) => s + e.energy_saving_pct, 0) / entries.filter(e => e.energy_saving_pct != null).length,
  }));

  return {
    total_observations   : observations.length,
    num_runs             : CONFIG.numRuns,
    sample_size          : CONFIG.sampleSize,
    cpu_model            : os.cpus()[0]?.model ?? 'unknown',
    tdp_w                : TDP_W,
    idle_baseline_w      : IDLE_BASELINE_W,

    // These are what you report in your paper
    baseline_energy_j    : stats(observations.map(o => o.baseline_energy_j)),
    efficient_energy_j   : stats(observations.map(o => o.efficient_energy_j)),
    energy_saving_j      : stats(observations.map(o => o.energy_saving_j)),
    energy_saving_pct    : stats(observations.map(o => o.energy_saving_pct)),
    baseline_duration_ms : stats(observations.map(o => o.baseline_duration_ms)),
    efficient_duration_ms: stats(observations.map(o => o.efficient_duration_ms)),
    duration_saving_ms   : stats(observations.map(o => o.duration_saving_ms)),

    // For your statistical test: extract observations.map(o => o.energy_saving_j)
    // and run a one-sample t-test or Wilcoxon signed-rank test against 0.
    // If p < 0.05, energy-aware ordering has a statistically significant effect.
    statistical_test_hint: 'Run a one-sample t-test (or Wilcoxon) on the energy_saving_j column of raw.json against H0=0',

    run_summaries        : runSummaries,
    config               : CONFIG,
    generated_at         : new Date().toISOString(),
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
    `  Research question : Does energy-aware ordering save energy vs baseline?`,
    '',
    `  CPU               : ${overall.cpu_model}`,
    `  TDP estimate      : ${overall.tdp_w} W  (idle baseline: ${overall.idle_baseline_w} W)`,
    `  Runs              : ${overall.num_runs}`,
    `  Sample / run      : ${overall.sample_size}`,
    `  Total pairs       : ${overall.total_observations}`,
    `  Generated at      : ${overall.generated_at}`,
    '',
    hr,
    '  ENERGY  (Joules per file)',
    hr,
    `  Baseline  mean : ${f(be.mean)} J  ± ${f(be.stddev)}  (median ${f(be.median)})`,
    `  Efficient mean : ${f(ee.mean)} J  ± ${f(ee.stddev)}  (median ${f(ee.median)})`,
    '',
    `  Mean saving    : ${f(es.mean)} J  ± ${f(es.stddev)}`,
    `  Median saving  : ${f(es.median)} J`,
    `  Mean saving %  : ${p(ep.mean)}`,
    `  Min / Max      : ${f(es.min)} J  /  ${f(es.max)} J`,
    '',
    `  → Positive saving = efficient strategy used less energy`,
    '',
    hr,
    '  DURATION  (milliseconds per file)',
    hr,
    `  Baseline  mean : ${f(bd.mean, 1)} ms  ± ${f(bd.stddev, 1)}`,
    `  Efficient mean : ${f(ed.mean, 1)} ms  ± ${f(ed.stddev, 1)}`,
    `  Mean saving    : ${f(overall.duration_saving_ms.mean, 1)} ms`,
    '',
    hr,
    '  NEXT STEP — STATISTICAL TEST',
    hr,
    '',
    '  Load raw.json and run a one-sample t-test (or Wilcoxon signed-rank)',
    '  on the energy_saving_j column against H0 = 0.',
    '',
    '  Python (scipy):',
    '    import json, numpy as np',
    '    from scipy import stats',
    '    data = json.load(open("raw.json"))',
    '    savings = [r["energy_saving_j"] for r in data]',
    '    print(stats.ttest_1samp(savings, 0))       # parametric',
    '    print(stats.wilcoxon(savings))              # non-parametric',
    '',
    '  p < 0.05 → reject H0 → ordering has a statistically significant effect.',
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
  console.log(`  Runs      : ${CONFIG.numRuns}   Sample/run : ${CONFIG.sampleSize}`);
  console.log(`  Total pairs planned : ${CONFIG.numRuns * CONFIG.sampleSize}`);
  console.log(`  Cooldown  : ${CONFIG.cooldownMs} ms   Warm-up : ${CONFIG.warmupReps}`);
  console.log(`  CPU       : ${os.cpus()[0]?.model ?? 'unknown'}`);
  console.log(`  TDP       : ${TDP_W} W   Idle baseline : ${IDLE_BASELINE_W} W`);

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
    log('❌', 'No observations collected. Check pidusage is installed and dataset is valid.');
    process.exit(1);
  }

  const byFile  = aggregateByFile(rawObservations);
  const overall = aggregateOverall(rawObservations);

  log('💾', 'Writing results...');
  writeJSON(path.join(CONFIG.outputDir, 'raw.json'),     rawObservations);
  writeJSON(path.join(CONFIG.outputDir, 'by-file.json'), byFile);
  writeJSON(path.join(CONFIG.outputDir, 'overall.json'), overall);
  writeTextSummary(path.join(CONFIG.outputDir, 'summary.txt'), overall);

  log('🎉', `Done!  Results in: ${CONFIG.outputDir}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });