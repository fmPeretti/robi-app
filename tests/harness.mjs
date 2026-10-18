// Test harness: loads www/index.html in headless Chromium, optionally inside Capacitor's real
// native bridge (the same native-bridge.js the iOS / Android apps inject) with a fake native side.
// The fake native side records every plugin call and answers them like the phone would.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const WWW = "file://" + path.join(root, "www", "index.html");

const BRIDGE = {
  ios: path.join(root, "node_modules/@capacitor/ios/Capacitor/Capacitor/assets/native-bridge.js"),
  android: path.join(root, "node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js"),
};

// What Capacitor publishes for RobiNfc (JSExport.createPluginHeader on iOS, same shape on Android)
const HEADERS = [{ name: "RobiNfc", methods: [
  { name: "addListener" }, { name: "removeListener" }, { name: "removeAllListeners", rtype: "promise" },
  { name: "checkPermissions", rtype: "promise" }, { name: "requestPermissions", rtype: "promise" },
  ...["isAvailable", "startScan", "stopScan", "writeMerged", "cancelWrite", "getLaunchTag"].map(name => ({ name, rtype: "promise" })),
] }];

// Default native answers; tests override them. A method missing here stays unanswered until the test replies.
const AUTO = {
  ios: { isAvailable: { available: true, enabled: true, needsButton: true }, startScan: {}, stopScan: {}, cancelWrite: {}, getLaunchTag: {}, removeListener: {}, removeAllListeners: {} },
  android: { isAvailable: { available: true, enabled: true, needsButton: false }, startScan: {}, stopScan: {}, cancelWrite: {}, getLaunchTag: {}, removeListener: {}, removeAllListeners: {} },
};

let browser;
export async function start() { browser = await chromium.launch(); }
export async function stop() { await browser?.close(); }

/**
 * Open the app. platform: "web" | "ios" | "android".
 * opts.auto: overrides for the fake native answers; opts.storage: localStorage to start with;
 * opts.noPlugin: the native side doesn't publish RobiNfc (plugin not registered); opts.hash: "#terminal" etc.
 */
export async function open(platform, opts = {}) {
  const context = opts.context || await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", e => page.errors.push(e.message));
  if (opts.storage) await page.addInitScript(s => { if (!sessionStorage.getItem("__seeded")) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v)); sessionStorage.setItem("__seeded", "1"); } }, opts.storage);
  if (platform !== "web") {
    const auto = { ...AUTO[platform], ...(opts.auto || {}) };
    await page.addInitScript({ content: `
      window.__calls = []; window.__auto = ${JSON.stringify(auto)};
      const __answer = call => {
        if (call.pluginId === "Console") return;
        window.__calls.push(call);
        const a = window.__auto[call.methodName];
        if (a === undefined || call.methodName === "addListener") return;
        setTimeout(() => window.Capacitor.fromNative(a && a.__error
          ? { callbackId: call.callbackId, pluginId: call.pluginId, methodName: call.methodName, success: false, error: a.__error }
          : { callbackId: call.callbackId, pluginId: call.pluginId, methodName: call.methodName, success: true, data: a }), 10);
      };
      ${platform === "ios"
        ? "window.webkit = { messageHandlers: { bridge: { postMessage: m => __answer(m) } } };"
        : "window.androidBridge = { postMessage: m => __answer(JSON.parse(m)) };"}
      ${fs.readFileSync(BRIDGE[platform], "utf8")}
      ${opts.noPlugin ? "" : `window.Capacitor.PluginHeaders = ${JSON.stringify(HEADERS)};`}
    ` });
  }
  await page.goto(WWW + (opts.hash || ""));
  await page.waitForFunction(() => typeof S !== "undefined" && typeof render === "function");
  return page;
}

/** Plugin calls the app sent, e.g. ["isAvailable", "startScan"] */
export const calls = page => page.evaluate(() => window.__calls.map(c => c.methodName));
export const lastCall = (page, method) => page.evaluate(m => window.__calls.filter(c => c.methodName === m).pop() || null, method);

/** The native side fires a plugin event (like notifyListeners("tag", …)) */
export async function nativeEvent(page, eventName, data) {
  const ok = await page.evaluate(({ eventName, data }) => {
    const l = window.__calls.find(c => c.methodName === "addListener" && c.options && c.options.eventName === eventName);
    if (!l) return false;
    window.Capacitor.fromNative({ callbackId: l.callbackId, pluginId: l.pluginId, methodName: "addListener", success: true, data, save: true });
    return true;
  }, { eventName, data });
  if (!ok) throw new Error(`the app has no "${eventName}" listener`);
}

/** Answer the latest pending call to a method */
export async function nativeReply(page, method, data, error) {
  await page.evaluate(({ method, data, error }) => {
    const c = window.__calls.filter(x => x.methodName === method).pop();
    if (!c) throw new Error("no call to " + method);
    window.Capacitor.fromNative(error ? { callbackId: c.callbackId, pluginId: c.pluginId, methodName: method, success: false, error }
                                      : { callbackId: c.callbackId, pluginId: c.pluginId, methodName: method, success: true, data });
  }, { method, data, error });
}

export const bubble = page => page.evaluate(() => document.getElementById("bubble").innerText.replace(/\s+/g, " ").trim());
export const toast = page => page.evaluate(() => { const t = document.getElementById("toast"); return t.hidden ? "" : t.innerText.replace(/\s+/g, " ").trim(); });
export const waitFor = (page, fn, arg, timeout = 5000) => page.waitForFunction(fn, arg, { timeout });

// Tags as the plugins hand them to the app
export const TAG = {
  full: g => ({ records: [{ type: "url", data: `https://robi.panbias.com.ar/#${g}` }, { type: "mime", mediaType: "application/x-robi+json", data: JSON.stringify({ v: 1, part: g }) }] }),
  urlOnly: g => ({ records: [{ type: "url", data: `https://robi.panbias.com.ar/#${g}` }] }),
};
