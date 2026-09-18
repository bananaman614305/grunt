# Implement the command-line argument parser

`argv.js` exports a stub for `parseArgs(argv, spec)`, which reads an argument
list against a table of known options and returns `{ options, positionals }`.
It must follow all of these rules:

1. `positionals` holds every non-option argument, in the order they appeared.
2. A boolean option that was not given is `false`; a string option that was
   not given is absent from `options` entirely, unless it is marked
   `multiple`, in which case it is an empty array.
3. `--name value` and `--name=value` both set a string option. A boolean
   option never consumes the argument after it, and writing `--name=anything`
   for one throws `Error("option --name takes no value")`.
4. `--no-name` sets the boolean option `name` to `false`.
5. A one-letter form is the option whose spec carries that `short`. Letters
   cluster: `-abc` takes each in turn, and as soon as one of them is a string
   option the rest of the cluster is its value — or, if the cluster ends
   there, the next argument is.
6. A string option marked `multiple` collects every occurrence into an array
   in the order given; any other repeated option keeps the last value seen.
7. `--` ends option parsing, so every argument after it is a positional even
   if it starts with a dash. A lone `-` is always a positional.
8. An option missing from the spec throws `Error("unknown option: --name")`,
   or `Error("unknown option: -x")` for a one-letter form, and a string option
   left without a value throws `Error("option --name requires a value")` —
   both messages naming the option as it was written, except that a missing
   value always names the long form.

`node test.js` checks the result.
