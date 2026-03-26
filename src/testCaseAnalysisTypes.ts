import * as vscode from "vscode";

// Store test info
export type TestRuntime = {
  uri: vscode.Uri;
  testName: string;
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
