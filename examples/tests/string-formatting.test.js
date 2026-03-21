const test = require("node:test");
const assert = require("node:assert/strict");
const { toSlug, titleCase } = require("../src/string-formatting");

test("toSlug normalizes spaces and punctuation", () => {
  assert.equal(toSlug("Energy Usage: Critical Path"), "energy-usage-critical-path");
});

test("toSlug removes leading and trailing separators", () => {
  assert.equal(toSlug("  --Fast Suite--  "), "fast-suite");
});

test("titleCase capitalizes each word", () => {
  assert.equal(titleCase("efficient test ordering"), "Efficient Test Ordering");
});

test("titleCase collapses repeated whitespace", () => {
  assert.equal(titleCase("runtime     sorted   execution"), "Runtime Sorted Execution");
});
