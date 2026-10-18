// End-to-end tests of the app in headless Chromium: the web version (what an iPhone opens from a tag),
// and the iOS and Android apps' JavaScript talking to the RobiNfc plugin through Capacitor's real bridge.
// Run: node tests/app.test.mjs   (needs `npm install` and `npm i --no-save playwright` + `npx playwright install chromium`)
import assert from "node:assert/strict";
import { start, stop, open, calls, lastCall, nativeEvent, nativeReply, bubble, toast, waitFor, TAG } from "./harness.mjs";

const GADGETS = ["antenna", "terminal", "hash", "bootL", "bootR"];
const FOUND = { antenna: "found my Antenna", terminal: "found my Terminal", hash: "found my secret Hash", bootL: "Left Rocket Boot", bootR: "Right Rocket Boot" };
const READY = { "robi-onboarded": true, "robi-name": "Robi", "robi-friend": "Mia" };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const pageErrors = p => assert.deepEqual(p.errors, [], "JavaScript errors on the page");

// Go from the wake screen to the menu, like tapping "Let's play?!"
async function toMenu(page) {
  await page.click('[data-act="wake"]');
  await waitFor(page, () => S.screen === "menu");
}

// ---------------------------------------------------------------- web (iPhone without the app, any browser)

test("web: loads with no errors and starts asleep", async () => {
  const p = await open("web");
  assert.equal(await p.evaluate(() => NATIVE), false);
  assert.equal(await p.evaluate(() => S.screen), "wake");
  pageErrors(p);
});

test("web: a tag link opens the app with that gadget scanned (each gadget)", async () => {
  for (const g of GADGETS) {
    const p = await open("web", { storage: READY, hash: "#" + g });
    await waitFor(p, t => document.getElementById("bubble").innerText.includes(t), FOUND[g]);
    assert.equal(await p.evaluate(() => location.hash), "", "the #gadget is removed from the address");
    pageErrors(p);
    await p.context().close();
  }
});

test("web: Explore with 5 tags, each opening a new tab (iPhone + NFC Tools flow)", async () => {
  const first = await open("web", { storage: READY });
  const ctx = first.context();
  await toMenu(first);
  await first.click('[data-go="explore"]');
  await waitFor(first, () => S.screen === "explore");
  let page = first;
  for (const [i, g] of GADGETS.entries()) {
    const prev = page;
    page = await open("web", { context: ctx, hash: "#" + g });          // the iPhone opens the tag's link in a new tab
    await waitFor(page, n => S.screen === "explore" && S.found.length === n, i + 1);
    pageErrors(page);
    await prev.close();                                                 // older Safari tabs sit paused in the background
  }
  assert.deepEqual(await page.evaluate(() => S.found), GADGETS);
  await waitFor(page, () => document.getElementById("bubble").innerText.includes("found all my gadgets"), null, 5000);
  assert.match(await page.evaluate(() => document.getElementById("panel").innerText), /Found 5 of 5/);
  await ctx.close();
});

test("web: Memory game played with tag links, including a mistake", async () => {
  const first = await open("web", { storage: { ...READY, "robi-prefs": { mem: 3, hash: 4 } } });
  const ctx = first.context();
  await toMenu(first);
  await first.click('[data-go="memory"]');
  const next = async g => { const prev = page; page = await open("web", { context: ctx, hash: "#" + g }); await prev.close(); };
  let page = first;
  await next("antenna");                                                // scan the antenna to start
  await waitFor(page, () => S.screen === "memory" && S.phase === "input", null, 10000);
  const seq = await page.evaluate(() => S.seq);
  assert.equal(seq.length, 3);
  // a wrong gadget first: the robot shows the sequence again
  const wrong = GADGETS.find(g => g !== seq[0]);
  await next(wrong);
  await waitFor(page, () => document.getElementById("bubble").innerText.includes("Oops"));
  await waitFor(page, () => S.phase === "input", null, 10000);
  for (const [i, g] of seq.entries()) {
    await next(g);
    await waitFor(page, n => S.pos === n || S.phase === "win", i + 1, 8000);
  }
  await waitFor(page, () => S.phase === "win");
  assert.match(await bubble(page), /what a memory, Mia/);
  pageErrors(page);
  await ctx.close();
});

test("web: Maltese mode only tells jokes that work in Maltese", async () => {
  const p = await open("web", { storage: { ...READY, "robi-lang": "mt" } });
  await toMenu(p);
  const r = await p.evaluate(() => {
    const seen = new Set();
    for (let i = 0; i < 300; i++) { tellJoke(); seen.add(jokeIdx); }
    return { allMt: [...seen].every(k => JOKES[k][0].mt != null && JOKES[k][1].mt != null), distinct: seen.size,
             mtTotal: JOKES.filter(j => j[0].mt != null).length, englishInBubble: !!document.querySelector("#bubble .t-en") };
  });
  assert.ok(r.allMt, "an English-only joke came up in Maltese mode");
  assert.equal(r.distinct, r.mtTotal, "every Maltese joke can come up");
  assert.equal(r.englishInBubble, false);
  pageErrors(p);
});

test("web: every joke has a setup and a punchline, English-only ones on both lines", async () => {
  const p = await open("web");
  const bad = await p.evaluate(() => JOKES.filter(([a, b]) => !a?.en || !b?.en || ((a.mt == null) !== (b.mt == null))).length);
  assert.equal(bad, 0);
});

// ---------------------------------------------------------------- iOS app (Capacitor bridge, fake native side)

test("iOS: the NFC plugin is reachable and Scan opens the native scanner", async () => {
  const p = await open("ios", { storage: READY });
  assert.equal(await p.evaluate(() => [PLATFORM, !!NativeNfc].join()), "ios,true");
  await toMenu(p);
  await waitFor(p, () => !document.getElementById("scanBtn").hidden);
  await p.click("#scanBtn");
  await waitFor(p, () => window.__calls.some(c => c.methodName === "startScan"));
  const c = await calls(p);
  assert.ok(c.indexOf("isAvailable") < c.indexOf("startScan"), "checks availability before opening the scanner");
  assert.match((await lastCall(p, "startScan")).options.message, /Hold me near the phone/);
  await waitFor(p, () => document.getElementById("scanBtn").hidden, null, 3000);   // hidden while the sheet is open
  assert.equal(await toast(p), "", "no error notice");
  pageErrors(p);
});

test("iOS: a tag read in the scanner reaches the game (both records and URL-only)", async () => {
  const p = await open("ios", { storage: READY });
  await toMenu(p);
  await p.click("#scanBtn");
  await waitFor(p, () => window.__calls.some(c => c.methodName === "startScan"));
  await nativeEvent(p, "tag", TAG.full("terminal"));
  await waitFor(p, t => document.getElementById("bubble").innerText.includes(t), FOUND.terminal);
  await nativeEvent(p, "tag", TAG.urlOnly("bootL"));
  await waitFor(p, t => document.getElementById("bubble").innerText.includes(t), FOUND.bootL);
  pageErrors(p);
});

test("iOS: closing the scanner brings the Scan button back without an error", async () => {
  const p = await open("ios", { storage: READY });
  await toMenu(p);
  await p.click("#scanBtn");
  await waitFor(p, () => NFC.scanning === true);
  await nativeEvent(p, "sessionEnded", { reason: "Session invalidated by user", code: 200 });
  await waitFor(p, () => !document.getElementById("scanBtn").hidden);
  assert.equal(await toast(p), "");
});

test("iOS: a scanner error is shown on screen", async () => {
  const p = await open("ios", { storage: READY });
  await toMenu(p);
  await p.click("#scanBtn");
  await waitFor(p, () => NFC.scanning === true);
  await nativeEvent(p, "sessionEnded", { reason: "Missing required entitlement", code: 203 });
  await waitFor(p, () => document.getElementById("toast").innerText.includes("Missing required entitlement"));
});

test("iOS: NFC not available shows the iPhone message", async () => {
  const p = await open("ios", { storage: READY, auto: { isAvailable: { available: false, enabled: false, needsButton: true } } });
  await toMenu(p);
  await p.click("#scanBtn");
  await waitFor(p, () => document.getElementById("toast").innerText.includes("This iPhone app can't use NFC"));
  assert.ok(!(await calls(p)).includes("startScan"));
});

test("iOS: plugin not registered shows a clear error (the old SceneDelegate bug)", async () => {
  const p = await open("ios", { storage: READY, noPlugin: true });
  await waitFor(p, () => document.getElementById("toast").innerText.includes("NFC part of the app is missing"));
  await toMenu(p);
  await p.click("#scanBtn");
  await waitFor(p, () => document.getElementById("toast").innerText.includes("not implemented"));
});

test("iOS + Android: writing tags sends the right records and reports success", async () => {
  for (const platform of ["ios", "android"]) {
    const p = await open(platform, { storage: READY });
    await toMenu(p);
    await p.click("#gear");
    // antenna: URL with the names + data record with the names
    await p.click('[data-w="antenna"]');
    await waitFor(p, () => window.__calls.some(c => c.methodName === "writeMerged"));
    let o = (await lastCall(p, "writeMerged")).options;
    assert.equal(o.records[0].type, "url");
    assert.equal(o.records[0].data, "https://robi.panbias.com.ar/?name=Robi&friend=Mia#antenna");
    assert.equal(o.records[1].type, "mime");
    assert.equal(o.records[1].mediaType, "application/x-robi+json");
    assert.deepEqual(JSON.parse(o.records[1].data), { v: 1, part: "antenna", name: "Robi", friend: "Mia" });
    assert.deepEqual(o.compact, [o.records[0]], "small tags get the URL only");
    const ours = new RegExp(o.ourUrlRegex, "i");
    for (const g of GADGETS) assert.ok(ours.test(`https://robi.panbias.com.ar/#${g}`), `old ${g} link is replaced, not duplicated`);
    assert.ok(!ours.test("https://example.com/menu"), "other links on the tag are kept");
    await nativeReply(p, "writeMerged", { written: true, compact: false, bytes: 120, maxSize: 496 });
    await waitFor(p, () => /Done!/.test(document.getElementById("writeMsg").innerText));
    // a boot: plain URL, robot's own left
    await p.waitForTimeout(1600);
    await p.click('[data-w="bootL"]');
    await waitFor(p, () => window.__calls.filter(c => c.methodName === "writeMerged").length === 2);
    o = (await lastCall(p, "writeMerged")).options;
    assert.equal(o.records[0].data, "https://robi.panbias.com.ar/#bootL");
    assert.deepEqual(JSON.parse(o.records[1].data), { v: 1, part: "bootL" });
    // a failed write is reported
    await nativeReply(p, "writeMerged", null, { message: "This tag is locked (read-only)", code: "READ_ONLY" });
    await waitFor(p, () => /Couldn't write the tag/.test(document.getElementById("writeMsg").innerText));
    pageErrors(p);
    await p.context().close();
  }
});

// ---------------------------------------------------------------- Android app (Capacitor bridge, fake native side)

test("Android: starts reading tags at launch, with no Scan button", async () => {
  const p = await open("android", { storage: READY });
  assert.equal(await p.evaluate(() => [PLATFORM, !!NativeNfc].join()), "android,true");
  await waitFor(p, () => window.__calls.some(c => c.methodName === "startScan"));
  await toMenu(p);
  assert.equal(await p.evaluate(() => document.getElementById("scanBtn").hidden), true);
  assert.equal(await toast(p), "");
  pageErrors(p);
});

test("Android: tags touched with the app open are handled (full and URL-only, all gadgets)", async () => {
  const p = await open("android", { storage: READY });
  await toMenu(p);
  await p.click('[data-go="explore"]');
  for (const [i, g] of GADGETS.entries()) {
    await nativeEvent(p, "tag", i % 2 ? TAG.urlOnly(g) : TAG.full(g));
    await waitFor(p, n => S.found.length === n, i + 1);
  }
  assert.deepEqual(await p.evaluate(() => S.found), GADGETS);
  pageErrors(p);
});

test("Android: the same tag held still counts once, a new touch later counts again", async () => {
  const p = await open("android", { storage: READY });
  await toMenu(p);
  await p.click('[data-go="memory"]');
  const n0 = await p.evaluate(() => NFC.last.t);
  await nativeEvent(p, "tag", TAG.full("terminal"));
  await nativeEvent(p, "tag", TAG.full("terminal"));
  const r = await p.evaluate(() => NFC.last);
  assert.equal(r.g, "terminal"); assert.notEqual(r.t, n0);
  const t1 = r.t;
  await nativeEvent(p, "tag", TAG.full("terminal"));
  assert.equal(await p.evaluate(() => NFC.last.t), t1, "a repeat within 1.2 s is ignored");
  await p.waitForTimeout(1300);
  await nativeEvent(p, "tag", TAG.full("terminal"));
  assert.notEqual(await p.evaluate(() => NFC.last.t), t1, "after 1.2 s it counts again");
});

test("Android: app opened by touching a tag goes straight to that gadget", async () => {
  const p = await open("android", { storage: READY, auto: { getLaunchTag: TAG.full("hash") } });
  await waitFor(p, t => document.getElementById("bubble").innerText.includes(t), FOUND.hash);
  assert.equal(await p.evaluate(() => S.screen), "menu");
  pageErrors(p);
});

test("Android: antenna tag with names teaches the robot its name", async () => {
  const p = await open("android", { storage: { "robi-onboarded": true } });
  await nativeEvent(p, "tag", { records: [
    { type: "url", data: "https://robi.panbias.com.ar/?name=Bolt&friend=Leo#antenna" },
    { type: "mime", mediaType: "application/x-robi+json", data: JSON.stringify({ v: 1, part: "antenna", name: "Bolt", friend: "Leo" }) }] });
  await waitFor(p, () => robotName === "Bolt" && friendName === "Leo");
  assert.equal(await p.evaluate(() => document.getElementById("title").innerText), "Bolt");
});

test("Android: NFC off shows a message, and reading starts after turning it on and coming back", async () => {
  const p = await open("android", { storage: READY, auto: { isAvailable: { available: true, enabled: false, needsButton: false } } });
  await waitFor(p, () => document.getElementById("toast").innerText.includes("Turn on NFC"));
  assert.ok(!(await calls(p)).includes("startScan"));
  await p.evaluate(() => { window.__auto.isAvailable = { available: true, enabled: true, needsButton: false }; document.dispatchEvent(new Event("visibilitychange")); });
  await waitFor(p, () => window.__calls.some(c => c.methodName === "startScan"));
});

test("Android: a tag arriving during a write is not treated as a scan", async () => {
  const p = await open("android", { storage: READY });
  await toMenu(p);
  await p.click("#gear");
  await p.click('[data-w="hash"]');
  await waitFor(p, () => NFC.busy === true);
  await nativeEvent(p, "tag", TAG.full("terminal"));
  assert.notEqual(await p.evaluate(() => NFC.last.g), "terminal");
});

// ---------------------------------------------------------------- run

await start();
let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log("  ✔ " + t.name); }
  catch (e) { failed++; console.log("  ✘ " + t.name + "\n      " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n      ")); }
}
await stop();
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
