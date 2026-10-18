
// ===================== Robi NFC (added by scripts/setup-native.mjs) =====================
// iPhone reads NFC through a system sheet that must be opened from a tap.
// While the sheet is open it keeps reading tags (up to ~60 s), then the app shows its Scan button again.

@objc(RobiNfcPlugin)
public class RobiNfcPlugin: CAPPlugin, CAPBridgedPlugin, NFCNDEFReaderSessionDelegate {
    public let identifier = "RobiNfcPlugin"
    public let jsName = "RobiNfc"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startScan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopScan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeMerged", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelWrite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLaunchTag", returnType: CAPPluginReturnPromise)
    ]

    private var session: NFCNDEFReaderSession?
    private var pendingWrite: CAPPluginCall?

    @objc func isAvailable(_ call: CAPPluginCall) {
        let ok = NFCNDEFReaderSession.readingAvailable
        call.resolve(["available": ok, "enabled": ok, "needsButton": true])
    }

    @objc func startScan(_ call: CAPPluginCall) {
        guard NFCNDEFReaderSession.readingAvailable else { call.reject("NFC is not available on this phone", "NO_NFC"); return }
        openSession(message: call.getString("message") ?? "Hold me near the phone")
        call.resolve()
    }

    @objc func stopScan(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.session?.invalidate(); self.session = nil }
        call.resolve()
    }

    @objc func writeMerged(_ call: CAPPluginCall) {
        guard NFCNDEFReaderSession.readingAvailable else { call.reject("NFC is not available on this phone", "NO_NFC"); return }
        call.keepAlive = true
        pendingWrite?.reject("Replaced by a new write", "CANCELLED")
        pendingWrite = call
        openSession(message: call.getString("message") ?? "Hold the tag near the phone")
    }

    @objc func cancelWrite(_ call: CAPPluginCall) {
        if let w = pendingWrite { w.reject("Cancelled", "CANCELLED"); w.keepAlive = false; pendingWrite = nil }
        DispatchQueue.main.async { self.session?.invalidate(); self.session = nil }
        call.resolve()
    }

    @objc func getLaunchTag(_ call: CAPPluginCall) { call.resolve([:]) }

    private func openSession(message: String) {
        DispatchQueue.main.async {
            self.session?.invalidate()
            let s = NFCNDEFReaderSession(delegate: self, queue: nil, invalidateAfterFirstRead: false)
            s.alertMessage = message
            self.session = s
            s.begin()
        }
    }

    // MARK: NFCNDEFReaderSessionDelegate

    public func readerSession(_ session: NFCNDEFReaderSession, didInvalidateWithError error: Error) {
        if let w = pendingWrite { w.reject(error.localizedDescription, "SESSION_ENDED"); w.keepAlive = false; pendingWrite = nil }
        if session === self.session { self.session = nil }
        notifyListeners("sessionEnded", data: ["reason": error.localizedDescription])
    }

    public func readerSession(_ session: NFCNDEFReaderSession, didDetectNDEFs messages: [NFCNDEFMessage]) {
        // Not used: didDetect tags below handles reading and writing.
    }

    public func readerSession(_ session: NFCNDEFReaderSession, didDetect tags: [NFCNDEFTag]) {
        guard let tag = tags.first else { return }
        session.connect(to: tag) { error in
            if error != nil { session.restartPolling(); return }
            tag.queryNDEFStatus { status, capacity, _ in
                tag.readNDEF { message, _ in
                    let existing = message?.records ?? []
                    if let call = self.pendingWrite {
                        self.write(call, tag: tag, session: session, existing: existing, status: status, capacity: capacity)
                    } else {
                        self.notifyListeners("tag", data: ["records": existing.map { self.recordToJs($0) }])
                        session.alertMessage = "✓"
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { session.restartPolling() }
                    }
                }
            }
        }
    }

    private func write(_ call: CAPPluginCall, tag: NFCNDEFTag, session: NFCNDEFReaderSession,
                       existing: [NFCNDEFPayload], status: NFCNDEFStatus, capacity: Int) {
        let finish: (String?, String?, [String: Any]?) -> Void = { err, code, result in
            self.pendingWrite = nil
            if let err = err { call.reject(err, code); session.invalidate(errorMessage: err) }
            else { call.resolve(result ?? [:]); session.alertMessage = "Saved ✓"; session.invalidate() }
            call.keepAlive = false
        }
        if status == .readOnly { finish("This tag is locked (read-only)", "READ_ONLY", nil); return }
        if status == .notSupported { finish("This tag can't store NFC data", "UNSUPPORTED", nil); return }

        let mime = call.getString("mime") ?? ""
        let regex = call.getString("ourUrlRegex") ?? ""
        let keep = existing.filter { !isOurs($0, mime: mime, regex: regex) }
        let full = NFCNDEFMessage(records: build(call.getArray("records") ?? []) + keep)
        var msg = full
        var compactUsed = false
        if capacity > 0 && full.length > capacity {
            let compact = NFCNDEFMessage(records: build(call.getArray("compact") ?? []) + keep)
            if compact.records.count > keep.count && compact.length <= capacity { msg = compact; compactUsed = true }
            else { finish("Not enough space on this tag", "TOO_BIG", nil); return }
        }
        tag.writeNDEF(msg) { error in
            if let error = error { finish(error.localizedDescription, "WRITE_FAILED", nil) }
            else { finish(nil, nil, ["written": true, "compact": compactUsed, "bytes": msg.length, "maxSize": capacity]) }
        }
    }

    private func build(_ arr: JSArray) -> [NFCNDEFPayload] {
        var out: [NFCNDEFPayload] = []
        for item in arr {
            guard let o = item as? JSObject else { continue }
            let type = o["type"] as? String ?? ""
            let data = o["data"] as? String ?? ""
            if type == "url", let p = NFCNDEFPayload.wellKnownTypeURIPayload(string: data) {
                out.append(p)
            } else if type == "mime", let mt = o["mediaType"] as? String {
                out.append(NFCNDEFPayload(format: .media, type: Data(mt.utf8), identifier: Data(), payload: Data(data.utf8)))
            } else if type == "text", let p = NFCNDEFPayload.wellKnownTypeTextPayload(string: data, locale: Locale(identifier: "en")) {
                out.append(p)
            }
        }
        return out
    }

    private func isOurs(_ r: NFCNDEFPayload, mime: String, regex: String) -> Bool {
        if r.typeNameFormat == .media, !mime.isEmpty,
           String(data: r.type, encoding: .ascii)?.lowercased() == mime.lowercased() { return true }
        if !regex.isEmpty, let u = r.wellKnownTypeURIPayload()?.absoluteString {
            return u.range(of: regex, options: [.regularExpression, .caseInsensitive]) != nil
        }
        return false
    }

    private func recordToJs(_ r: NFCNDEFPayload) -> [String: Any] {
        if let u = r.wellKnownTypeURIPayload() { return ["type": "url", "data": u.absoluteString] }
        if r.typeNameFormat == .absoluteURI, let s = String(data: r.payload, encoding: .utf8) { return ["type": "url", "data": s] }
        if r.typeNameFormat == .media {
            return ["type": "mime",
                    "mediaType": String(data: r.type, encoding: .ascii) ?? "",
                    "data": String(data: r.payload, encoding: .utf8) ?? ""]
        }
        let (text, _) = r.wellKnownTypeTextPayload()
        if let text = text { return ["type": "text", "data": text] }
        return ["type": "other"]
    }
}

// Registers the plugin when the web view is ready (Main.storyboard points here).
class RobiViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(RobiNfcPlugin())
        // Play Robi's sounds even with the ring/silent switch on, mixed with any music that's playing.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
    }
}
