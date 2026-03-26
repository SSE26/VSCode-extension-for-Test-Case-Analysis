import * as vscode from "vscode";
import { readFile } from "fs/promises";

const SUPPORTED_TEST_FILE_EXTENSIONS = new Set([".js", ".ts"]);

// Discover test cases in the selected files
export async function discoverTestsInFiles(
  uris: vscode.Uri[]
): Promise<Array<{ uri: vscode.Uri; testName: string }>> {
  const discoveredTests: Array<{ uri: vscode.Uri; testName: string }> = [];

  for (const uri of uris) {
    const source = await readFile(uri.fsPath, "utf8");
    const testNames = extractTestNames(source);
    for (const testName of testNames) {
      discoveredTests.push({ uri, testName });
    }
  }

  return discoveredTests;
}

// Filter out unsupported files
export function filterSupportedTestFiles(uris: vscode.Uri[]): vscode.Uri[] {
  return uris.filter((uri) => isSupportedTestFile(uri));
}

// Check if the file has a supported extension
export function isSupportedTestFile(uri: vscode.Uri): boolean {
  const fileName = uri.path.split("/").pop() ?? uri.fsPath.split("\\").pop() ?? "";
  const extensionIndex = fileName.indexOf(".");
  if (extensionIndex === -1) {
    return false;
  }

  const normalizedFileName = fileName.toLowerCase();
  for (const extension of SUPPORTED_TEST_FILE_EXTENSIONS) {
    if (normalizedFileName.endsWith(extension)) {
      return true;
    }
  }

  return false;
}

// Return the supported file extensions for the picker
export function getSupportedTestFileExtensions(): string[] {
  return ["js", "ts"];
}

// Extract test names using regex
function extractTestNames(source: string): string[] {
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
