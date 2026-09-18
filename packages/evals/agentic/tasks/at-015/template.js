"use strict";

// render(template, data) fills {{path}} placeholders from `data`.
//
//   {{path}}     the value, HTML-escaped
//   {{{path}}}   the value, raw
//
// A path is a dotted walk into `data` ("user.name"); a path that resolves to
// null or undefined renders as an empty string.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

function lookup(scope, path) {
  let current = scope;
  for (const key of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  return current;
}

function stringify(value) {
  return value === null || value === undefined ? "" : String(value);
}

function render(template, data) {
  return template
    .replace(/\{\{\{\s*([^\s}]+)\s*\}\}\}/g, (_match, path) => stringify(lookup(data, path)))
    .replace(/\{\{\s*([^\s}]+)\s*\}\}/g, (_match, path) => escapeHtml(stringify(lookup(data, path))));
}

module.exports = { render };
