function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function divide(left, right) {
  if (right === 0) {
    throw new Error("Cannot divide by zero");
  }

  return left / right;
}

module.exports = {
  sum,
  divide
};
