import * as vscode from "vscode";
import { readFile } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { getWebviewHtml } from "./webviewHtml";

const execAsync = promisify(exec);
const DEFAULT_VIEW_ID = "testCaseAnalysis.sidebarView";

// Store test info
type TestRuntime = {
  uri: vscode.Uri;
  testName: string;
  runtimeMs: number;
  profiledRuntimeMs: number;
  lastRunPassed: boolean;
  errorMessage?: string;
};

// Store test info
type ViewState = {
  selectedFiles: vscode.Uri[];
  profiledTests: TestRuntime[];
  efficientRunTests: TestRuntime[];
  isBusy: boolean;
  status: string;
};

class TestCaseAnalysisController {
  private readonly state: ViewState = {
    selectedFiles: [],
    profiledTests: [],
    efficientRunTests: [],
    isBusy: false,
    status: "Select test files to begin."
  };

  private view?: vscode.WebviewView;

  // Custom sidebar screen that allows users to select test files, profile tests, and run them efficiently
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true
    };
    view.webview.html = getWebviewHtml();
    view.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case "selectFiles":
          void this.selectFiles();
          break;
        case "profileTests":
          void this.profileSelectedTests();
          break;
        case "runEfficiently":
          void this.runTestsEfficiently();
          break;
        default:
          break;
      }
    });

    this.postState();
  }

  // Let the user select which files they want to analyze
  async selectFiles(): Promise<void> {
    const workspaceFolder = this.getPrimaryWorkspaceFolder();
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      defaultUri: workspaceFolder?.uri,
      openLabel: "Select Test Files",
      filters: {
        "Test files": ["js", "cjs", "mjs", "ts", "cts", "mts", "jsx", "tsx"]
      }
    });

    if (!uris || uris.length === 0) {
      return;
    }

    this.state.selectedFiles = uris;
    this.state.profiledTests = [];
    this.state.efficientRunTests = [];
    this.state.status = `Selected ${uris.length} test file${uris.length === 1 ? "" : "s"}.`;
    this.postState();
  }

  // Run each test by itself and save how long it takes
  async profileSelectedTests(): Promise<void> {
    if (!(await this.ensureSelectedFiles())) {
      return;
    }

    const profileCommandTemplate = this.getConfiguredCommand();

    await this.runBusyTask("Profiling individual tests...", async () => {
      const discoveredTests = await this.discoverSelectedTests();
      if (discoveredTests.length === 0) {
        this.state.profiledTests = [];
        this.state.efficientRunTests = [];
        this.state.status = "No individual test cases were found in the selected files.";
        void vscode.window.showWarningMessage(
          "No individual test cases were found. This discovery step currently supports direct test(...) and it(...) calls."
        );
        return;
      }

      const profiledTests: TestRuntime[] = [];
      for (const discoveredTest of discoveredTests) {
        const result = await this.executeSingleTestCase(
          discoveredTest.uri,
          discoveredTest.testName,
          profileCommandTemplate
        );
        profiledTests.push(result);
      }

      profiledTests.sort((left, right) => left.runtimeMs - right.runtimeMs);
      this.state.profiledTests = profiledTests;
      this.state.efficientRunTests = [];
      this.state.status = `Profiled ${profiledTests.length} individual test case${profiledTests.length === 1 ? "" : "s"}.`;
    });
  }

  // Run the saved tests from fastest to slowest
  async runTestsEfficiently(): Promise<void> {
    if (this.state.profiledTests.length === 0) {
      void vscode.window.showWarningMessage("Profile the selected test cases before running them efficiently.");
      return;
    }

    if (!(await this.ensureSelectedFiles())) {
      return;
    }

    const efficientCommandTemplate = this.getConfiguredCommand();

    await this.runBusyTask("Running profiled tests from shortest to longest...", async () => {
      const executedTests: TestRuntime[] = [];
      this.state.efficientRunTests = [];
      this.postState();
      for (const test of this.state.profiledTests) {
        const result = await this.executeSingleTestCase(
          test.uri,
          test.testName,
          efficientCommandTemplate
        );
        const executedTest: TestRuntime = {
          uri: test.uri,
          testName: test.testName,
          runtimeMs: result.runtimeMs,
          profiledRuntimeMs: test.profiledRuntimeMs,
          lastRunPassed: result.lastRunPassed,
          errorMessage: result.errorMessage
        };
        executedTests.push(executedTest);
        this.state.efficientRunTests = [...executedTests];
        this.postState();
        if (!result.lastRunPassed) {
          this.state.status = `Stopped after failure: ${this.formatTestLabel(executedTest.uri, executedTest.testName)}`;
          void vscode.window.showErrorMessage(
            `Test execution stopped after failure in ${this.formatTestLabel(executedTest.uri, executedTest.testName)}.`
          );
          return;
        }
      }

      this.state.status = `Executed ${executedTests.length} individual test case${executedTests.length === 1 ? "" : "s"} in runtime order.`;
      void vscode.window.showInformationMessage("Efficient test run completed without failures.");
    });
  }

  // Discover test cases in the selected files
  private async discoverSelectedTests(): Promise<Array<{ uri: vscode.Uri; testName: string }>> {
    const discoveredTests: Array<{ uri: vscode.Uri; testName: string }> = [];

    for (const uri of this.state.selectedFiles) {
      const source = await readFile(uri.fsPath, "utf8");
      const testNames = this.extractTestNames(source);
      for (const testName of testNames) {
        discoveredTests.push({ uri, testName });
      }
    }

    return discoveredTests;
  }

  // Extract test names using regex
  private extractTestNames(source: string): string[] {
    const names: string[] = [];
    const testPattern = /\b(?:test|it)\s*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;
    let match: RegExpExecArray | null;

    do {
      match = testPattern.exec(source);
      if (match?.[2]) {
        names.push(match[2]);
      }
    } while (match);

    return [...new Set(names)];
  }

  // Make sure that the user has selected files
  private async ensureSelectedFiles(): Promise<boolean> {
    if (this.state.selectedFiles.length > 0) {
      return true;
    }

    void vscode.window.showWarningMessage("Select at least one test file first.");
    return false;
  }

  // Mark the extension as busy while a task is running
  private async runBusyTask(status: string, task: () => Promise<void>): Promise<void> {
    if (this.state.isBusy) {
      void vscode.window.showWarningMessage("Test Case Analysis is already running a task.");
      return;
    }

    this.state.isBusy = true;
    this.state.status = status;
    this.postState();

    try {
      await task();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.status = `Error: ${message}`;
      void vscode.window.showErrorMessage(`Test Case Analysis error: ${message}`);
    } finally {
      this.state.isBusy = false;
      this.postState();
    }
  }

  // Run one test case and measure how long it takes
  private async executeSingleTestCase(
    uri: vscode.Uri,
    testName: string,
    commandTemplate: string
  ): Promise<TestRuntime> {
    const workspaceFolder = this.getWorkspaceFolderForUri(uri);
    const command = this.buildCommand(uri, testName, commandTemplate, workspaceFolder);

    const startedAt = process.hrtime.bigint();
    try {
      await execAsync(command, {
        cwd: workspaceFolder?.uri.fsPath ?? vscode.workspace.rootPath,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      });
      const runtimeMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      return {
        uri,
        testName,
        runtimeMs,
        profiledRuntimeMs: runtimeMs,
        lastRunPassed: true,
        errorMessage: ""
      };
    } catch (error) {
      const runtimeMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const execError = error as {
        message?: string;
        stderr?: string;
        stdout?: string;
      };
      const errorMessage = [
        execError.message,
        execError.stderr?.trim(),
        execError.stdout?.trim()
      ]
        .filter((value) => Boolean(value))
        .join("\n")
        .trim();
      return {
        uri,
        testName,
        runtimeMs,
        profiledRuntimeMs: runtimeMs,
        lastRunPassed: false,
        errorMessage
      };
    }
  }

  // Fill the command template with the file and test values
  private buildCommand(
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
      .replaceAll("${file}", this.quoteShellArgument(uri.fsPath))
      .replaceAll("${relativeFile}", this.quoteShellArgument(relativePath))
      .replaceAll("${testName}", this.quoteShellArgument(testName))
      .replaceAll(
        "${testNamePattern}",
        this.quoteShellArgument(escapeRegex(testName))
      );
  }

  // Read the test command from the extension settings
  private getConfiguredCommand(): string {
    const configuration = vscode.workspace.getConfiguration("testCaseAnalysis");
    const command = configuration.get<string>("testCommandTemplate")?.trim();

    return command || "node --test --test-name-pattern ${testNamePattern} ${relativeFile}";
  }

  // Get main project folder
  private getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  // Find which folder a file belongs to
  private getWorkspaceFolderForUri(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(uri) ?? this.getPrimaryWorkspaceFolder();
  }

  // Put strings in quotes, to make sure terminal understands
  private quoteShellArgument(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  // Make path readable
  private formatPath(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false);
  }

  // Get file name
  private formatFileName(uri: vscode.Uri): string {
    return uri.path.split("/").pop() ?? uri.fsPath.split("\\").pop() ?? uri.fsPath;
  }

  // Format the test label for display
  private formatTestLabel(uri: vscode.Uri, testName: string): string {
    return `${this.formatPath(uri)} :: ${testName}`;
  }

  // Send the latest data to the UI
  private postState(): void {
    this.view?.webview.postMessage({
      type: "state",
      value: {
        selectedFiles: this.state.selectedFiles.map((uri) => this.formatPath(uri)),
        profiledTests: this.state.profiledTests.map((test) => ({
          fileName: this.formatFileName(test.uri),
          testName: test.testName,
          runtimeMs: test.runtimeMs,
          profiledRuntimeMs: test.profiledRuntimeMs,
          lastRunPassed: test.lastRunPassed
        })),
        efficientRunTests: this.state.efficientRunTests.map((test) => ({
          fileName: this.formatFileName(test.uri),
          testName: test.testName,
          runtimeMs: test.runtimeMs,
          profiledRuntimeMs: test.profiledRuntimeMs,
          lastRunPassed: test.lastRunPassed
        })),
        isBusy: this.state.isBusy,
        status: this.state.status
      }
    });
  }
}

// Connect controller to VS Code UI
class TestCaseAnalysisWebviewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly controller: TestCaseAnalysisController) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.controller.resolveWebviewView(webviewView);
  }
}

// Start the sidebar and register the extension commands
export function activate(context: vscode.ExtensionContext): void {
  const controller = new TestCaseAnalysisController();
  const provider = new TestCaseAnalysisWebviewProvider(controller);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DEFAULT_VIEW_ID, provider),
    vscode.commands.registerCommand("testCaseAnalysis.selectFiles", () => controller.selectFiles()),
    vscode.commands.registerCommand("testCaseAnalysis.profileTests", () => controller.profileSelectedTests()),
    vscode.commands.registerCommand("testCaseAnalysis.runTestsEfficiently", () => controller.runTestsEfficiently())
  );
}

// Make test name safe for regex
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
