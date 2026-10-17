package __PACKAGE__;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.nfc.NdefMessage;
import android.nfc.NdefRecord;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.tech.Ndef;
import android.nfc.tech.NdefFormatable;
import android.os.Bundle;
import android.os.Parcelable;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Robi's NFC plugin for Android.
 * - Reads tags whenever the app is open (reader mode: no system pop-ups).
 * - Writes the robot's records to a tag, keeping anything else already stored on it.
 * - Hands over the tag that launched the app.
 */
@CapacitorPlugin(name = "RobiNfc")
public class RobiNfcPlugin extends Plugin implements NfcAdapter.ReaderCallback {

    private static final int READER_FLAGS =
            NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_NFC_B
            | NfcAdapter.FLAG_READER_NFC_F | NfcAdapter.FLAG_READER_NFC_V;

    private NfcAdapter adapter;
    private boolean scanning = false;
    private boolean readerOn = false;
    private PluginCall pendingWrite = null;
    private JSObject launchTag = null;

    @Override
    public void load() {
        adapter = NfcAdapter.getDefaultAdapter(getContext());
        Activity a = getActivity();
        if (a != null) launchTag = fromIntent(a.getIntent());
    }

    // ---------------- JS API ----------------

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", adapter != null);
        r.put("enabled", adapter != null && adapter.isEnabled());
        r.put("needsButton", false);
        call.resolve(r);
    }

    @PluginMethod
    public void startScan(PluginCall call) {
        if (adapter == null) { call.reject("NFC is not available on this phone", "NO_NFC"); return; }
        scanning = true;
        enableReader();
        call.resolve();
    }

    @PluginMethod
    public void stopScan(PluginCall call) {
        scanning = false;
        if (pendingWrite == null) disableReader();
        call.resolve();
    }

    @PluginMethod
    public void writeMerged(PluginCall call) {
        if (adapter == null) { call.reject("NFC is not available on this phone", "NO_NFC"); return; }
        if (pendingWrite != null) pendingWrite.reject("Replaced by a new write", "CANCELLED");
        pendingWrite = call;
        enableReader();
    }

    @PluginMethod
    public void cancelWrite(PluginCall call) {
        if (pendingWrite != null) { pendingWrite.reject("Cancelled", "CANCELLED"); pendingWrite = null; }
        if (!scanning) disableReader();
        call.resolve();
    }

    @PluginMethod
    public void getLaunchTag(PluginCall call) {
        JSObject r = launchTag != null ? launchTag : new JSObject();
        launchTag = null;   // hand it over once
        call.resolve(r);
    }

    // ---------------- lifecycle ----------------

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        readerOn = false;
        if (scanning || pendingWrite != null) enableReader();
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        disableReader();
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        JSObject t = fromIntent(intent);
        if (t != null) notifyListeners("tag", t, true);
    }

    private void enableReader() {
        final Activity a = getActivity();
        if (adapter == null || a == null) return;
        a.runOnUiThread(() -> {
            try {
                Bundle extras = new Bundle();
                extras.putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 250);
                adapter.enableReaderMode(a, this, READER_FLAGS, extras);
                readerOn = true;
            } catch (Exception ignored) { /* activity not resumed yet: handleOnResume will retry */ }
        });
    }

    private void disableReader() {
        final Activity a = getActivity();
        if (adapter == null || a == null || !readerOn) return;
        a.runOnUiThread(() -> {
            try { adapter.disableReaderMode(a); } catch (Exception ignored) { }
            readerOn = false;
        });
    }

    // ---------------- tags ----------------

    @Override
    public void onTagDiscovered(Tag tag) {
        Ndef ndef = Ndef.get(tag);
        NdefMessage existing = ndef != null ? ndef.getCachedNdefMessage() : null;
        if (pendingWrite != null) { doWrite(tag, existing); return; }
        JSObject ev = messageToJs(existing);
        ev.put("id", bytesToHex(tag.getId()));
        notifyListeners("tag", ev);
    }

    private void doWrite(Tag tag, NdefMessage existing) {
        PluginCall call = pendingWrite;
        pendingWrite = null;
        try {
            String mime = call.getString("mime", "");
            String regex = call.getString("ourUrlRegex", "");
            Pattern ours = regex.isEmpty() ? null : Pattern.compile(regex, Pattern.CASE_INSENSITIVE);

            List<NdefRecord> keep = new ArrayList<>();
            if (existing != null) {
                for (NdefRecord r : existing.getRecords()) if (!isOurs(r, mime, ours)) keep.add(r);
            }
            NdefMessage full = build(call.getArray("records"), keep);
            JSArray compactArr = call.getArray("compact");
            NdefMessage compact = compactArr != null ? build(compactArr, keep) : null;

            Ndef ndef = Ndef.get(tag);
            if (ndef != null) {
                ndef.connect();
                try {
                    if (!ndef.isWritable()) { call.reject("This tag is locked (read-only)", "READ_ONLY"); return; }
                    int max = ndef.getMaxSize();
                    NdefMessage msg = full;
                    if (full.getByteArrayLength() > max) {
                        if (compact != null && compact.getByteArrayLength() <= max) msg = compact;
                        else { call.reject("Not enough space on this tag", "TOO_BIG"); return; }
                    }
                    ndef.writeNdefMessage(msg);
                    call.resolve(writeResult(msg, max, msg == compact));
                } finally {
                    try { ndef.close(); } catch (Exception ignored) { }
                }
            } else {
                NdefFormatable f = NdefFormatable.get(tag);
                if (f == null) { call.reject("This tag can't store NFC data", "UNSUPPORTED"); return; }
                f.connect();
                try {
                    f.format(full);
                    call.resolve(writeResult(full, -1, false));
                } finally {
                    try { f.close(); } catch (Exception ignored) { }
                }
            }
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "Couldn't write the tag", "WRITE_FAILED");
        } finally {
            if (!scanning) disableReader();
        }
    }

    private JSObject writeResult(NdefMessage msg, int max, boolean compact) {
        JSObject r = new JSObject();
        r.put("written", true);
        r.put("compact", compact);
        r.put("bytes", msg.getByteArrayLength());
        r.put("maxSize", max);
        return r;
    }

    private NdefMessage build(JSArray arr, List<NdefRecord> keep) throws Exception {
        List<NdefRecord> out = new ArrayList<>();
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                String type = o.optString("type");
                String data = o.optString("data");
                if ("url".equals(type)) out.add(NdefRecord.createUri(data));
                else if ("mime".equals(type)) out.add(NdefRecord.createMime(o.optString("mediaType"), data.getBytes(StandardCharsets.UTF_8)));
                else if ("text".equals(type)) out.add(NdefRecord.createTextRecord("en", data));
            }
        }
        out.addAll(keep);
        return new NdefMessage(out.toArray(new NdefRecord[0]));
    }

    private boolean isOurs(NdefRecord r, String mime, Pattern ours) {
        short tnf = r.getTnf();
        if (tnf == NdefRecord.TNF_MIME_MEDIA && !mime.isEmpty()
                && mime.equalsIgnoreCase(new String(r.getType(), StandardCharsets.US_ASCII))) return true;
        if (ours != null && isUri(r)) {
            Uri u = r.toUri();
            return u != null && ours.matcher(u.toString()).find();
        }
        return false;
    }

    private boolean isUri(NdefRecord r) {
        short tnf = r.getTnf();
        return tnf == NdefRecord.TNF_ABSOLUTE_URI
                || (tnf == NdefRecord.TNF_WELL_KNOWN && Arrays.equals(r.getType(), NdefRecord.RTD_URI));
    }

    private JSObject messageToJs(NdefMessage msg) {
        JSArray recs = new JSArray();
        if (msg != null) for (NdefRecord r : msg.getRecords()) recs.put(recordToJs(r));
        JSObject o = new JSObject();
        o.put("records", recs);
        return o;
    }

    private JSObject recordToJs(NdefRecord r) {
        JSObject o = new JSObject();
        short tnf = r.getTnf();
        if (isUri(r)) {
            Uri u = r.toUri();
            o.put("type", "url");
            o.put("data", u != null ? u.toString() : "");
        } else if (tnf == NdefRecord.TNF_WELL_KNOWN && Arrays.equals(r.getType(), NdefRecord.RTD_TEXT)) {
            byte[] p = r.getPayload();
            String s = "";
            if (p.length > 0) {
                int langLen = p[0] & 0x3F;
                boolean utf16 = (p[0] & 0x80) != 0;
                int start = 1 + langLen;
                if (start <= p.length) s = new String(p, start, p.length - start, utf16 ? StandardCharsets.UTF_16 : StandardCharsets.UTF_8);
            }
            o.put("type", "text");
            o.put("data", s);
        } else if (tnf == NdefRecord.TNF_MIME_MEDIA) {
            o.put("type", "mime");
            o.put("mediaType", new String(r.getType(), StandardCharsets.US_ASCII));
            o.put("data", new String(r.getPayload(), StandardCharsets.UTF_8));
        } else {
            o.put("type", "other");
        }
        return o;
    }

    private JSObject fromIntent(Intent i) {
        if (i == null || !NfcAdapter.ACTION_NDEF_DISCOVERED.equals(i.getAction())) return null;
        Parcelable[] raw = i.getParcelableArrayExtra(NfcAdapter.EXTRA_NDEF_MESSAGES);
        if (raw == null || raw.length == 0) return null;
        return messageToJs((NdefMessage) raw[0]);
    }

    private static String bytesToHex(byte[] b) {
        if (b == null) return "";
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }
}
