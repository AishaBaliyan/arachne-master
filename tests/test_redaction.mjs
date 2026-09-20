/**
 * Redaction truth set.
 *
 * SECRET_RE is the one safety check that runs before any model call, so it is
 * also the one that fails silently: too loose and every ordinary sentence gets
 * answered with a refusal, too tight and a texted password reaches the router,
 * the conversation store and OpenAI. Both halves are asserted here.
 *
 * The regex is read out of index.js rather than copied, so this cannot pass
 * against a version of the pattern that no longer ships.
 *
 * Run:  node tests/test_redaction.mjs     (no server needed)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "index.js"), "utf8");

const start = src.indexOf("const SECRET_RE = new RegExp(");
if (start < 0) throw new Error("SECRET_RE not found in index.js");
const end = src.indexOf(");", src.indexOf('"gi",', start)) + 2;
const SECRET_RE = eval(src.slice(start, end).replace("const SECRET_RE =", ""));

const cases = [
  // Announced credentials. These must never reach a prompt.
  ["my password is hunter2", true],
  ["password: hunter2", true],
  ["login: me@x.com / hunter2", true],
  ["my pin is 4417", true],
  ["the otp is 998211", true],
  ["passcode = 88213", true],
  ["my verification code is 449120", true],
  ["api key: sk-proj-abc123def456", true],

  // Ordinary sentences that merely mention the words. Every one of these used
  // to be answered with "I can't take passwords or login codes over text".
  ["I forgot my password again, help?", false],
  ["can you find a good password manager", false],
  ["pin that to the board for me", false],
  ["what is the secret to good bread", false],
  ["is otp better than sms for security", false],
  ["check my amazon orders", false],
  ["set a pin on the map near the pier", false],
  ["how does 2fa work", false],
  ["email me@x.com about the order", false],
  ["what's the password policy at most banks", false],

  // Pasted tokens. This is the branch that replaced the bare words "secret"
  // and "bearer", which carried no signal on their own.
  ["here, use sk-proj-AbCdEf0123456789xyz", true],
  ["whsec_0000EXAMPLE0000EXAMPLE0000EXAMPLE0000EXAMPLE=", true],
  ["bb_live_0000EXAMPLE0000example", true],
  ["ghp_EXAMPLEEXAMPLEEXAMPLEEXAMPLE0123", true],
  ["AKIAIOSFODNN7EXAMPLE", true],
  ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27u", true],
  ["the secret is patience and a hot oven", false],
  ["what's the sk-ii serum everyone talks about", false],
  ["compare gh pages and netlify", false],
];

let wrong = 0;
for (const [text, shouldRedact] of cases) {
  SECRET_RE.lastIndex = 0;
  const hit = SECRET_RE.test(text);
  const ok = hit === shouldRedact;
  if (!ok) wrong += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${hit ? "redacts" : "passes "}  "${text.slice(0, 64)}"`);
}

// The redacted text is what everything downstream sees, so the secret has to
// be gone from it, not merely flagged.
{
  const raw = "hey my password is hunter2 thanks";
  SECRET_RE.lastIndex = 0;
  const out = raw.replace(SECRET_RE, "[redacted]");
  const gone = !out.includes("hunter2") && out.includes("hey");
  if (!gone) wrong += 1;
  console.log(`${gone ? "PASS" : "FAIL"}  redacted text drops the secret, keeps the rest  "${out}"`);
}

console.log();
console.log(wrong === 0 ? `ALL ${cases.length + 1} REDACTION CHECKS PASSED` : `${wrong} FAILED`);
process.exitCode = wrong === 0 ? 0 : 1;
