import * as vscode from "vscode";
import { spawn } from "child_process";
import pidusage from "pidusage";
import { detectTdpWatts, getIdleBaselineW } from "./cpuEnergyEstimator";
import { TestRuntime } from "./testCaseAnalysisTypes";

// How often (ms) to sample the child process CPU usage
const POLL_INTERVAL_MS = 100;

// Run one test case and estimate how much energy it consumes
export async function executeSingleTestCase(
  uri: vscode.Uri,
  testName: string,
  commandTemplate: string
): Promise<TestRuntime> {
  const workspaceFolder = getWorkspaceFolderForUri(uri);
  const command = buildCommand(uri, testName, commandTemplate, workspaceFolder);
  const cwd = workspaceFolder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const tdpW = await detectTdpWatts();
  const idleBaselineW = getIdleBaselineW(tdpW);

  return new Promise<TestRuntime>((resolve) => {
    // Parse the command string into [executable, ...args] so we spawn the test
    // process directly — this gives us the real PID, not a shell wrapper.
    // Limitation: on Windows, .cmd-based commands (npx, jest) must be spelled
    // with the .cmd extension in the command template (e.g. npx.cmd).
    const [executable, ...args] = parseCommand(command);

    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      // No shell: we want the direct PID of the Node process for CPU tracking.
      // The default command (node --test ...) works on all platforms without a shell.
      shell: false
    });

    let stdout = "";
    let stderr = "";
    let energyJ = 0;
    let lastPollTime = Date.now();
    let polling = false;

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    // Periodically sample the child's CPU usage and accumulate energy
    const poll = setInterval(() => {
      const pid = child.pid;
      if (pid === undefined || polling) {
        return;
      }
      polling = true;
      pidusage(pid)
        .then((stats) => {
          const now = Date.now();
          const dtS = (now - lastPollTime) / 1000;
          // Estimated energy = (cpu_fraction × TDP + idle_baseline) × Δtime
          energyJ += (stats.cpu / 100 * tdpW + idleBaselineW) * dtS;
          lastPollTime = now;
        })
        .catch(() => {
          // Process may have just exited — safe to ignore
        })
        .finally(() => {
          polling = false;
        });
    }, POLL_INTERVAL_MS);

    child.on("close", (code) => {
      clearInterval(poll);
      void pidusage.clear();

      const runtimeMs = getReportedRuntimeMs(stdout, stderr) ?? 0;
      resolve({
        uri,
        testName,
        energyJ,
        profiledEnergyJ: energyJ,
        runtimeMs,
        profiledRuntimeMs: runtimeMs,
        lastRunPassed: code === 0,
        errorMessage: code !== 0
          ? [stderr?.trim(), stdout?.trim()].filter(Boolean).join("\n").trim()
          : ""
      });
    });

    child.on("error", (err) => {
      clearInterval(poll);
      void pidusage.clear();
      resolve({
        uri,
        testName,
        energyJ: 0,
        profiledEnergyJ: 0,
        runtimeMs: 0,
        profiledRuntimeMs: 0,
        lastRunPassed: false,
        errorMessage: err.message
      });
    });
  });
}

// Read the test command from the extension settings
export function getConfiguredCommand(): string {
  const configuration = vscode.workspace.getConfiguration("testCaseAnalysis");
  const command = configuration.get<string>("testCommandTemplate")?.trim();

  return command || "node --test --test-name-pattern ${testNamePattern} ${relativeFile}";
}

// Fill the command template with the file and test values
function buildCommand(
  uri: vscode.Uri,
  testName: string,
  commandTemplate: string,
  workspaceFolder: vscode.WorkspaceFolder | undefined
): string {
  const relativePath =
    workspaceFolder !== undefined
      ? vscode.workspace.asRelativePath(uri, false)
      : uri.fsPath;

  return commandTemplate
    .replaceAll("${file}", quoteShellArgument(uri.fsPath))
    .replaceAll("${relativeFile}", quoteShellArgument(relativePath))
    .replaceAll("${testName}", quoteShellArgument(testName))
    .replaceAll("${testNamePattern}", quoteShellArgument(escapeRegex(testName)));
}

// Split a shell-style command string into [executable, ...args].
// Handles double-quoted tokens (stripping the quotes).
function parseCommand(command: string): [string, ...string[]] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;

  for (const char of command) {
    if (char === '"' && !inQuotes) {
      inQuotes = true;
    } else if (char === '"' && inQuotes) {
      inQuotes = false;
    } else if (char === " " && !inQuotes) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    throw new Error("Command template produced an empty command.");
  }

  return tokens as [string, ...string[]];
}

// Get main project folder
function getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

// Find which folder a file belongs to
function getWorkspaceFolderForUri(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(uri) ?? getPrimaryWorkspaceFolder();
}

// Put strings in quotes, to make sure the terminal understands
function quoteShellArgument(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

// Read the duration_ms value from the test output
function getReportedRuntimeMs(stdout?: string, stderr?: string): number | undefined {
  const combinedOutput = [stdout, stderr].filter((value): value is string => Boolean(value)).join("\n");
  if (combinedOutput.length === 0) {
    return undefined;
  }

  const summaryMatch = combinedOutput.match(/(?:^|\n)[^\S\r\n]*[iℹ]\s+duration_ms\s+([0-9.]+)\s*(?:\n|$)/);
  if (summaryMatch?.[1]) {
    return Number(summaryMatch[1]);
  }

  const diagnosticMatches = [...combinedOutput.matchAll(/duration_ms:\s*([0-9.]+)/g)];
  if (diagnosticMatches.length > 0) {
    const lastMatch = diagnosticMatches[diagnosticMatches.length - 1]?.[1];
    if (lastMatch) {
      return Number(lastMatch);
    }
  }

  return undefined;
}

// Make test name safe for regex
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
