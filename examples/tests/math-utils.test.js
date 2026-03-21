const test = require("node:test");
const assert = require("node:assert/strict");
const { sum, divide } = require("../src/math-utils");

test("sum returns the total of positive numbers", () => {
  assert.equal(sum([1, 2, 3, 4]), 10);
});

test("sum handles negative values", () => {
  assert.equal(sum([10, -3, -2]), 5);
});

test("divide returns the quotient", () => {
  assert.equal(divide(12, 3), 4);
});

test("divide throws when divisor is zero", () => {
  assert.throws(() => divide(5, 0), /divide by zero/i);
});
