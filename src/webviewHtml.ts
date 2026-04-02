// Build the HTML for the custom sidebar
export function getWebviewHtml(): string {
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

    .result-item {
      margin: 4px 0;
      word-break: break-word;
    }

    .result-details {
      margin-top: 6px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .result-label {
      font-weight: 700;
    }

    .result-value {
      display: block;
      margin-top: 2px;
    }

    .result-text {
      word-break: break-word;
    }

    .badge {
      display: inline-block;
      margin-left: 8px;
      vertical-align: middle;
      flex-shrink: 0;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
    }

    .badge.pass {
      color: #2ea043;
      background: rgba(46, 160, 67, 0.15);
      border: 1px solid rgba(46, 160, 67, 0.45);
    }

    .badge.fail {
      color: #f85149;
      background: rgba(248, 81, 73, 0.15);
      border: 1px solid rgba(248, 81, 73, 0.45);
    }

    ul {
      margin: 0;
      padding-left: 18px;
    }

    li {
      margin: 4px 0;
      word-break: break-word;
    }

    .total {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-panel-border);
      font-size: 12px;
      font-weight: 700;
      color: var(--vscode-foreground);
    }
  </style>
</head>
<body>
  <div class="stack">
    <button id="selectFiles">Select Test Files</button>
    <button id="selectFolder">Select Test Folder</button>
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
      <p class="title">Weighted Test Energy</p>
      <ul id="profiledTests"></ul>
      <div id="profiledTotal" class="total"></div>
    </div>

    <div class="panel">
      <p class="title">Efficient Run Results</p>
      <ul id="efficientRunTests"></ul>
      <div id="efficientTotal" class="total"></div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const selectedFilesElement = document.getElementById("selectedFiles");
    const profiledTestsElement = document.getElementById("profiledTests");
    const profiledTotalElement = document.getElementById("profiledTotal");
    const efficientRunTestsElement = document.getElementById("efficientRunTests");
    const efficientTotalElement = document.getElementById("efficientTotal");
    const statusElement = document.getElementById("status");
    const buttons = {
      selectFiles: document.getElementById("selectFiles"),
      selectFolder: document.getElementById("selectFolder"),
      profileTests: document.getElementById("profileTests"),
      runEfficiently: document.getElementById("runEfficiently")
    };

    buttons.selectFiles.addEventListener("click", () => {
      vscode.postMessage({ command: "selectFiles" });
    });

    buttons.selectFolder.addEventListener("click", () => {
      vscode.postMessage({ command: "selectFolder" });
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

      profiledTestsElement.replaceChildren(...toResultItems(
        state.profiledTests,
        (test) => test.fileName + " :: " + test.testName + " - " + (test.profiledEnergyJ * 1000).toFixed(3) + " mJ",
        state.showProfileStatuses
      ));
      const profiledTotal = (state.profiledTests || []).reduce((sum, t) => sum + t.profiledEnergyJ, 0);
      profiledTotalElement.textContent = state.profiledTests && state.profiledTests.length > 0
        ? "Total: " + (profiledTotal * 1000).toFixed(3) + " mJ"
        : "";

      efficientRunTestsElement.replaceChildren(...toResultItems(
        state.efficientRunTests,
        (test) => test.fileName + " :: " + test.testName + " - " + (test.energyJ * 1000).toFixed(3) + " mJ"
      ));
      const efficientTotal = (state.efficientRunTests || []).reduce((sum, t) => sum + t.energyJ, 0);
      efficientTotalElement.textContent = state.efficientRunTests && state.efficientRunTests.length > 0
        ? "Total: " + (efficientTotal * 1000).toFixed(3) + " mJ"
        : "";
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

    function toResultItems(values, formatter, showBadge = true) {
      if (!values || values.length === 0) {
        const item = document.createElement("li");
        item.textContent = "None";
        return [item];
      }

      return values.map((value) => {
        const item = document.createElement("li");
        item.className = "result-item";

        const text = document.createElement("span");
        text.className = "result-text";
        text.textContent = formatter(value);

        const badge = document.createElement("span");
        badge.className = value.lastRunPassed ? "badge pass" : "badge fail";
        badge.textContent = value.lastRunPassed ? "✅ PASS" : "❌ FAIL";

        item.append(text, badge);

        if (!value.lastRunPassed && (value.expected !== undefined || value.actual !== undefined)) {
          const details = document.createElement("div");
          details.className = "result-details";

          const expectedText = value.expected !== undefined ? String(value.expected) : "(not reported)";
          const actualText = value.actual !== undefined ? String(value.actual) : "(not reported)";

          const expectedLine = document.createElement("div");
          const expectedLabel = document.createElement("span");
          expectedLabel.className = "result-label";
          expectedLabel.textContent = "Expected:";
          const expectedValue = document.createElement("span");
          expectedValue.className = "result-value";
          expectedValue.textContent = expectedText;
          expectedLine.append(expectedLabel, expectedValue);

          const actualLine = document.createElement("div");
          const actualLabel = document.createElement("span");
          actualLabel.className = "result-label";
          actualLabel.textContent = "Actual:";
          const actualValue = document.createElement("span");
          actualValue.className = "result-value";
          actualValue.textContent = actualText;
          actualLine.append(actualLabel, actualValue);

          details.append(expectedLine, actualLine);
          item.append(details);
        }

        return item;
      });
    }
  </script>
</body>
</html>`;
}

// Create a random string for safe webview scripts
function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += possible.charAt(Math.floor(Math.random() * possible.length));
  }

  return value;
}
