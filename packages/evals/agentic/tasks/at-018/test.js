"use strict";
const assert = require("node:assert");
const { buildIndex } = require("./index.js");
const { search } = require("./search.js");
const { highlight } = require("./snippet.js");

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (err) { failed += 1; console.error("not ok - " + name + ": " + err.message); }
}

const DOCS = [
  { id: "d1", text: "The Café  du Marché serves crème brûlée daily" },
  { id: "d2", text: "Plain cafe, no accents here" },
];
const INDEX = buildIndex(DOCS);
const textOf = (docId) => DOCS.find((doc) => doc.id === docId).text;
function only(query) {
  const hits = search(INDEX, query);
  assert.strictEqual(hits.length, 1, "expected one hit for " + query + ", got " + hits.length);
  return highlight(textOf(hits[0].docId), hits[0]);
}

check("the first matching word is bracketed exactly", () => {
  const hits = search(INDEX, "cafe");
  assert.deepStrictEqual(hits.map((hit) => hit.docId), ["d1", "d2"]);
  assert.strictEqual(
    highlight(textOf(hits[0].docId), hits[0]),
    "The [Café]  du Marché serves crème brûlée daily",
  );
  assert.strictEqual(
    highlight(textOf(hits[1].docId), hits[1]),
    "Plain [cafe], no accents here",
  );
});

check("words later in the document are bracketed exactly too", () => {
  assert.strictEqual(only("marche"), "The Café  du [Marché] serves crème brûlée daily");
  assert.strictEqual(only("brulee"), "The Café  du Marché serves crème [brûlée] daily");
  assert.strictEqual(only("daily"), "The Café  du Marché serves crème brûlée [daily]");
});

check("searching still ignores case and accents", () => {
  assert.strictEqual(search(INDEX, "CAFÉ").length, 2);
  assert.strictEqual(only("Crème"), "The Café  du Marché serves [crème] brûlée daily");
  assert.strictEqual(only("SERVES"), "The Café  du Marché [serves] crème brûlée daily");
  assert.deepStrictEqual(search(INDEX, "espresso"), []);
});

process.exit(failed === 0 ? 0 : 1);
