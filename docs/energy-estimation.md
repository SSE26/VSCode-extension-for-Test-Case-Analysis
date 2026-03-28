# Energy Estimation — Developer Reference

This document explains the energy estimation feature added to the Test Case Analysis extension. It covers what was changed, why each change was made, and how the pieces connect to each other.

---

## Why energy instead of runtime?

The original extension measured test efficiency using **wall-clock duration** (`duration_ms`). While runtime is easy to measure, it is a weak proxy for energy consumption — a test that runs for 500ms at 5% CPU draws far less energy than one that runs for 500ms at 95% CPU.

The replacement metric is based on a **CPU Time × Power Model**, which is the approach used by tools like Cloud Carbon Footprint and documented in academic literature on software energy estimation (Springer, 2021). The formula is:

```
Estimated Energy (J) = (avg_cpu_fraction × TDP_W + idle_baseline_W) × duration_s
```

- **`avg_cpu_fraction`** — the average fraction of the CPU the test process used (0.0–1.0), sampled via `pidusage`
- **`TDP_W`** — the CPU's Thermal Design Power in watts, auto-detected from the hardware
- **`idle_baseline_W`** — a constant accounting for the power a CPU draws even at 0% load, estimated as a configurable percentage of TDP (default 12.5%)
- **`duration_s`** — the wall-clock test duration in seconds (still parsed from `node --test` output)

---

## Files changed and their roles

### 1. `src/cpuEnergyEstimator.ts` — NEW FILE

**What it does:** Supplies the two hardware constants that feed into the energy formula: `TDP_W` and `idle_baseline_W`.

**`detectTdpWatts()`**
Determines the CPU's TDP by:
1. Checking if the user has manually set `testCaseAnalysis.tdpWatts` in VSCode settings (takes priority)
2. Querying the OS for the CPU model name string:
   - Windows: PowerShell + WMI (`Get-WmiObject Win32_Processor`)
   - Linux: `/proc/cpuinfo`
   - macOS: `sysctl -n machdep.cpu.brand_string`
3. Matching the model name against a lookup table of known CPUs and their TDP values (Intel Core Ultra, Intel 10th–14th Gen, AMD Ryzen 5000/7000, Apple Silicon, Intel desktop)
4. Falling back to 45W if no match is found (mid-range laptop H-series default)

The result is cached after the first call so the OS is not queried repeatedly during a profiling run.

**`getIdleBaselineW(tdpW)`**
Returns `TDP × idleBaselinePercent / 100`. The percentage is read from the VSCode setting `testCaseAnalysis.idleBaselinePercent` (default 12.5%). This constant is added to every energy estimate regardless of CPU load, representing the power a modern CPU draws even when idle.

**Why this is a separate file:** These functions are hardware-facing concerns — they talk to the OS and VSCode settings — and are completely independent of how tests are run. Keeping them separate makes the lookup table easy to extend and the test runner logic easier to read.

---

### 2. `src/testCommandRunner.ts` — CORE MEASUREMENT LOGIC

**What it does:** Runs a single test case and returns its energy estimate alongside the existing runtime fields.

**Key change 1 — `spawn` replaces `execAsync`**

The old code used `execAsync` (a promisified `exec`), which fires the command through a shell and returns only when it is fully finished. This makes CPU monitoring impossible because:
- With a shell wrapper, the PID you get belongs to `cmd.exe` or `/bin/sh`, not the Node test process
- There is no live handle to the process while it is running

`spawn` with `shell: false` gives a direct handle (`child`) to the Node process itself, including its real PID (`child.pid`). The command string is first split into `[executable, ...args]` by `parseCommand()` (a simple tokenizer that respects double-quoted tokens) so it can be passed to `spawn` without a shell.

**Key change 2 — CPU sampling loop**

After spawning, a `setInterval` fires every 100ms. Each tick calls `pidusage(child.pid)`, which reads the process's current CPU usage percentage directly from the OS (via `/proc` on Linux, `ps` on macOS, and Windows performance counters). The reading is pushed into a `cpuSamples` array.

A `polling` flag prevents a new sample from starting before the previous async call has resolved, avoiding overlapping reads.

**Key change 3 — Energy computed on process close**

When the test process exits (the `close` event fires), the polling loop is stopped and the energy is calculated in one step:

```typescript
const avgCpuFraction = cpuSamples.length > 0
  ? cpuSamples.reduce((sum, s) => sum + s, 0) / cpuSamples.length / 100
  : 0;

const energyJ = (avgCpuFraction * tdpW + idleBaselineW) * runtimeS;
```

Using the **average** CPU fraction over total runtime (rather than accumulating energy tick by tick) means the result is correct even if only one sample was captured — or none at all. For tests that complete in under 100ms (faster than one polling interval), `avgCpuFraction` is 0 and the energy equals `idleBaselineW × runtimeS`, which is the minimum physically plausible energy for that duration.

The `runtimeMs` field (parsed from `node --test`'s `duration_ms` output) is retained alongside `energyJ` for validation and context.

---

### 3. `src/testCaseAnalysisTypes.ts` — DATA MODEL

**What it does:** Defines the shape of data that flows between the runner, controller, and webview.

Two fields were added to `TestRuntime`:

| Field | Meaning |
|---|---|
| `energyJ` | Energy measured in the most recent run (joules) |
| `profiledEnergyJ` | Energy from the profiling run — used as the stable reference for ordering during the efficient run |

The `runtimeMs` and `profiledRuntimeMs` fields are kept for backwards compatibility and to allow cross-referencing energy against duration.

**Why this matters architecturally:** `TestRuntime` is the shared contract between all three layers (runner → controller → webview). Adding the fields here ensures TypeScript enforces that every layer passes and receives them correctly.

---

### 4. `src/testCaseAnalysisController.ts` — ORCHESTRATION

**What it does:** Coordinates profiling and efficient-run phases, and prepares data for the webview.

Three changes were made:

1. **Sort order** — profiled tests are now sorted by `energyJ` ascending (lowest energy first) instead of `runtimeMs`. The efficient run then executes them in this order.

2. **Efficient run result construction** — when building `executedTest`, `profiledEnergyJ` is copied from the profiled test record (the stable reference) while `energyJ` comes from the new live run result.

3. **`postState`** — `energyJ` and `profiledEnergyJ` are included in the data object sent to the webview via `postMessage`.

---

### 5. `src/webviewHtml.ts` — DISPLAY

**What it does:** Renders the sidebar UI.

- The "Measured Test Runtimes" panel was renamed to **"Measured Test Energy"**
- Test entries now display `energyJ × 1000` formatted to 3 decimal places in **millijoules (mJ)** rather than milliseconds
- The efficient run panel shows `profiledEnergyJ` in mJ (the profiled reference value)

Millijoules were chosen as the display unit because joules produces very small numbers (e.g. `0.000281 J`) that are hard to read, while mJ gives values in the `0.1–500` range for typical short test cases.

---

### 6. `package.json` — SETTINGS AND DEPENDENCY

Two VSCode settings were added under `testCaseAnalysis`:

| Setting | Default | Purpose |
|---|---|---|
| `tdpWatts` | *(empty)* | Manual TDP override in watts; auto-detection is used when empty |
| `idleBaselinePercent` | `12.5` | Idle power as a percentage of TDP; adjustable per user/environment |

`pidusage` was added as a runtime dependency (not devDependency) because it is required at extension runtime, not just during compilation.

---

### 7. `tsconfig.json`

`"esModuleInterop": true` was added to allow `import pidusage from "pidusage"` syntax. Without it, TypeScript requires the less ergonomic `import pidusage = require("pidusage")` form for CommonJS modules.

---

## Data flow diagram

```
cpuEnergyEstimator.ts
  detectTdpWatts()    ─────────────────────────────┐
  getIdleBaselineW()  ─────────────────────────────┤
                                                    ▼
testCommandRunner.ts                        executeSingleTestCase()
  spawn(node --test ...)  →  child.pid              │
  setInterval → pidusage(pid) → cpuSamples[]        │
  on("close") → energyJ = formula                   │
                                                    ▼
testCaseAnalysisTypes.ts               TestRuntime { energyJ, profiledEnergyJ, ... }
                                                    │
                                                    ▼
testCaseAnalysisController.ts          sort by energyJ
                                       postState() → webview message
                                                    │
                                                    ▼
webviewHtml.ts                         display in mJ
```

---

## Known limitations

- **Sub-100ms tests** — tests faster than one polling interval will have `avgCpuFraction = 0`. Their energy estimate is `idleBaselineW × runtimeS` only. This is physically correct (the CPU was barely loaded) but does not capture any active CPU contribution.
- **System-level noise** — `pidusage` reads OS-level CPU metrics for the process, which can include brief spikes from unrelated system activity coinciding with a poll.
- **Windows `.cmd` commands** — because `spawn` is used with `shell: false`, commands that rely on `.cmd` wrappers (e.g. `npx`, `jest`) must be written with the explicit extension in the command template setting (e.g. `npx.cmd jest`). The default `node --test` command is unaffected.
- **TDP accuracy** — TDP is a manufacturer-rated thermal envelope, not a real-time power measurement. Actual power draw can be lower (power-saving states) or briefly higher (turbo boost). The model is a defensible estimate, not a precise measurement.
