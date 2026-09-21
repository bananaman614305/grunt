/**
 * Static candidate verification (ADR-026): a cheap, language-agnostic
 * structural check on a best-of-N candidate, used as a ranking gate so a
 * truncated or structurally-broken answer cannot win a sampled request on
 * Jev's text score alone.
 *
 * Milo is a stateless chat/completions gateway: it has no code sandbox and no
 * access to the client's repository, so it CANNOT compile, patch, or execute a
 * candidate. Full executable verification (running the project's tests, applying
 * a patch) belongs to the client's workspace, not here. This module therefore
 * does only what the gateway can do with the completion text it already holds:
 * cheap structural/format/completeness checks that catch OBVIOUSLY broken
 * candidates without pretending to parse any particular programming language.
 *
 * The checks are deliberately conservative (low false-positive): they fire only
 * on high-confidence structural breakage -- an unterminated code fence, a
 * length-truncated response, a code block whose brackets do not balance, a
 * malformed unified diff, or invalid JSON where JSON was asked for. Free prose
 * is never policed (prose routinely contains stray parentheses and brackets), so
 * a well-formed answer is never demoted. A candidate that trips no check is
 * `ok`, and the caller keeps Jev's ranking as the primary signal among the
 * structurally-valid candidates.
 */

/** A single high-confidence structural defect found in a candidate. */
export type CandidateFlaw =
  /** `finish_reason: "length"` -- the model hit the token cap mid-answer. */
  | "truncated_length"
  /** An odd number of ``` fences: a code block was never closed. */
  | "unterminated_code_fence"
  /** A fenced code block's (), [], or {} do not balance. */
  | "unbalanced_delimiters"
  /** The answer ends mid-token (a trailing backslash escape or lone surrogate). */
  | "truncated_token"
  /** A unified diff with a bad `@@` header or hunk line counts that do not match. */
  | "malformed_diff"
  /** JSON was expected (fenced ```json or the request asked) but did not parse. */
  | "invalid_json";

/** The verifier's verdict on one candidate. */
export type CandidateCheck = {
  /** True when no structural defect was found. */
  ok: boolean;
  /** Every defect found, in check order. Empty iff `ok`. */
  flaws: CandidateFlaw[];
};

/** What the verifier needs about one candidate: its text and a little context. */
export type CandidateInput = {
  /** The candidate's completion text (message content, or serialized tool calls). */
  text: string;
  /** `choices[0].finish_reason`, when known: `"length"` means truncated. */
  finishReason?: unknown;
  /**
   * The request asked for JSON (e.g. `response_format` of type `json_object` /
   * `json_schema`). When true, the whole answer is expected to be JSON even
   * without a ```json fence.
   */
  expectJson?: boolean;
};

/**
 * Whether a chat-completions request asked for a JSON response, via the OpenAI
 * `response_format` field (`json_object` or `json_schema`). Pure; reads only the
 * one field, so it never touches message content.
 */
export function expectsJsonResponse(body: Record<string, unknown>): boolean {
  const format = body["response_format"];
  if (typeof format !== "object" || format === null) return false;
  const type = (format as Record<string, unknown>)["type"];
  return type === "json_object" || type === "json_schema";
}

/** Splits a candidate into fenced code blocks and the prose between them. */
type FenceScan = {
  /** ``` fences seen; an odd count means the last block was never closed. */
  fenceCount: number;
  /** The content of every CLOSED fenced block, with its info string. */
  closed: Array<{ info: string; content: string }>;
};

/**
 * Walks the ``` fences of a candidate. A fence is a line whose first
 * non-whitespace run is three or more backticks; the run's tail is the info
 * string (e.g. `json`, `diff`). Content between an opening and the next fence is
 * one closed block; an opening with no closing fence leaves an odd `fenceCount`.
 */
function scanFences(text: string): FenceScan {
  const lines = text.split("\n");
  const closed: Array<{ info: string; content: string }> = [];
  let fenceCount = 0;
  let open: { info: string; content: string[] } | undefined;
  for (const line of lines) {
    const match = /^\s*(`{3,})(.*)$/.exec(line);
    if (match !== null) {
      fenceCount += 1;
      if (open === undefined) {
        open = { info: (match[2] ?? "").trim().toLowerCase(), content: [] };
      } else {
        closed.push({ info: open.info, content: open.content.join("\n") });
        open = undefined;
      }
      continue;
    }
    if (open !== undefined) open.content.push(line);
  }
  return { fenceCount, closed };
}

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set([")", "]", "}"]);

/**
 * Whether the (), [], {} of a code string balance. Characters inside string
 * literals (single, double, or backtick quotes) and line comments are skipped,
 * so a bracket in a string does not read as structure. Language-agnostic and
 * intentionally forgiving: it only reports a mismatch it is sure of.
 */
function delimitersBalanced(code: string): boolean {
  const stack: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i] as string;
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch in OPENERS) {
      stack.push(OPENERS[ch] as string);
      continue;
    }
    if (CLOSERS.has(ch)) {
      if (stack.pop() !== ch) return false;
    }
  }
  // A string left open at end-of-block, or brackets left on the stack, is
  // unbalanced. (An unterminated string is itself a sign of truncation.)
  return stack.length === 0 && quote === undefined;
}

/** True when the text ends mid-token: a dangling escape or a lone surrogate. */
function endsMidToken(text: string): boolean {
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed === "") return false;
  // A trailing odd run of backslashes is an unfinished escape sequence.
  const tail = /\\+$/.exec(trimmed);
  if (tail !== null && tail[0].length % 2 === 1) return true;
  // A lone high surrogate at the very end is half of a code point: cut mid-char.
  const last = trimmed.charCodeAt(trimmed.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return true;
  return false;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Whether a candidate looks like a unified diff worth checking hunk counts on. */
function looksLikeDiff(text: string): boolean {
  return /^@@ -\d/m.test(text) || /^diff --git /m.test(text) || (/^--- /m.test(text) && /^\+\+\+ /m.test(text));
}

/**
 * Validates a unified diff's `@@` hunk headers and line counts. Every hunk
 * header must parse, and the body lines that follow it (until the next hunk or
 * file header) must match the declared old/new line counts: a ` ` context line
 * counts to both sides, a `-` line to the old side, a `+` line to the new side.
 * A header with a body that does not match, or a dangling header with no body,
 * is a malformed diff. Returns true when well-formed.
 */
function diffWellFormed(text: string): boolean {
  const lines = text.split("\n");
  let sawHunk = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const header = HUNK_HEADER.exec(line);
    if (header === null) {
      i += 1;
      continue;
    }
    sawHunk = true;
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const newCount = header[4] === undefined ? 1 : Number(header[4]);
    let oldSeen = 0;
    let newSeen = 0;
    let body = 0;
    i += 1;
    for (; i < lines.length; i += 1) {
      const l = lines[i] as string;
      if (HUNK_HEADER.test(l) || l.startsWith("diff --git") || l.startsWith("--- ") || l.startsWith("+++ ")) break;
      const marker = l[0];
      if (marker === " " || l === "") {
        oldSeen += 1;
        newSeen += 1;
      } else if (marker === "-") {
        oldSeen += 1;
      } else if (marker === "+") {
        newSeen += 1;
      } else if (marker === "\\") {
        // "\ No newline at end of file": counts toward neither side.
        continue;
      } else {
        // A line that is not part of the hunk body ends it.
        break;
      }
      body += 1;
    }
    if (body === 0) return false; // dangling header, no hunk body
    if (oldSeen !== oldCount || newSeen !== newCount) return false;
  }
  return sawHunk;
}

/** Whether a string parses as JSON. */
function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scores one candidate's structural validity. Pure and cheap: no per-language
 * parsing, no network, no execution -- only the format/completeness checks the
 * stateless gateway can run on the text it holds. See the module header for why
 * executable verification is out of scope here.
 */
export function checkCandidate(input: CandidateInput): CandidateCheck {
  const flaws: CandidateFlaw[] = [];
  const text = input.text ?? "";

  // 1. Truncation the provider itself reported.
  if (input.finishReason === "length") flaws.push("truncated_length");

  // 2. Code fences: an odd count means a block was opened and never closed.
  const fences = scanFences(text);
  if (fences.fenceCount % 2 === 1) flaws.push("unterminated_code_fence");

  // 3. Balanced delimiters inside each CLOSED code block. Prose is never
  //    checked, so a stray parenthesis in a sentence is not a defect.
  for (const block of fences.closed) {
    if (!delimitersBalanced(block.content)) {
      flaws.push("unbalanced_delimiters");
      break;
    }
  }

  // 4. Ends mid-token: a dangling escape or a half-written code point.
  if (endsMidToken(text)) flaws.push("truncated_token");

  // 5. JSON validity where JSON is expected: a fenced ```json block, or the
  //    whole answer when the request asked for JSON. A fenced json block that
  //    is not closed is already caught by (2); here we validate closed ones.
  const jsonBlocks = fences.closed.filter((b) => b.info === "json" || b.info.startsWith("json"));
  let jsonBad = false;
  for (const block of jsonBlocks) {
    if (!isJson(block.content.trim())) {
      jsonBad = true;
      break;
    }
  }
  if (!jsonBad && input.expectJson === true && fences.closed.length === 0) {
    // No fence: the request asked for raw JSON, so the whole answer must parse.
    const body = text.trim();
    if (body !== "" && !isJson(body)) jsonBad = true;
  }
  if (jsonBad) flaws.push("invalid_json");

  // 6. Unified diff well-formedness, when the candidate is a diff.
  if (looksLikeDiff(text) && !diffWellFormed(text)) flaws.push("malformed_diff");

  return { ok: flaws.length === 0, flaws };
}
