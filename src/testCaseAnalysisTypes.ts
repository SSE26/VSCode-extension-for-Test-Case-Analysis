import * as vscode from "vscode";

export type TestProfileIdentity = {
  relativeFile: string;
  testName: string;
  sourceHash?: string;
  cacheable: boolean;
};

export type DiscoveredTestCase = TestProfileIdentity & {
  uri: vscode.Uri;
};

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
  actual?: string;
  expected?: string;
};

export type ProfiledTestRuntime = TestRuntime & TestProfileIdentity;

export type PersistedTestProfile = {
  relativeFile: string;
  testName: string;
  sourceHash: string;
  weightedEnergyJ: number;
  lastMeasuredEnergyJ: number;
  sampleCount: number;
  lastUpdatedAt: string;
};

export type TestProfileCacheFile = {
  version: 1;
  entries: Record<string, PersistedTestProfile>;
};

// Store test info
export type ViewState = {
  selectedFiles: vscode.Uri[];
  profiledTests: ProfiledTestRuntime[];
  efficientRunTests: ProfiledTestRuntime[];
  showProfileStatuses: boolean;
  isBusy: boolean;
  status: string;
};
