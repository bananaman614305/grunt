"use strict";

const { messageFor } = require("./errors.js");

// validate(field, value, rules) returns a list of { code, message } errors.
// Supported rules: required, minLength.
function validate(field, value, rules) {
  const errors = [];
  const text = value == null ? "" : String(value);
  if (rules.required && text.length === 0) {
    errors.push({ code: "required", message: messageFor("required", field) });
  }
  if (rules.minLength !== undefined && text.length < rules.minLength) {
    errors.push({ code: "min_length", message: messageFor("min_length", field, rules.minLength) });
  }
  return errors;
}

module.exports = { validate };
