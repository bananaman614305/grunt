"use strict";
const assert = require("node:assert");
const { validate } = require("./validator.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

check("existing rules still work", () => {
  assert.deepStrictEqual(validate("name", "", { required: true }), [
    { code: "required", message: "name is required" },
  ]);
  assert.deepStrictEqual(validate("name", "ok", { required: true, minLength: 2 }), []);
});
check("maxLength flags values over the limit", () => {
  assert.deepStrictEqual(validate("bio", "hello", { maxLength: 3 }), [
    { code: "max_length", message: "bio must be at most 3 characters" },
  ]);
});
check("maxLength passes values at the limit", () => {
  assert.deepStrictEqual(validate("bio", "abc", { maxLength: 3 }), []);
});

process.exit(failed === 0 ? 0 : 1);
