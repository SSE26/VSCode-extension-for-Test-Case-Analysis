import * as vscode from "vscode";
import { readFile } from "fs/promises";
import { discoverTestCasesInSource } from "./testDiscovery";
import { DiscoveredTestCase } from "./testCaseAnalysisTypes";

const SUPPORTED_TEST_FILE_EXTENSIONS = new Set([".js", ".ts"]);

// Discover test cases in the selected files
export async function discoverTestsInFiles(
  uris: vscode.Uri[]
): Promise<DiscoveredTestCase[]> {
  const discoveredTests: DiscoveredTestCase[] = [];

  for (const uri of uris) {
    const source = await readFile(uri.fsPath, "utf8");
    const relativeFile = vscode.workspace.asRelativePath(uri, false);
    const discoveredTestCases = discoverTestCasesInSource(source);
    for (const discoveredTestCase of discoveredTestCases) {
      discoveredTests.push({
        uri,
        relativeFile,
        testName: discoveredTestCase.testName,
        sourceHash: discoveredTestCase.sourceHash,
        cacheable: discoveredTestCase.cacheable
      });
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
