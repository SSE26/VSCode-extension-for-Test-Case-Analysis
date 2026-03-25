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

    function renderState(state) {
      if (!state) {
        return;
      }

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
    }

    const savedState = vscode.getState();
    renderState(savedState);

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
      renderState(state);
      vscode.setState(state);
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

// Create a random string for safe webview scripts
function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += possible.charAt(Math.floor(Math.random() * possible.length));
  }

  return value;
}
