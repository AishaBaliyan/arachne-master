/**
 * Router truth set.
 *
 * Each case asserts only the routing decision, via /debug/turn's routeOnly
 * flag, so the whole suite runs in seconds and costs nothing but a few short
 * completions. Executing every task case end to end would take minutes and
 * bill a Browserbase session per row.
 *
 * Run:  node tests/test_routing.mjs     (server must be running)
 */
const BASE = "http://localhost:3000";
const TOKEN = process.env.DEBUG_TOKEN || "local-dev-debug";

async function turn(from, text, { reset = false, routeOnly = true } = {}) {
  const r = await fetch(`${BASE}/debug/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-debug-token": TOKEN },
    body: JSON.stringify({ from, text, reset, routeOnly }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
}

const NUM = "+15550002222";

// Single-message routing. Fresh conversation each time so one case cannot
// colour the next.
const solo = [
  ["hi", "chat"],
  ["thanks, you're great", "chat"],
  ["what's 18% of 64", "chat"],
  ["who wrote Dune", "chat"],
  ["what's the weather in Toronto right now", "task"],
  ["best power bank under $80, I'm in Canada", "task"],
  ["screenshot stripe.com/pricing", "task"],
  ["book me a table", "clarify"],
  // Needing an account is not a reason to refuse. The sign-in gets arranged
  // through the live-browser handoff when the page actually asks for it, so
  // these route as ordinary tasks. This row used to expect refuse_credentials,
  // which is what turned "send a DM from my instagram" into a lecture about
  // passwords the user had never offered.
  ["log into my gmail and check my inbox", "task"],
  ['send a DM to @someone saying "hi" from my instagram', "task"],
];

for (const [text, expected] of solo) {
  const { route } = await turn(NUM, text, { reset: true });
  check(`"${text}" -> ${expected}`, route?.mode === expected,
    `got ${route?.mode} (${route?.reasoning})`);
}

// A clarify must never be the one asking for a credential.
{
  const { route } = await turn(NUM, "check my amazon order status", { reset: true });
  const asked = String(route?.reply ?? "");
  check("order check does not ask for a login",
    route?.mode !== "clarify" || !/pass(word)?|pin|credential|login details/i.test(asked),
    `asked: ${asked}`);
}

// An actual secret is refused before the router runs at all.
//
// The elapsed time is the assertion that carries weight: routeTurn is a network
// round trip to OpenAI and cannot finish in a quarter second, so a turn this
// fast proves the password never entered a prompt. The mode alone would not -
// the router could have returned the same mode after seeing the secret.
// tests/test_redaction.mjs covers the regex itself, in both directions.
{
  const r = await turn(NUM, "my password is hunter2", { reset: true, routeOnly: false });
  check("a texted password refuses", r.route?.mode === "refuse_credentials",
    `route: ${JSON.stringify(r.route)}`);
  check("...and does it with zero model calls", r.elapsedMs < 250, `took ${r.elapsedMs}ms`);
  check("the refusal is the only thing sent", r.sends === 1, `sends=${r.sends}`);

  const mem = await fetch(`${BASE}/debug/memory?from=${encodeURIComponent(NUM)}`, {
    headers: { "x-debug-token": TOKEN },
  }).then((x) => x.json());
  check("the secret is not in the stored transcript",
    !JSON.stringify(mem).includes("hunter2"),
    JSON.stringify(mem.conversation?.turns)?.slice(0, 160));
}

// Multi-turn: the follow-up only means something with memory, and the task
// case has to actually run for a lastTask digest to exist.
{
  await turn(NUM, "hello", { reset: true });
  console.log("\n  ...running one real task to populate memory (this is the slow one)");
  const done = await turn(NUM, "best power bank under $80, I'm in Canada", { routeOnly: false });
  check("task produced a reply", done.sends >= 1, `sends=${done.sends}`);
  check("task recorded a digest", Boolean(done.conversation?.lastTask?.items?.length),
    JSON.stringify(done.conversation?.lastTask)?.slice(0, 120));

  const follow = await turn(NUM, "what about the second one?");
  check("follow-up routes as task", follow.route?.mode === "task", `got ${follow.route?.mode}`);
  check("follow-up resolves the reference",
    Boolean(follow.route?.referencesPriorResult) &&
      follow.route?.resolvedRequest?.length > 20 &&
      !/the second one/i.test(follow.route.resolvedRequest),
    `resolved: ${follow.route?.resolvedRequest}`);

  const cheaper = await turn(NUM, "cheaper?");
  check("\"cheaper?\" carries the subject forward",
    /power bank/i.test(cheaper.route?.resolvedRequest ?? ""),
    `resolved: ${cheaper.route?.resolvedRequest}`);
}

// Memory bounds.
{
  for (let i = 0; i < 14; i += 1) await turn(NUM, `message ${i}`, { reset: i === 0 });
  const r = await fetch(`${BASE}/debug/memory?from=${encodeURIComponent(NUM)}`, {
    headers: { "x-debug-token": TOKEN },
  });
  const { conversation } = await r.json();
  check("history capped at 12 turns", conversation.turns.length <= 12,
    `got ${conversation.turns.length}`);
}

console.log();
const passed = results.filter(Boolean).length;
console.log(passed === results.length
  ? `ALL ${results.length} ROUTING CHECKS PASSED`
  : `${results.length - passed}/${results.length} FAILED`);
process.exitCode = passed === results.length ? 0 : 1;
