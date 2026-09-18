"use strict";

// parseArgs(argv, spec) -> { options, positionals }
//
// `spec` maps an option's long name to { type: "boolean" | "string", short?,
// multiple? }: `short` is its one-letter form and `multiple` marks a string
// option that may be given more than once.
function parseArgs(argv, spec) {
  void argv;
  void spec;
  throw new Error("not implemented");
}

module.exports = { parseArgs };
