"use strict";

const { parseConfig } = require("./parse.js");
const { validateConfig } = require("./validate.js");

// loadConfig(text) parses a config file and checks that it defines everything
// required, returning the finished config object.
function loadConfig(text) {
  return validateConfig(parseConfig(text));
}

module.exports = { loadConfig };
