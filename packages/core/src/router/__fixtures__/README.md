# Router fixtures

Recorded `/v1/systemone` answers for four realistic sub-agent briefs, used by
`router.test.ts` to exercise the whole answer -> signals -> policy -> roster path
against the real wire shape.

`source` on each fixture says where it came from:

- `live` — a real response. Keep `requestId` (the `x-typesafe-request-id`
  header) so the call can be found in TypeSafe's logs. Never keep a key,
  an `Authorization` header, or anything else from the request.
- `synthetic` — hand-written to the wire shape because no live response was
  available. Values are plausible, not measured, so they prove the mapping and
  the policy wiring, not Jev's calibration. Calibration is the eval set's job
  (`packages/evals/data/routing.jsonl`, task 1.4).

All four here are `synthetic`: on 2026-09-17 the development Jev credential
returned `401 authentication_error` for every call (request ids
`req_01a0afff6d767c1ab175307156622682` and `req_01a0afff95187cb681e41b9809ee9386`).
Bearer is confirmed to be the right auth shape — the same key sent as
`x-api-key` came back `403 Must supply an API key`, so the server does read the
`Authorization` header and rejects the key itself. Re-record these against a
working key by replaying the prompts in `prompts.json`.
