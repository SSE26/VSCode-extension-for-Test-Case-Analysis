import * as vscode from "vscode";
import { getWebviewHtml } from "./webviewHtml";
import { executeSingleTestCase, getConfiguredCommand } from "./testCommandRunner";
import {
  DiscoveredTestCase,
  PersistedTestProfile,
  ProfiledTestRuntime,
  TestRuntime,
  ViewState
} from "./testCaseAnalysisTypes";
import {
  discoverTestsInFiles,
  filterSupportedTestFiles,
  getSupportedTestFileExtensions,
  isSupportedTestFile
} from "./testFileUtils";
import { CacheFlushResult, TestProfileCache } from "./testProfileCache";

export class TestCaseAnalysisController {
  constructor(private readonly cacheRootPath: string) {}

  private readonly state: ViewState = {
    selectedFiles: [],
    profiledTests: [],
    efficientRunTests: [],
    isBusy: false,
    status: "Select test files to begin."
  };

  private view?: vscode.WebviewView;

  // Let the user select an entire folder and include all supported test files inside it
  async selectFolder(): Promise<void> {
    const workspaceFolder = this.getPrimaryWorkspaceFolder();
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: workspaceFolder?.uri,
      openLabel: "Select Test Folder"
    });

    if (!uris || uris.length === 0) {
      return;
    }

    const folderUri = uris[0];

    const candidateFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folderUri, "**/*")
    );

    const supportedFiles = filterSupportedTestFiles(candidateFiles);

    if (supportedFiles.length === 0) {
      this.state.selectedFiles = [];
      this.state.profiledTests = [];
      this.state.efficientRunTests = [];
      this.state.status = "No supported test files were found in the selected folder.";
      this.postState();
      void vscode.window.showWarningMessage(
        "No supported JavaScript or TypeScript test files were found in the selected folder."
      );
      return;
    }

    this.state.selectedFiles = supportedFiles;
    this.state.profiledTests = [];
    this.state.efficientRunTests = [];
    this.state.status = `Selected ${supportedFiles.length} test file${supportedFiles.length === 1 ? "" : "s"} from folder.`;
    this.postState();
  }

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
        case "selectFolder":
          void this.selectFolder();
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
        "JavaScript and TypeScript test files": getSupportedTestFileExtensions()
      }
    });

    if (!uris || uris.length === 0) {
      return;
    }

    const supportedUris = filterSupportedTestFiles(uris);
    if (supportedUris.length === 0) {
      this.state.selectedFiles = [];
      this.state.profiledTests = [];
      this.state.efficientRunTests = [];
      this.state.status = "No JavaScript or TypeScript test files are selected.";
      this.postState();
      void vscode.window.showWarningMessage("Select JavaScript or TypeScript test files only.");
      return;
    }

    this.state.selectedFiles = supportedUris;
    this.state.profiledTests = [];
    this.state.efficientRunTests = [];
    this.state.status = `Selected ${supportedUris.length} JavaScript/TypeScript test file${supportedUris.length === 1 ? "" : "s"}.`;
    this.postState();
    if (supportedUris.length !== uris.length) {
      void vscode.window.showWarningMessage("Unsupported files were ignored. Only JavaScript and TypeScript test files can be run.");
    }
  }

  // Run each test by itself and save how long it takes
  async profileSelectedTests(): Promise<void> {
    if (!(await this.ensureSelectedFiles())) {
      return;
    }

    const profileCommandTemplate = getConfiguredCommand();
    const profileCache = await TestProfileCache.load(this.getCacheRootPath());

    await this.runBusyTask("Profiling individual tests...", async () => {
      try {
        const discoveredTests = await discoverTestsInFiles(this.state.selectedFiles);
        if (discoveredTests.length === 0) {
          this.state.profiledTests = [];
          this.state.efficientRunTests = [];
          this.state.status = "No individual test cases were found in the selected files.";
          void vscode.window.showWarningMessage(
            "No individual test cases were found. This discovery step currently supports direct test(...) and it(...) calls."
          );
          return;
        }

        const profiledTests: ProfiledTestRuntime[] = [];
        for (const discoveredTest of discoveredTests) {
          const result = await executeSingleTestCase(
            discoveredTest.uri,
            discoveredTest.testName,
            profileCommandTemplate
          );
          const profiledEnergyJ = profileCache.updateProfile(discoveredTest, result.energyJ);
          profiledTests.push(
            this.createProfiledTestRuntime(discoveredTest, result, profiledEnergyJ)
          );
        }

        this.state.profiledTests = profiledTests;
        this.state.efficientRunTests = [];
        this.state.status = `Profiled ${profiledTests.length} individual test case${profiledTests.length === 1 ? "" : "s"}.`;
      } finally {
        this.showCacheFlushMessage(await profileCache.flush(), "Profile");
      }
    });
  }

  // Run the saved tests from fastest to slowest
  async runTestsEfficiently(): Promise<void> {
    if (!(await this.ensureSelectedFiles())) {
      return;
    }

    const efficientCommandTemplate = getConfiguredCommand();
    const profileCache = await TestProfileCache.load(this.getCacheRootPath());
    const testsInEnergyOrder = await this.resolveTestsInEnergyOrder(profileCache);
    if (testsInEnergyOrder === undefined) {
      return;
    }

    await this.runBusyTask("Running profiled tests from lowest to highest energy...", async () => {
      try {
        const executedTests: ProfiledTestRuntime[] = [];
        this.state.efficientRunTests = [];
        this.postState();
        for (const test of testsInEnergyOrder) {
          const result = await executeSingleTestCase(
            test.uri,
            test.testName,
            efficientCommandTemplate
          );
          const profiledEnergyJ = profileCache.updateProfile(test, result.energyJ);
          const executedTest = this.createProfiledTestRuntime(test, result, profiledEnergyJ, test.profiledRuntimeMs);
          this.updateProfiledEnergyReference(executedTest);
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

        this.state.status = `Executed ${executedTests.length} individual test case${executedTests.length === 1 ? "" : "s"} in energy order.`;
        void vscode.window.showInformationMessage("Efficient test run completed without failures.");
      } finally {
        this.showCacheFlushMessage(await profileCache.flush(), "Efficient run");
      }
    });
  }

  private async resolveTestsInEnergyOrder(profileCache: TestProfileCache): Promise<ProfiledTestRuntime[] | undefined> {
    if (this.state.profiledTests.length > 0) {
      return [...this.state.profiledTests].sort((a, b) => a.profiledEnergyJ - b.profiledEnergyJ);
    }

    const discoveredTests = await discoverTestsInFiles(this.state.selectedFiles);
    if (discoveredTests.length === 0) {
      this.state.profiledTests = [];
      this.state.efficientRunTests = [];
      this.state.status = "No individual test cases were found in the selected files.";
      this.postState();
      void vscode.window.showWarningMessage(
        "No individual test cases were found. This discovery step currently supports direct test(...) and it(...) calls."
      );
      return undefined;
    }

    const cachedProfiledTests: ProfiledTestRuntime[] = [];
    for (const discoveredTest of discoveredTests) {
      const persistedProfile = profileCache.getPersistedProfile(discoveredTest);
      if (persistedProfile === undefined) {
        void vscode.window.showWarningMessage("Profile the selected test cases before running them efficiently.");
        return undefined;
      }

      cachedProfiledTests.push(this.createCachedProfiledTestRuntime(discoveredTest, persistedProfile));
    }

    this.state.profiledTests = cachedProfiledTests;
    this.state.efficientRunTests = [];
    this.state.status = `Loaded ${cachedProfiledTests.length} cached test case profile${cachedProfiledTests.length === 1 ? "" : "s"} for efficient ordering.`;
    this.postState();

    return [...cachedProfiledTests].sort((a, b) => a.profiledEnergyJ - b.profiledEnergyJ);
  }

  // Make sure that the user has selected files
  private async ensureSelectedFiles(): Promise<boolean> {
    const supportedFiles = filterSupportedTestFiles(this.state.selectedFiles);
    if (supportedFiles.length !== this.state.selectedFiles.length) {
      this.state.selectedFiles = supportedFiles;
      this.state.profiledTests = this.state.profiledTests.filter((test) => isSupportedTestFile(test.uri));
      this.state.efficientRunTests = this.state.efficientRunTests.filter((test) => isSupportedTestFile(test.uri));
      this.postState();
      void vscode.window.showWarningMessage("Unsupported files were removed. Only JavaScript and TypeScript test files can be run.");
    }

    if (this.state.selectedFiles.length > 0) {
      return true;
    }

    void vscode.window.showWarningMessage("Select at least one JavaScript or TypeScript test file first.");
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

  // Get main project folder
  private getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  private getCacheRootPath(): string | undefined {
    return this.cacheRootPath;
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

  private createProfiledTestRuntime(
    discoveredTest: DiscoveredTestCase | ProfiledTestRuntime,
    result: TestRuntime,
    profiledEnergyJ: number,
    profiledRuntimeMs = result.runtimeMs
  ): ProfiledTestRuntime {
    return {
      ...result,
      relativeFile: discoveredTest.relativeFile,
      sourceHash: discoveredTest.sourceHash,
      cacheable: discoveredTest.cacheable,
      profiledEnergyJ,
      profiledRuntimeMs
    };
  }

  private createCachedProfiledTestRuntime(
    discoveredTest: DiscoveredTestCase,
    persistedProfile: PersistedTestProfile
  ): ProfiledTestRuntime {
    return {
      uri: discoveredTest.uri,
      relativeFile: discoveredTest.relativeFile,
      testName: discoveredTest.testName,
      sourceHash: discoveredTest.sourceHash,
      cacheable: discoveredTest.cacheable,
      energyJ: persistedProfile.lastMeasuredEnergyJ,
      profiledEnergyJ: persistedProfile.weightedEnergyJ,
      runtimeMs: 0,
      profiledRuntimeMs: 0,
      lastRunPassed: true,
      errorMessage: ""
    };
  }

  private updateProfiledEnergyReference(updatedTest: ProfiledTestRuntime): void {
    this.state.profiledTests = this.state.profiledTests.map((test) => {
      if (test.relativeFile !== updatedTest.relativeFile || test.testName !== updatedTest.testName) {
        return test;
      }

      return {
        ...test,
        profiledEnergyJ: updatedTest.profiledEnergyJ
      };
    });
  }

  private showCacheFlushMessage(result: CacheFlushResult, phaseLabel: string): void {
    if (result.wroteFile) {
      void vscode.window.showInformationMessage(`${phaseLabel} cache saved to ${result.cacheFilePath}`);
      return;
    }

    if (result.reason === "no-cache-path") {
      void vscode.window.showWarningMessage(`${phaseLabel} cache was not written because no cache root path was available.`);
      return;
    }

    void vscode.window.showWarningMessage(
      `${phaseLabel} cache was not written because no cacheable test updates were pending.` +
      (result.cacheFilePath ? ` Expected path: ${result.cacheFilePath}` : "")
    );
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
          energyJ: test.energyJ,
          profiledEnergyJ: test.profiledEnergyJ,
          runtimeMs: test.runtimeMs,
          profiledRuntimeMs: test.profiledRuntimeMs,
          lastRunPassed: test.lastRunPassed,
          actual: test.actual,
          expected: test.expected
        })),
        efficientRunTests: [...this.state.efficientRunTests]
          .sort((a, b) => a.energyJ - b.energyJ)
          .map((test) => ({
            fileName: this.formatFileName(test.uri),
            testName: test.testName,
            energyJ: test.energyJ,
            profiledEnergyJ: test.profiledEnergyJ,
            runtimeMs: test.runtimeMs,
            profiledRuntimeMs: test.profiledRuntimeMs,
            lastRunPassed: test.lastRunPassed,
            actual: test.actual,
            expected: test.expected
          })),
        isBusy: this.state.isBusy,
        status: this.state.status
      }
    });
  }
}
