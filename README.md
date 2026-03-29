# Test Case Analysis

This repository contains the `local.test-case-analysis` VS Code extension.

## Current state

- Adds a `Test Case Analysis` view container to the Activity Bar
- Provides commands for selecting test files or folders
- Supports profiling tests and running tests more efficiently
- Includes VSIX packaging and install scripts for local testing

## Development

Prerequisite: install Node.js so `npm` is available.

1. Run `npm install` once
2. Press `F5` in VS Code
3. In the Extension Development Host, open the `Test Case Analysis` view in the Activity Bar
4. Use the contributed commands from the Command Palette or the sidebar UI

## Build and install the extension

Create a VSIX package:

```powershell
npm run vsix
```

Create the VSIX and install it into VS Code:

```powershell
npm run vsix:install
```

This generates a file like `test-case-analysis-0.0.1.vsix` in the project root.
