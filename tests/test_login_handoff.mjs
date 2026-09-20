/**
 * Login handoff truth set.
 *
 * Separate from test_routing.mjs because this one costs a real Browserbase
 * session and takes about half a minute. Run it when the handoff changes.
 *
 * It exists because the failure it catches was silent. Parking the session on
 * the sign-in page was wrapped in a catch that logged "not fatal" and carried
 * on, so every handoff delivered a blank tab and the user had to go and find
 * the site themselves. Nothing failed, nothing alerted, and the reply still
 * read as though it had worked.
 *
 * Run:  node tests/test_login_handoff.mjs     (server must be running)
 */
const BASE = "http://localhost:3000";
const TOKEN = process.env.DEBUG_TOKEN || "local-dev-debug";

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
}

console.log("  ...starting a real session, this takes ~30s\n");

const r = await fetch(`${BASE}/debug/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-debug-token": TOKEN },
  body: JSON.stringify({
    from: "+15550001111",
    url: "https://www.instagram.com/accounts/login/",
  }),
});
if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
const out = await r.json();

check("the session parks instead of reporting a soft failure", out.parked === true,
  JSON.stringify(out));

// The assertion that matters. parked === true only means navigate was accepted;
// this is what the user actually opens to.
check("it lands on the sign-in page, not about:blank",
  typeof out.landedOn === "string" && /instagram\.com\/accounts\/login/.test(out.landedOn),
  `landed on: ${out.landedOn}`);

// A desktop-width window is legible on a laptop and unusable on a phone, which
// is where these links get opened.
check("the browser is phone-shaped", out.viewport?.width <= 430 && out.viewport?.height >= 700,
  JSON.stringify(out.viewport));

check("the link is the fullscreen live view", out.liveUrlKind === "fullscreen",
  `kind: ${out.liveUrlKind}`);

// The handoff message tells the user how long they have, and pendingLogin waits
// that long for a "done". Both were 30 minutes while the session was dying
// after the project default of 5, so the browser was gone well before the
// agent stopped waiting for it.
check("the session lives as long as the message promises", out.lifetimeMin >= 30,
  `session lasts ${out.lifetimeMin} min`);

console.log();
const passed = results.filter(Boolean).length;
console.log(passed === results.length
  ? `ALL ${results.length} HANDOFF CHECKS PASSED  (${(out.elapsedMs / 1000).toFixed(1)}s)`
  : `${results.length - passed}/${results.length} FAILED`);
process.exitCode = passed === results.length ? 0 : 1;
