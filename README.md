# Test Case Analysis

This repository contains the `local.test-case-analysis` VS Code extension.

## Current state

- Adds a `Test Case Analysis` view container to the Activity Bar
- Provides commands for selecting test files or folders
- Supports profiling tests and running tests more efficiently
- Includes VSIX packaging and install scripts for local testing

## Prerequisites

- Install Node.js so that `npm` is available.
- Run `npm install` once in the project root.


## Build and install the extension on Windows/Linux

Create a VSIX package:

```powershell
npm run vsix
```

Create the VSIX and install it into VS Code:

```powershell
npm run vsix:install
```

This generates a file `test-case-analysis-0.0.1.vsix` in the project root.

## Build and install the extension on Mac

Create a VSIX package:

```sh
npx vsce package
```

This command creates a `.vsix` package in the project root.

To install the extension from the generated `.vsix` file in Visual Studio Code:

1. Open Visual Studio Code.
2. Open the Command Palette.
3. Run `Extensions: Install from VSIX...`.
4. Select the generated `.vsix` file from the repository root.
