# Fix the path normalizer

`normalize.js` simplifies an absolute POSIX-style path: it should collapse
repeated slashes, drop `.` segments, and resolve each `..` by removing the
segment before it, while a `..` with nothing before it stays at the root. The
result always starts with `/` and has no trailing slash, except the root
itself, which is `/`. For example `/a/b/../c` becomes `/a/c` and `/a//b/`
becomes `/a/b`. Several of these cases come out wrong. Make it correct.
`node test.js` checks the result.
