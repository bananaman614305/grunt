"use strict";
const assert = require("node:assert");
const { render } = require("./template.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

check("values are still HTML-escaped", () => {
  assert.strictEqual(
    render("<p>{{x}}</p>", { x: "<a href=\"q\">O'Neil & co</a>" }),
    "<p>&lt;a href=&quot;q&quot;&gt;O&#39;Neil &amp; co&lt;/a&gt;</p>",
  );
});

check("triple braces are still raw", () => {
  assert.strictEqual(render("{{{x}}}", { x: "<b>hi</b>" }), "<b>hi</b>");
});

check("dotted paths and missing values still work", () => {
  assert.strictEqual(
    render("{{user.name}}|{{user.nope}}|{{nope.deep}}", { user: { name: "Ada" } }),
    "Ada||",
  );
});

check("each walks an array with the item and its index", () => {
  assert.strictEqual(
    render("{{#each items}}{{@index}}:{{.}} {{/each}}", { items: ["a", "b"] }),
    "0:a 1:b ",
  );
});

check("each falls back to the enclosing scope", () => {
  assert.strictEqual(
    render("{{#each users}}{{name}}@{{site}};{{/each}}", {
      site: "milo",
      users: [{ name: "Ada" }, { name: "Bo" }],
    }),
    "Ada@milo;Bo@milo;",
  );
});

check("escaping applies inside a block", () => {
  assert.strictEqual(render("{{#each items}}{{.}}{{/each}}", { items: ["<b>"] }), "&lt;b&gt;");
});

check("a missing or empty array renders nothing", () => {
  assert.strictEqual(render("[{{#each nope}}x{{/each}}]", {}), "[]");
  assert.strictEqual(render("[{{#each items}}x{{/each}}]", { items: [] }), "[]");
});

check("if picks a branch", () => {
  const tpl = "{{#if flag}}yes{{else}}no{{/if}}";
  assert.strictEqual(render(tpl, { flag: true }), "yes");
  assert.strictEqual(render(tpl, { flag: "x" }), "yes");
  assert.strictEqual(render(tpl, { flag: 0 }), "no");
  assert.strictEqual(render(tpl, { flag: "" }), "no");
  assert.strictEqual(render(tpl, { flag: [] }), "no");
  assert.strictEqual(render(tpl, {}), "no");
  assert.strictEqual(render("{{#if flag}}yes{{/if}}", { flag: false }), "");
});

check("blocks nest and scopes chain", () => {
  const tpl =
    "{{#each groups}}{{title}}:{{#each items}}{{#if .}}<{{.}}{{site}}>{{else}}-{{/if}}{{/each}}|{{/each}}";
  const data = {
    site: "s",
    groups: [
      { title: "a", items: ["x", ""] },
      { title: "b", items: [] },
    ],
  };
  assert.strictEqual(render(tpl, data), "a:<xs>-|b:|");
});

process.exit(failed === 0 ? 0 : 1);
