# Add a per-key request quota to the kernel

Requests arriving at the kernel carry an `apiKey`, and we want to cap how many
each key may spend: once three requests from a key have been accepted, every
further request from that key is refused with the message
`quota exceeded for key <key>`, under the error code this project's shared
table already reserves for quotas. Keys are counted separately, a request that
an earlier check in the chain already refused must not count against anyone's
quota, and the tallies belong to the kernel that made them — a second kernel
starts fresh and `reset()` empties them. Build it the way the plugins already
in the tree are built, following the conventions they and the kernel use.
`node test.js` checks the result.
