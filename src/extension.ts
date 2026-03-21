import * as vscode from "vscode";
import { readFile } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const DEFAULT_VIEW_ID = "testCaseAnalysis.sidebarView";

type TestRuntime = {
  uri: vscode.Uri;
  testName: string;
  runtimeMs: number;
  profiledRuntimeMs: number;
  lastRunPassed: boolean;
  errorMessage?: string;
};

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

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true
    };
    view.webview.html = this.getWebviewHtml();
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

  dispose(): void {
    return;
  }

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

  async profileSelectedTests(): Promise<void> {
    if (!(await this.ensureSelectedFiles())) {
      return;
    }

    const profileCommandTemplate = this.getConfiguredCommand("testCommandTemplate");
    if (!profileCommandTemplate) {
      return;
    }

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
          profileCommandTemplate,
          "profile"
        );
        profiledTests.push(result);
      }

      profiledTests.sort((left, right) => left.runtimeMs - right.runtimeMs);
      this.state.profiledTests = profiledTests;
      this.state.efficientRunTests = [];
      this.state.status = `Profiled ${profiledTests.length} individual test case${profiledTests.length === 1 ? "" : "s"}.`;
    });
  }

  async runTestsEfficiently(): Promise<void> {
    if (this.state.profiledTests.length === 0) {
      void vscode.window.showWarningMessage("Profile the selected test cases before running them efficiently.");
      return;
    }

    if (!(await this.ensureSelectedFiles())) {
      return;
    }

    const efficientCommandTemplate = this.getConfiguredCommand(
      "efficientRunCommandTemplate",
      "testCommandTemplate"
    );

    if (!efficientCommandTemplate) {
      return;
    }

    await this.runBusyTask("Running profiled tests from shortest to longest...", async () => {
      const executedTests: TestRuntime[] = [];
      this.state.efficientRunTests = [];
      this.postState();
      for (const test of this.state.profiledTests) {
        const result = await this.executeSingleTestCase(
          test.uri,
          test.testName,
          efficientCommandTemplate,
          "efficient"
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

  private async ensureSelectedFiles(): Promise<boolean> {
    if (this.state.selectedFiles.length > 0) {
      return true;
    }

    void vscode.window.showWarningMessage("Select at least one test file first.");
    return false;
  }

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

  private async executeSingleTestCase(
    uri: vscode.Uri,
    testName: string,
    commandTemplate: string,
    _mode: "profile" | "efficient"
  ): Promise<TestRuntime> {
    const workspaceFolder = this.getWorkspaceFolderForUri(uri);
    const command = this.buildCommand(uri, testName, commandTemplate, workspaceFolder);
    const testLabel = this.formatTestLabel(uri, testName);

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

  private getConfiguredCommand(
    preferredKey: "testCommandTemplate" | "efficientRunCommandTemplate",
    fallbackKey?: "testCommandTemplate"
  ): string | undefined {
    const configuration = vscode.workspace.getConfiguration("testCaseAnalysis");
    const preferred = configuration.get<string>(preferredKey)?.trim();
    if (preferred) {
      return preferred;
    }

    if (fallbackKey) {
      const fallback = configuration.get<string>(fallbackKey)?.trim();
      if (fallback) {
        return fallback;
      }
    }

    return "node --test --test-name-pattern ${testNamePattern} ${relativeFile}";
  }

  private getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  private getWorkspaceFolderForUri(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(uri) ?? this.getPrimaryWorkspaceFolder();
  }

  private quoteShellArgument(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  private formatPath(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false);
  }

  private formatFileName(uri: vscode.Uri): string {
    return uri.path.split("/").pop() ?? uri.fsPath.split("\\").pop() ?? uri.fsPath;
  }

  private formatTestLabel(uri: vscode.Uri, testName: string): string {
    return `${this.formatPath(uri)} :: ${testName}`;
  }

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

  private getWebviewHtml(): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Test Case Analysis</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: var(--vscode-font-family);
    }

    body {
      padding: 16px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }

    .stack {
      display: grid;
      gap: 12px;
    }

    button {
      width: 100%;
      border: 0;
      padding: 10px 12px;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }

    button:disabled {
      cursor: default;
      opacity: 0.6;
    }

    .panel {
      border: 1px solid var(--vscode-panel-border);
      padding: 12px;
      background: var(--vscode-editor-background);
    }

    .title {
      margin: 0 0 8px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .status {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    ul {
      margin: 0;
      padding-left: 18px;
    }

    li {
      margin: 4px 0;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div class="stack">
    <button id="selectFiles">Select Test Files</button>
    <button id="profileTests">Profile Tests</button>
    <button id="runEfficiently">Run Tests Efficiently</button>

    <div class="panel">
      <p class="title">Status</p>
      <div id="status" class="status">Select test files to begin.</div>
    </div>

    <div class="panel">
      <p class="title">Selected Files</p>
      <ul id="selectedFiles"></ul>
    </div>

    <div class="panel">
      <p class="title">Measured Test Runtimes</p>
      <ul id="profiledTests"></ul>
    </div>

    <div class="panel">
      <p class="title">Efficient Run Results</p>
      <ul id="efficientRunTests"></ul>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const selectedFilesElement = document.getElementById("selectedFiles");
    const profiledTestsElement = document.getElementById("profiledTests");
    const efficientRunTestsElement = document.getElementById("efficientRunTests");
    const statusElement = document.getElementById("status");
    const buttons = {
      selectFiles: document.getElementById("selectFiles"),
      profileTests: document.getElementById("profileTests"),
      runEfficiently: document.getElementById("runEfficiently")
    };

    buttons.selectFiles.addEventListener("click", () => {
      vscode.postMessage({ command: "selectFiles" });
    });

    buttons.profileTests.addEventListener("click", () => {
      vscode.postMessage({ command: "profileTests" });
    });

    buttons.runEfficiently.addEventListener("click", () => {
      vscode.postMessage({ command: "runEfficiently" });
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type !== "state") {
        return;
      }

      const state = message.value;
      statusElement.textContent = state.status;

      for (const button of Object.values(buttons)) {
        button.disabled = state.isBusy;
      }

      selectedFilesElement.replaceChildren(...toItems(state.selectedFiles, (path) => path));
      profiledTestsElement.replaceChildren(...toItems(
        state.profiledTests,
        (test) => {
          const status = test.lastRunPassed ? "PASS" : "FAIL";
          return test.fileName + " :: " + test.testName + " - " + test.runtimeMs.toFixed(2) + " ms - " + status;
        }
      ));

      efficientRunTestsElement.replaceChildren(...toItems(
        state.efficientRunTests,
        (test) => {
          const status = test.lastRunPassed ? "PASS" : "FAIL";
          return test.fileName
            + " :: " + test.testName
            + " - " + test.profiledRuntimeMs.toFixed(2) + " ms"
            + " - " + status;
        }
      ));
    });

    function toItems(values, formatter) {
      if (!values || values.length === 0) {
        const item = document.createElement("li");
        item.textContent = "None";
        return [item];
      }

      return values.map((value) => {
        const item = document.createElement("li");
        item.textContent = formatter(value);
        return item;
      });
    }
  </script>
</body>
</html>`;
  }
}

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

export function activate(context: vscode.ExtensionContext): void {
  const controller = new TestCaseAnalysisController();
  const provider = new TestCaseAnalysisWebviewProvider(controller);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DEFAULT_VIEW_ID, provider),
    vscode.commands.registerCommand("testCaseAnalysis.selectFiles", () => controller.selectFiles()),
    vscode.commands.registerCommand("testCaseAnalysis.profileTests", () => controller.profileSelectedTests()),
    vscode.commands.registerCommand("testCaseAnalysis.runTestsEfficiently", () => controller.runTestsEfficiently()),
    {
      dispose: () => controller.dispose()
    }
  );
}

export function deactivate(): void {}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += possible.charAt(Math.floor(Math.random() * possible.length));
  }

  return value;
}
