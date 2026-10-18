// Smoke test of the real Android APK on an emulator (run by CI inside android-emulator-runner).
// The emulator has no NFC chip, so this can't read a physical tag, but it checks everything around it:
// the manifest sends Robi's tags to the app, the app starts without errors, and the page reaches the
// Java RobiNfc plugin (calls go in and real answers come back). Needs a debug APK (WebView inspectable).
import { _android as android } from "playwright";
import { execSync } from "node:child_process";
import fs from "node:fs";

const PKG = process.env.APP_ID || "com.robi.robot";
const OUT = process.env.OUT_DIR || "emulator-results";
fs.mkdirSync(OUT, { recursive: true });
const sh = c => execSync(c, { encoding: "utf8" });
let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`  ${ok ? "✔" : "✘"} ${name}${detail ? "  (" + detail + ")" : ""}`); };
const shot = name => fs.writeFileSync(`${OUT}/${name}.png`, execSync("adb exec-out screencap -p"));
const resolves = args => sh(`adb shell cmd package query-activities --brief -c android.intent.category.DEFAULT ${args}`).includes(PKG);

// ---- manifest: what Android does when one of Robi's tags is touched with the app closed
check("app has the NFC permission", sh(`adb shell dumpsys package ${PKG}`).includes("android.permission.NFC"));
for (const g of ["antenna", "terminal", "hash", "bootL", "bootR"])
  check(`tag link #${g} opens Robi`, resolves(`-a android.nfc.action.NDEF_DISCOVERED -d "https://robi.panbias.com.ar/#${g}"`));
check("antenna link with names opens Robi", resolves(`-a android.nfc.action.NDEF_DISCOVERED -d "https://robi.panbias.com.ar/?name=Robi\\&friend=Mia#antenna"`));
check("Robi data record opens Robi", resolves(`-a android.nfc.action.NDEF_DISCOVERED -t application/x-robi+json`));
check("other websites' tags don't open Robi", !resolves(`-a android.nfc.action.NDEF_DISCOVERED -d "https://example.com/menu"`));

// Whatever happens next, keep the Android log, the crash log and a screenshot for the CI artifact
const saveLogs = () => {
  try { shot("last"); } catch {}
  try { fs.writeFileSync(`${OUT}/logcat.txt`, sh(`adb logcat -d`)); } catch {}
  try { fs.writeFileSync(`${OUT}/crash-log.txt`, sh(`adb logcat -d -b crash`)); } catch {}
};
process.on("uncaughtException", e => { console.log("  ✘ test stopped: " + e.message); saveLogs(); process.exit(1); });
process.on("unhandledRejection", e => { console.log("  ✘ test stopped: " + (e && e.message || e)); saveLogs(); process.exit(1); });

// ---- launch the app and look inside its WebView
sh(`adb logcat -c`);
sh(`adb shell am start -W -n ${PKG}/.MainActivity`);
const [device] = await android.devices();
// The WebView's first page can be replaced while Capacitor loads the app, so (re)attach until the app is there
async function appPage() {
  let last = "";
  for (let i = 0; i < 12; i++) {
    try {
      const wv = await device.webView({ pkg: PKG }, { timeout: 60000 });
      const p = await wv.page();
      await p.waitForFunction(() => typeof S !== "undefined" && typeof NativeNfc !== "undefined", null, { timeout: 15000 });
      return p;
    } catch (e) { last = e.message.split("\n")[0]; console.log(`    (waiting for the app's page: ${last})`); }
    let pid = ""; try { pid = sh(`adb shell pidof ${PKG}`).trim(); } catch {}
    if (!pid) { console.log("    (the app is not running)"); break; }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error("couldn't reach the app's page: " + last);
}
let page = await appPage();
await page.waitForTimeout(3000);                        // let start-up finish (it already asks the plugin to start reading)
shot("1-wake");

const r = await page.evaluate(async () => {
  const out = { version: APP_VERSION, platform: PLATFORM, plugin: !!NativeNfc, published: Capacitor.isPluginAvailable("RobiNfc") };
  // a write waits for a tag (forever on an emulator with NFC), so "still waiting" also means Java got the call
  const tryCall = async (m, o) => { try { return { ok: await Promise.race([NativeNfc[m](o || {}), new Promise(res => setTimeout(() => res("pending"), 4000))]) }; } catch (e) { return { error: e.message, code: e.code }; } };
  out.isAvailable = await tryCall("isAvailable");
  out.getLaunchTag = await tryCall("getLaunchTag");
  out.startScan = await tryCall("startScan");
  out.stopScan = await tryCall("stopScan");
  out.writeMerged = await tryCall("writeMerged", { records: [{ type: "url", data: "https://robi.panbias.com.ar/#hash" }], mime: MIME });
  out.cancelWrite = await tryCall("cancelWrite");
  out.toast = document.getElementById("toast").hidden ? "" : document.getElementById("toast").innerText.replace(/\s+/g, " ");
  return out;
});
console.log("    " + JSON.stringify(r));
const answered = x => x && (x.ok !== undefined || (x.error && !/not implemented/i.test(x.error)));
check("running the build under test", !!r.version, r.version);
check("the page knows it's the Android app", r.platform === "android");
check("the page has the RobiNfc plugin", r.plugin && r.published);
check("Java answers isAvailable", !!(r.isAvailable.ok && "available" in r.isAvailable.ok), JSON.stringify(r.isAvailable));
check("Java answers getLaunchTag (opened normally: no tag)", !!r.getLaunchTag.ok && !r.getLaunchTag.ok.records, JSON.stringify(r.getLaunchTag));
for (const m of ["startScan", "stopScan", "writeMerged", "cancelWrite"]) check(`Java answers ${m}`, answered(r[m]), JSON.stringify(r[m]));
check("no 'not implemented' or crash notice on screen", !/not implemented|missing|Error:/i.test(r.toast), r.toast || "no notice");

// ---- the app works: wake up, open the menu, and handle a tag the way the plugin delivers it
await page.click('[data-act="wake"]').catch(() => {});
await page.waitForFunction(() => S.screen === "intro" || S.screen === "menu", null, { timeout: 15000 });
await page.evaluate(() => { onboarded = true; go("menu"); render(); });
await page.waitForTimeout(800);
shot("2-menu");
await page.evaluate(() => handleTagInfo(parseSimple([{ type: "url", data: "https://robi.panbias.com.ar/#terminal" }])));
await page.waitForTimeout(800);
check("a tag reaches the game", (await page.evaluate(() => document.getElementById("bubble").innerText)).includes("Terminal"));
shot("3-tag");

// ---- the app is opened by an NFC intent (how Android starts it from a tag; extras can't be faked via adb)
let started = "";
try { started = sh(`adb shell am start -W -a android.nfc.action.NDEF_DISCOVERED -d "https://robi.panbias.com.ar/#hash" -n ${PKG}/.MainActivity`); }
catch (e) { started = String(e.stdout || e.message); }
await page.waitForTimeout(1500);
let alive = ""; try { alive = sh(`adb shell pidof ${PKG}`).trim(); } catch {}
check("the app survives being opened by an NFC intent", alive.length > 0, started.split("\n").find(l => /Status|Error/.test(l)) || "");

// ---- no Java crash in the log
saveLogs();
const log = fs.readFileSync(`${OUT}/crash-log.txt`, "utf8");
check("no crash in the Android log", !log.includes(PKG), log.includes(PKG) ? "see crash-log.txt" : "");
console.log(failed ? `\n${failed} emulator check(s) failed` : "\nall emulator checks passed");
process.exit(failed ? 1 : 0);
