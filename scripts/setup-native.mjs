// Robi: wires the NFC plugin into the native projects created by `npx cap add android|ios`.
// Usage: node scripts/setup-native.mjs android   (or ios)
// Safe to run more than once.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const platform = process.argv[2];
const cap = JSON.parse(fs.readFileSync(path.join(root, "capacitor.config.json"), "utf8"));
const robi = JSON.parse(fs.readFileSync(path.join(root, "robi.config.json"), "utf8"));
const MIME = "application/x-robi+json";

const read = (p) => fs.readFileSync(p, "utf8");
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const ok = (m) => console.log("  ✔ " + m);
const fail = (m) => { console.error("  ✘ " + m); process.exit(1); };

// The web app needs to know where the tags' links point (for phones without the app).
write(path.join(root, "www", "robi-config.js"),
  `window.ROBI_WEB_BASE = ${JSON.stringify(robi.webBase || "")};\n`);
ok("www/robi-config.js written (webBase: " + (robi.webBase || "not set") + ")");

if (platform === "android") setupAndroid();
else if (platform === "ios") setupIos();
else fail("Say which platform: node scripts/setup-native.mjs android|ios");

function setupAndroid() {
  const app = path.join(root, "android", "app", "src", "main");
  if (!fs.existsSync(app)) fail("android/ not found. Run `npx cap add android` first.");
  const pkg = cap.appId;
  const javaDir = path.join(app, "java", ...pkg.split("."));

  // 1. plugin source
  const plugin = read(path.join(root, "native", "android", "RobiNfcPlugin.java")).replace("__PACKAGE__", pkg);
  write(path.join(javaDir, "RobiNfcPlugin.java"), plugin);
  ok("RobiNfcPlugin.java copied");

  // 2. register it in MainActivity (replace the generated one)
  for (const f of ["MainActivity.kt", "MainActivity.java"]) {
    const p = path.join(javaDir, f); if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  write(path.join(javaDir, "MainActivity.java"),
`package ${pkg};

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RobiNfcPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`);
  ok("MainActivity registers the NFC plugin");

  // 3. manifest: NFC permission + open the app when a Robi tag is touched
  const mf = path.join(app, "AndroidManifest.xml");
  let xml = read(mf);
  if (!xml.includes("android.permission.NFC")) {
    xml = xml.replace("<application",
      `<uses-permission android:name="android.permission.NFC" />\n    <uses-feature android:name="android.hardware.nfc" android:required="false" />\n\n    <application`);
  }
  if (!xml.includes(MIME)) {
    let host = "";
    try { host = robi.webBase ? new URL(robi.webBase).host : ""; } catch { host = ""; }
    const filters =
`            <!-- Robi: open the app when one of the robot's tags is touched -->
            <intent-filter>
                <action android:name="android.nfc.action.NDEF_DISCOVERED" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="${MIME}" />
            </intent-filter>
` + (host ? `            <intent-filter>
                <action android:name="android.nfc.action.NDEF_DISCOVERED" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:scheme="https" android:host="${host}" />
            </intent-filter>
` : "");
    const end = xml.indexOf("</activity>");
    if (end < 0) fail("Couldn't find </activity> in AndroidManifest.xml");
    const i = xml.lastIndexOf("\n", end) + 1;          // start of the </activity> line
    xml = xml.slice(0, i) + filters + xml.slice(i);
  }
  write(mf, xml);
  ok("AndroidManifest.xml: NFC permission and tag intent filters");
  console.log("\nAndroid ready. Next: npx cap sync android && npx cap open android");
}

function setupIos() {
  const appDir = path.join(root, "ios", "App", "App");
  if (!fs.existsSync(appDir)) fail("ios/ not found. Run `npx cap add ios` first (on a Mac).");

  // 1. plugin + view controller appended to AppDelegate.swift (already part of the Xcode target).
  //    A previous copy (from its marker line to the end) is replaced, so re-running picks up changes.
  const ad = path.join(appDir, "AppDelegate.swift");
  let swift = read(ad);
  const mark = swift.indexOf("// ===================== Robi NFC");
  if (mark >= 0) swift = swift.slice(0, mark).replace(/\n+$/, "\n");
  for (const m of ["CoreNFC", "AVFoundation"])
    if (!swift.includes(`import ${m}`)) swift = swift.replace("import Capacitor", `import Capacitor\nimport ${m}`);
  swift += "\n" + read(path.join(root, "native", "ios", "RobiNfc.swift"));
  write(ad, swift);
  ok("NFC plugin added to AppDelegate.swift");

  // 2. storyboard uses our view controller (it registers the plugin)
  const sb = path.join(appDir, "Base.lproj", "Main.storyboard");
  let sbx = read(sb);
  if (!sbx.includes("RobiViewController")) {
    sbx = sbx.replace(/customClass="CAPBridgeViewController" customModule="Capacitor"/,
      'customClass="RobiViewController" customModule="App" customModuleProvider="target"');
    if (!sbx.includes("RobiViewController")) fail("Couldn't patch Main.storyboard");
    write(sb, sbx);
  }
  ok("Main.storyboard uses RobiViewController");

  // 3. Info.plist: why the app uses NFC
  const plist = path.join(appDir, "Info.plist");
  let p = read(plist);
  if (!p.includes("NFCReaderUsageDescription")) {
    const i = p.lastIndexOf("</dict>");
    p = p.slice(0, i) + "\t<key>NFCReaderUsageDescription</key>\n\t<string>Robi reads the tags inside the toy robot.</string>\n" + p.slice(i);
    write(plist, p);
  }
  ok("Info.plist: NFC usage text");

  // 4. entitlements file (Xcode still needs the capability switched on, see README)
  const ent = path.join(appDir, "App.entitlements");
  if (!fs.existsSync(ent)) {
    write(ent, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>com.apple.developer.nfc.readersession.formats</key>
\t<array>
\t\t<string>TAG</string>
\t</array>
</dict>
</plist>
`);
  }
  ok("App.entitlements created");
  console.log("\niOS almost ready. In Xcode: App target → Signing & Capabilities → + Capability → Near Field Communication Tag Reading.");
}
