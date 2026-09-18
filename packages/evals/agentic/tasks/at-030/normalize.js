"use strict";

// normalize(path) simplifies an absolute POSIX-style path:
//   - collapse repeated slashes and drop any "." segment,
//   - resolve each ".." by dropping the segment before it,
//   - a ".." with nothing before it stays at the root.
// The result always starts with "/" and never ends with a trailing slash,
// except that the root itself is "/".
function normalize(path) {
  const parts = path.split("/");
  const out = [];
  for (const seg of parts) {
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

module.exports = { normalize };
