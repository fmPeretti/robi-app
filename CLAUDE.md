# Robi: NFC robot plushie app

A gift for a friend's kid (about 2 years old): a crocheted robot plushie with 5 NFC tags inside. The app shows a 3D model of the plushie and reacts when the phone touches its tags. All UI text is in English and Maltese, with an EN / MT / EN+MT toggle (default EN+MT). Fonts must stay big and readable.

## Structure

- `www/index.html`: the whole app in one file (HTML, CSS, JS, GLSL shader, plus a base64 chenille texture). It is also published as a plain web page (`robot.html`); the native build wraps this same file.
  - The first lines up to `<body>` are the native wrapper (viewport and `robi-config.js`). The rest is identical to the web `robot.html`.
- `native/android/RobiNfcPlugin.java`: Capacitor plugin `RobiNfc` (reader mode, read-merge-write, launch from tag). `__PACKAGE__` is replaced by the appId.
- `native/ios/RobiNfc.swift`: the same plugin for iOS (NFCNDEFReaderSession). It gets appended to `AppDelegate.swift`. `RobiViewController` registers it and is wired into `Main.storyboard`.
- `scripts/setup-native.mjs`: runs after `npx cap add android|ios`. It copies and registers the plugin, patches AndroidManifest (NFC permission and NDEF intent filters), Info.plist and the storyboard, and writes `www/robi-config.js` from `robi.config.json`. It can be run more than once.
- `robi.config.json`: `webBase` is the hosted URL of the web version, used in the tag links.
- `assets/`: icon and splash sources for `npx @capacitor/assets generate`.

## Stack

- Capacitor 8: Node 22+, Android Studio 2025.2.1+, Xcode 26+.
- No bundler. The page loads `www/capacitor.js` (the browser build of `@capacitor/core`, copied by `setup-native.mjs`): the native bridge alone has no `Capacitor.registerPlugin`, and without it the app never reaches the NFC plugin on iOS or Android. The JS uses `window.Capacitor.registerPlugin("RobiNfc")` when native, and falls back to Web NFC (`NDEFReader`) in Chrome on Android.

## Build an Android APK

```
npm install
npm run icons
npm run android      # cap add android + setup-native + cap sync + opens Android Studio
```

The APK is built from Android Studio (Build → Generate APKs), or with `cd android && ./gradlew assembleDebug`, which outputs `android/app/build/outputs/apk/debug/app-debug.apk`.

## Tag format

Gadget keys: `antenna`, `terminal` (the `>_` on the chest), `hash` (the `#` on the back), `bootL`, `bootR` (the robot's own left and right).

Each tag holds two records:
1. A URL record: `<webBase>#<gadget>`. On the antenna it also carries `?name=&friend=`.
2. A MIME record `application/x-robi+json`: `{"v":1,"part":…,"name":…,"friend":…}`.

Writing reads the tag first and keeps every record that isn't ours. If the tag is too small (NTAG213), only the URL record is written.

## Status

- The native project was written without access to the Android SDK or Xcode, so the first real build is the first test. Fix compile errors there if they appear.
- The Android plugin compiled against stubbed APIs only. The iOS code is unverified.
- The Maltese translations still need checking by a native speaker.
- Do not add the Claude mascot or any other brand character to the app.
