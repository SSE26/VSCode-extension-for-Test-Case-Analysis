import * as vscode from "vscode";
import { TestCaseAnalysisController } from "./testCaseAnalysisController";

const DEFAULT_VIEW_ID = "testCaseAnalysis.sidebarView";

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
  const controller = new TestCaseAnalysisController(context.extensionUri.fsPath);
  const provider = new TestCaseAnalysisWebviewProvider(controller);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DEFAULT_VIEW_ID, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.commands.registerCommand("testCaseAnalysis.selectFiles", () => controller.selectFiles()),
    vscode.commands.registerCommand("testCaseAnalysis.selectFolder", () => controller.selectFolder()),
    vscode.commands.registerCommand("testCaseAnalysis.profileTests", () => controller.profileSelectedTests()),
    vscode.commands.registerCommand("testCaseAnalysis.runTestsEfficiently", () => controller.runTestsEfficiently())
  );
}
