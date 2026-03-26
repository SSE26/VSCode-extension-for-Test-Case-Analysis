import * as vscode from "vscode";
import { exec } from "child_process";
import { promisify } from "util";
import { TestRuntime } from "./testCaseAnalysisTypes";

const execAsync = promisify(exec);

// Run one test case and measure how long it takes
export async function executeSingleTestCase(
  uri: vscode.Uri,
  testName: string,
  commandTemplate: string
): Promise<TestRuntime> {
  const workspaceFolder = getWorkspaceFolderForUri(uri);
  const command = buildCommand(uri, testName, commandTemplate, workspaceFolder);

  try {
    const execution = await execAsync(command, {
      cwd: workspaceFolder?.uri.fsPath ?? vscode.workspace.rootPath,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    });
    const runtimeMs = getReportedRuntimeMs(execution.stdout, execution.stderr);
    if (runtimeMs === undefined) {
      throw new Error("Could not read duration_ms from node --test output.");
    }

    return {
      uri,
      testName,
      runtimeMs,
      profiledRuntimeMs: runtimeMs,
      lastRunPassed: true,
      errorMessage: ""
    };
  } catch (error) {
    const execError = error as {
      message?: string;
      stderr?: string;
      stdout?: string;
    };
    const runtimeMs = getReportedRuntimeMs(execError.stdout, execError.stderr);
    const errorMessage = [
      execError.message,
      execError.stderr?.trim(),
      execError.stdout?.trim()
    ]
      .filter((value) => Boolean(value))
      .join("\n")
      .trim();

    const regexFilter = /\{[^{}]*\}/s;
    var actual: string | undefined = undefined;
    var expected: string | undefined = undefined;
    if (errorMessage != null) {
      const jsonMatch = errorMessage.match(regexFilter);
      if (jsonMatch != null) {
        const jsonString = jsonMatch[0]
          .replace(/(\w+):/g, '"$1":')
          .replace(/'/g, '"');
        const parsed = JSON.parse(jsonString);
        actual = parsed.actual;
        expected = parsed.expected;
      }
    }

    return {
      uri,
      testName,
      runtimeMs: runtimeMs ?? 0,
      profiledRuntimeMs: runtimeMs ?? 0,
      lastRunPassed: false,
      errorMessage,
      actual,
      expected
    };
  }
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

// Get main project folder
function getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

// Find which folder a file belongs to
function getWorkspaceFolderForUri(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(uri) ?? getPrimaryWorkspaceFolder();
}

// Put strings in quotes, to make sure terminal understands
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
