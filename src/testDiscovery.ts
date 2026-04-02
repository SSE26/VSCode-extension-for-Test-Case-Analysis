import { createHash } from "crypto";
import type { TestProfileIdentity } from "./testCaseAnalysisTypes";

type DiscoveredTestSource = Omit<TestProfileIdentity, "relativeFile">;

type TestInvocationMatch = {
  testName: string;
  invocationText?: string;
};

const TEST_NAME_PATTERN = /\b(?:test|it)\s*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;

export function discoverTestCasesInSource(source: string): DiscoveredTestSource[] {
  const matches = [...getTestInvocationMatches(source)];
  const duplicateNames = getDuplicateNames(matches.map((match) => match.testName));
  const discoveredTests: DiscoveredTestSource[] = [];

  for (const match of matches) {
    const isDuplicateName = duplicateNames.has(match.testName);
    const sourceHash = !isDuplicateName && match.invocationText !== undefined
      ? hashTestInvocation(match.invocationText)
      : undefined;

    discoveredTests.push({
      testName: match.testName,
      sourceHash,
      cacheable: !isDuplicateName && sourceHash !== undefined
    });
  }

  return deduplicateByTestName(discoveredTests);
}

export function hashTestInvocation(invocationText: string): string {
  return createHash("sha256")
    .update(normalizeLineEndings(invocationText))
    .digest("hex");
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function *getTestInvocationMatches(source: string): Generator<TestInvocationMatch> {
  let match: RegExpExecArray | null;

  do {
    match = TEST_NAME_PATTERN.exec(source);
    if (!match?.[2]) {
      continue;
    }

    const invocationEndIndex = findInvocationEndIndex(source, match.index);
    yield {
      testName: match[2],
      invocationText:
        invocationEndIndex !== undefined
          ? source.slice(match.index, invocationEndIndex)
          : undefined
    };
  } while (match);
}

function findInvocationEndIndex(source: string, invocationStartIndex: number): number | undefined {
  const openParenIndex = source.indexOf("(", invocationStartIndex);
  if (openParenIndex === -1) {
    return undefined;
  }

  let parenDepth = 0;
  let index = openParenIndex;

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];

    if (current === "'" || current === "\"") {
      const nextIndex = skipQuotedString(source, index, current);
      if (nextIndex === undefined) {
        return undefined;
      }
      index = nextIndex;
      continue;
    }

    if (current === "`") {
      const nextIndex = skipTemplateLiteral(source, index);
      if (nextIndex === undefined) {
        return undefined;
      }
      index = nextIndex;
      continue;
    }

    if (current === "/" && next === "/") {
      index = skipLineComment(source, index + 2);
      continue;
    }

    if (current === "/" && next === "*") {
      const nextIndex = skipBlockComment(source, index + 2);
      if (nextIndex === undefined) {
        return undefined;
      }
      index = nextIndex;
      continue;
    }

    if (current === "(") {
      parenDepth += 1;
    } else if (current === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        return index + 1;
      }
    }

    index += 1;
  }

  return undefined;
}

function skipQuotedString(source: string, startIndex: number, quote: "'" | "\""): number | undefined {
  let index = startIndex + 1;

  while (index < source.length) {
    const current = source[index];

    if (current === "\\") {
      index += 2;
      continue;
    }

    if (current === quote) {
      return index + 1;
    }

    index += 1;
  }

  return undefined;
}

function skipTemplateLiteral(source: string, startIndex: number): number | undefined {
  let index = startIndex + 1;

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];

    if (current === "\\") {
      index += 2;
      continue;
    }

    if (current === "`") {
      return index + 1;
    }

    if (current === "$" && next === "{") {
      const nextIndex = skipTemplateExpression(source, index + 2);
      if (nextIndex === undefined) {
        return undefined;
      }
      index = nextIndex;
      continue;
    }

    index += 1;
  }

  return undefined;
}

function skipTemplateExpression(source: string, startIndex: number): number | undefined {
  let braceDepth = 1;
  let index = startIndex;

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];

    if (current === "'" || current === "\"") {
      const nextIndex = skipQuotedString(source, index, current);
      if (nextIndex === undefined) {
        return undefined;
      }
      index = nextIndex;
      continue;
    }

    if (current === "`") {
      const nextIndex = skipTemplateLiteral(source, index);
      if (nextIndex === undefined) {
        return undefined;
      }
      index = nextIndex;
      continue;
    }

    if (current === "/" && next === "/") {
      index = skipLineComment(source, index + 2);
      continue;
    }

    if (current === "/" && next === "*") {
      const nextIndex = skipBlockComment(source, index + 2);
      if (nextIndex === undefined) {
        return undefined;
      }
      index = nextIndex;
      continue;
    }

    if (current === "{") {
      braceDepth += 1;
    } else if (current === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) {
        return index + 1;
      }
    }

    index += 1;
  }

  return undefined;
}

function skipLineComment(source: string, startIndex: number): number {
  let index = startIndex;
  while (index < source.length && source[index] !== "\n") {
    index += 1;
  }
  return index;
}

function skipBlockComment(source: string, startIndex: number): number | undefined {
  const endIndex = source.indexOf("*/", startIndex);
  return endIndex === -1 ? undefined : endIndex + 2;
}

function getDuplicateNames(testNames: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const testName of testNames) {
    if (seen.has(testName)) {
      duplicates.add(testName);
      continue;
    }

    seen.add(testName);
  }

  return duplicates;
}

function deduplicateByTestName(discoveredTests: DiscoveredTestSource[]): DiscoveredTestSource[] {
  const seen = new Set<string>();
  const uniqueTests: DiscoveredTestSource[] = [];

  for (const discoveredTest of discoveredTests) {
    if (seen.has(discoveredTest.testName)) {
      continue;
    }

    seen.add(discoveredTest.testName);
    uniqueTests.push(discoveredTest);
  }

  return uniqueTests;
}
