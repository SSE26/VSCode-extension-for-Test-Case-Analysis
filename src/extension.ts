import * as vscode from "vscode";

class TestCaseAnalysisItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description?: string,
    public readonly command?: vscode.Command
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
  }
}

class TestCaseAnalysisProvider implements vscode.TreeDataProvider<TestCaseAnalysisItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TestCaseAnalysisItem | undefined | null | void
  >();

  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TestCaseAnalysisItem): vscode.TreeItem {
    return element;
  }

  getChildren(): TestCaseAnalysisItem[] {
    return [
      new TestCaseAnalysisItem(
        "Run Hello World",
        "Click to run Hello World",
        {
          command: "testCaseAnalysis.helloWorld",
          title: "Run Hello World"
        }
      )
    ];
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TestCaseAnalysisProvider();

  vscode.window.registerTreeDataProvider("testCaseAnalysis.sidebarView", provider);

  const helloCommand = vscode.commands.registerCommand(
    "testCaseAnalysis.helloWorld",
    () => {
      void vscode.window.showInformationMessage("Hello World from the Test Case Analysis extension.");
    }
  );

  const refreshCommand = vscode.commands.registerCommand(
    "testCaseAnalysis.refreshSidebar",
    () => {
      provider.refresh();
      void vscode.window.showInformationMessage("Test Case Analysis sidebar refreshed.");
    }
  );

  context.subscriptions.push(helloCommand, refreshCommand);
}

export function deactivate(): void {}
