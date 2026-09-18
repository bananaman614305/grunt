"use strict";
const assert = require("node:assert");
const { parseArgs } = require("./argv.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

const SPEC = {
  verbose: { type: "boolean", short: "v" },
  color: { type: "boolean" },
  out: { type: "string", short: "o" },
  tag: { type: "string", short: "t", multiple: true },
  name: { type: "string" },
};
const parse = (argv) => parseArgs(argv, SPEC);

check("defaults, positionals, and absent string options", () => {
  const result = parse(["-v", "file.txt"]);
  assert.deepStrictEqual(result.options, { verbose: true, color: false, tag: [] });
  assert.deepStrictEqual(result.positionals, ["file.txt"]);
});

check("both spellings of a string option's value", () => {
  assert.strictEqual(parse(["--out=dist"]).options.out, "dist");
  assert.strictEqual(parse(["--name", "milo"]).options.name, "milo");
  assert.strictEqual(parse(["--out="]).options.out, "");
});

check("a boolean option leaves the next argument alone", () => {
  const result = parse(["--color", "file.txt"]);
  assert.strictEqual(result.options.color, true);
  assert.deepStrictEqual(result.positionals, ["file.txt"]);
});

check("clustered one-letter options", () => {
  assert.deepStrictEqual(parse(["-ofile"]).options.out, "file");
  assert.deepStrictEqual(parse(["-o", "file"]).options.out, "file");
  const cluster = parse(["-vo", "x"]);
  assert.strictEqual(cluster.options.verbose, true);
  assert.strictEqual(cluster.options.out, "x");
  const glued = parse(["-vox"]);
  assert.strictEqual(glued.options.verbose, true);
  assert.strictEqual(glued.options.out, "x");
  assert.deepStrictEqual(glued.positionals, []);
});

check("--no- turns a boolean off", () => {
  assert.strictEqual(parse(["--color", "--no-color"]).options.color, false);
  assert.strictEqual(parse(["--no-verbose"]).options.verbose, false);
});

check("repeats collect or overwrite", () => {
  assert.deepStrictEqual(parse(["--tag", "a", "-t", "b", "--tag=c"]).options.tag, ["a", "b", "c"]);
  assert.strictEqual(parse(["--name", "x", "--name", "y"]).options.name, "y");
});

check("-- ends option parsing and a lone dash is a positional", () => {
  const result = parse(["-v", "--", "--verbose", "-x", "-"]);
  assert.deepStrictEqual(result.positionals, ["--verbose", "-x", "-"]);
  assert.strictEqual(result.options.verbose, true);
  assert.deepStrictEqual(parse(["-", "a"]).positionals, ["-", "a"]);
});

check("errors", () => {
  assert.throws(() => parse(["--nope"]), { message: "unknown option: --nope" });
  assert.throws(() => parse(["-z"]), { message: "unknown option: -z" });
  assert.throws(() => parse(["-vz"]), { message: "unknown option: -z" });
  assert.throws(() => parse(["--out"]), { message: "option --out requires a value" });
  assert.throws(() => parse(["-o"]), { message: "option --out requires a value" });
  assert.throws(() => parse(["--verbose=1"]), { message: "option --verbose takes no value" });
});

process.exit(failed === 0 ? 0 : 1);
