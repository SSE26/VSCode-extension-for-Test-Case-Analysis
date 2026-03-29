import * as vscode from "vscode";

// Store test info
export type TestRuntime = {
  uri: vscode.Uri;
  testName: string;
  // Estimated energy in joules: (cpu_fraction × TDP + idle_baseline) × elapsed_seconds
  energyJ: number;
  // Energy recorded during the profiling run, used as the reference for efficient ordering
  profiledEnergyJ: number;
  // Wall-clock duration reported by node --test (kept for context / validation)
  runtimeMs: number;
  profiledRuntimeMs: number;
  lastRunPassed: boolean;
  errorMessage?: string;
};

// Store test info
export type ViewState = {
  selectedFiles: vscode.Uri[];
  profiledTests: TestRuntime[];
  efficientRunTests: TestRuntime[];
  isBusy: boolean;
  status: string;
};
