# Teach the template renderer blocks

`template.js` can only substitute single values, and the templates we need to
render now have repetition and conditionals in them. Add two block forms,
which may be nested inside each other to any depth:

- `{{#each path}}...{{/each}}` renders its body once per item of the array at
  `path`, with `{{.}}` standing for the item itself and `{{@index}}` for its
  0-based position. Inside the body a dotted path is looked up on the item
  first and falls back to the enclosing scope. A path that is missing or an
  empty array renders nothing.
- `{{#if path}}...{{else}}...{{/if}}` renders the first half when `path` is
  truthy and the second when it is not; the `{{else}}` half is optional.
  `false`, `null`, `undefined`, `0`, `""` and an empty array count as not
  truthy.

Everything `render` does today — HTML escaping, `{{{raw}}}`, dotted paths,
missing values as the empty string — must keep working exactly as it does
now, inside blocks as well as outside them. `node test.js` checks the result.
