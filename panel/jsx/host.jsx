// host.jsx - ExtendScript bridge (After Effects + Premiere Pro)
// Har function ek JSON string return karta hai: {ok:true,...} ya {ok:false,error:"..."}

function vsIsAE() {
    return BridgeTalk.appName === "aftereffects";
}

// ExtendScript mein JSON nahi hota, isliye chhota serializer
function vsQuote(s) {
    return '"' + String(s)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t") + '"';
}

function vsJSON(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "string") return vsQuote(v);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v instanceof Array) {
        var a = [];
        for (var i = 0; i < v.length; i++) a.push(vsJSON(v[i]));
        return "[" + a.join(",") + "]";
    }
    var parts = [];
    for (var k in v) {
        if (v.hasOwnProperty(k)) parts.push(vsQuote(k) + ":" + vsJSON(v[k]));
    }
    return "{" + parts.join(",") + "}";
}

function vsOk(extra) {
    var o = { ok: true };
    for (var k in extra) o[k] = extra[k];
    return vsJSON(o);
}

function vsErr(msg) {
    return vsJSON({ ok: false, error: String(msg) });
}

// ---------------------------------------------------------------
// Selected clip ka source file path
// ---------------------------------------------------------------
function getSelectedMedia() {
    try {
        var p = null, rs = null, re = null;   // rs/re = source file ke andar clip ka start/end (seconds)

        if (vsIsAE()) {
            var i, sel = app.project.selection;
            for (i = 0; i < sel.length; i++) {
                if (sel[i] instanceof FootageItem && sel[i].file) { p = sel[i].file.fsName; break; }
            }
            if (!p && app.project.activeItem instanceof CompItem) {
                var layers = app.project.activeItem.selectedLayers;
                for (i = 0; i < layers.length; i++) {
                    var lay = layers[i], src = lay.source;
                    if (src instanceof FootageItem && src.file) {
                        p = src.file.fsName;
                        try {
                            if (!lay.timeRemapEnabled && lay.stretch > 0) {
                                rs = (lay.inPoint - lay.startTime) * 100 / lay.stretch;
                                re = (lay.outPoint - lay.startTime) * 100 / lay.stretch;
                                if (rs < 0) rs = 0;
                                if (src.duration && re > src.duration) re = src.duration;
                                if (!(re > rs)) { rs = null; re = null; }
                            }
                        } catch (eR) { rs = null; re = null; }
                        break;
                    }
                }
            }
        } else {
            var j;
            // 1) timeline mein selected clip
            try {
                var seq = app.project.activeSequence;
                if (seq) {
                    var tsel = seq.getSelection();
                    for (j = 0; j < tsel.length; j++) {
                        if (tsel[j].projectItem) {
                            var mp = tsel[j].projectItem.getMediaPath();
                            if (mp) {
                                p = mp;
                                try {
                                    rs = tsel[j].inPoint.seconds; re = tsel[j].outPoint.seconds;
                                    if (!(re > rs)) { rs = null; re = null; }
                                } catch (eP) { rs = null; re = null; }
                                break;
                            }
                        }
                    }
                }
            } catch (e1) {}
            // 2) Project panel mein selected item
            if (!p) {
                try {
                    var items = app.getCurrentProjectViewSelection();
                    if (items) {
                        for (j = 0; j < items.length; j++) {
                            if (items[j].type === ProjectItemType.CLIP) {
                                var mp2 = items[j].getMediaPath();
                                if (mp2) { p = mp2; break; }
                            }
                        }
                    }
                } catch (e2) {}
            }
        }

        if (!p) return vsErr("Select a clip (timeline or project panel) first.");
        return vsOk({ path: p, rangeStart: rs, rangeEnd: re });
    } catch (e) {
        return vsErr(e.toString());
    }
}

// ---------------------------------------------------------------
// Files ko project mein import karo ("Voice Isolator" bin/folder mein)
// ---------------------------------------------------------------
function importFiles(opts) {
    try {
        var files = opts.files;
        var binName = opts.bin || "Voice Isolator";
        var i;

        if (vsIsAE()) {
            app.beginUndoGroup("Voice Isolator import");
            var folder = null;
            for (i = 1; i <= app.project.numItems; i++) {
                var it = app.project.item(i);
                if (it instanceof FolderItem && it.name === binName) { folder = it; break; }
            }
            if (!folder) folder = app.project.items.addFolder(binName);

            for (i = 0; i < files.length; i++) {
                var io = new ImportOptions(new File(files[i]));
                var item = app.project.importFile(io);
                item.parentFolder = folder;
            }
            app.endUndoGroup();
        } else {
            var root = app.project.rootItem;
            var bin = null;
            for (i = 0; i < root.children.numItems; i++) {
                var c = root.children[i];
                if (c.type === ProjectItemType.BIN && c.name === binName) { bin = c; break; }
            }
            if (!bin) bin = root.createBin(binName);
            // importFiles(paths, suppressUI, targetBin, importAsNumberedStills)
            var okImport = app.project.importFiles(files, true, bin, false);
            if (!okImport) return vsErr("Premiere could not import the files.");
        }
        return vsOk({ count: files.length });
    } catch (e) {
        try { if (vsIsAE()) app.endUndoGroup(); } catch (e2) {}
        return vsErr(e.toString());
    }
}

// ===============================================================
// importAndPlace: files import karo (naam ke saath) + timeline mein layers/clips daalo
//   opts = { items:[{path, kind:"voice"|"music"|"noise", name}], bin, src, timeline, muteOriginal, srcOffset }
//   srcOffset = source file ke kitne second se processing shuru hui (0 = poori file)
// Naam: voice = original file ka naam, "Music", "Noise". Noise muted add hoti hai.
// ===============================================================
function vsNormPath(p) {
    return String(p || "").replace(/\\/g, "/").toLowerCase();
}

function importAndPlace(opts) {
    try {
        var res = vsIsAE() ? vsAEImportAndPlace(opts) : vsPPROImportAndPlace(opts);
        return vsOk(res);
    } catch (e) {
        try { if (vsIsAE()) app.endUndoGroup(); } catch (e2) {}
        return vsErr(e.toString());
    }
}

// ---------------- After Effects ----------------
function vsAEImportAndPlace(opts) {
    var items = opts.items, i, folder = null, note = "", placed = 0;
    app.beginUndoGroup("Voice Isolator import");

    for (i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof FolderItem && it.name === (opts.bin || "Voice Isolator")) { folder = it; break; }
    }
    if (!folder) folder = app.project.items.addFolder(opts.bin || "Voice Isolator");

    var footage = [];
    for (i = 0; i < items.length; i++) {
        var item = app.project.importFile(new ImportOptions(new File(items[i].path)));
        item.parentFolder = folder;
        try { item.name = items[i].name; } catch (eN) {}
        footage.push(item);
    }

    if (opts.timeline) {
        var comp = (app.project.activeItem instanceof CompItem) ? app.project.activeItem : null;
        if (!comp) {
            var dur = 1;
            for (i = 0; i < footage.length; i++) if (footage[i].duration > dur) dur = footage[i].duration;
            comp = app.project.items.addComp(items[0].name, 1920, 1080, 1, dur, 30);
            comp.parentFolder = folder;
            try { comp.openInViewer(); } catch (eV) {}
            note = "New composition created.";
        }

        // Original clip ki layer dhoondo: pehle selected layers, phir poori comp
        var anchor = null, want = vsNormPath(opts.src), L;
        for (i = 0; i < comp.selectedLayers.length && !anchor; i++) {
            L = comp.selectedLayers[i];
            if (L.source instanceof FootageItem && L.source.file && vsNormPath(L.source.file.fsName) === want) anchor = L;
        }
        for (i = 1; i <= comp.numLayers && !anchor; i++) {
            L = comp.layer(i);
            if (L.source instanceof FootageItem && L.source.file && vsNormPath(L.source.file.fsName) === want) anchor = L;
        }

        // Ulta add karo taake voice sabse upar rahe
        for (i = items.length - 1; i >= 0; i--) {
            var lay = comp.layers.add(footage[i]);
            lay.name = items[i].name;
            if (anchor) {
                try {
                    lay.startTime = anchor.startTime + (opts.srcOffset || 0);
                    lay.inPoint = anchor.inPoint;
                    lay.outPoint = anchor.outPoint;
                } catch (eT) {}
            } else {
                lay.startTime = 0;
            }
            if (items[i].kind === "noise") { try { lay.audioEnabled = false; } catch (eM) {} }
            placed++;
        }
        if (anchor && opts.muteOriginal) { try { anchor.audioEnabled = false; } catch (eO) {} }
        if (!anchor) note += " Original clip was not found in this comp, so layers start at 0:00.";
    }

    app.endUndoGroup();
    return { count: items.length, placed: placed, note: note };
}

// ---------------- Premiere Pro ----------------
function vsPPROFindItem(bin, path) {
    var want = vsNormPath(path), found = null, i;
    for (i = 0; i < bin.children.numItems; i++) {
        var c = bin.children[i];
        try {
            if (c.type === ProjectItemType.CLIP && vsNormPath(c.getMediaPath()) === want) found = c;
        } catch (e) {}
    }
    return found;
}

function vsPPROTrackBusy(track, s, e) {
    for (var i = 0; i < track.clips.numItems; i++) {
        var c = track.clips[i];
        if (c.start.seconds < e && c.end.seconds > s) return true;
    }
    return false;
}

function vsPPROPickTracks(seq, n, s, e) {
    var picked = [], i, tr, pass;
    // pehle bilkul khali tracks, phir wo jahan is hisse mein kuch nahi
    for (pass = 0; pass < 2 && picked.length < n; pass++) {
        for (i = 0; i < seq.audioTracks.numTracks && picked.length < n; i++) {
            tr = seq.audioTracks[i];
            var already = false, k;
            for (k = 0; k < picked.length; k++) if (picked[k].index === i) already = true;
            if (already) continue;
            var ok = (pass === 0) ? (tr.clips.numItems === 0) : !vsPPROTrackBusy(tr, s, e);
            if (ok) picked.push({ index: i, empty: (tr.clips.numItems === 0) });
        }
    }
    return picked;
}

function vsPPROOverwrite(track, projItem, sec) {
    try { track.overwriteClip(projItem, sec); }
    catch (e1) { track.overwriteClip(projItem, String(sec)); }
}

function vsPPROImportAndPlace(opts) {
    var items = opts.items, i, root = app.project.rootItem, bin = null, note = "", placed = 0;
    var binName = opts.bin || "Voice Isolator";
    for (i = 0; i < root.children.numItems; i++) {
        var c = root.children[i];
        if (c.type === ProjectItemType.BIN && c.name === binName) { bin = c; break; }
    }
    if (!bin) bin = root.createBin(binName);

    var paths = [];
    for (i = 0; i < items.length; i++) paths.push(items[i].path);
    if (!app.project.importFiles(paths, true, bin, false)) throw new Error("Premiere could not import the files.");

    var proj = [];
    for (i = 0; i < items.length; i++) {
        var pi = vsPPROFindItem(bin, items[i].path);
        if (pi) { try { pi.name = items[i].name; } catch (eN) {} }
        proj.push(pi);
    }
    if (!opts.timeline) return { count: items.length, placed: 0, note: "" };

    var seq = app.project.activeSequence;
    if (!seq) return { count: items.length, placed: 0, note: "No active sequence - files were imported only." };

    // Original clip (selected) dhoondo
    var anchor = null, want = vsNormPath(opts.src), sel = [], j;
    try { sel = seq.getSelection(); } catch (eS) {}
    for (j = 0; j < sel.length && !anchor; j++) {
        try { if (sel[j].projectItem && vsNormPath(sel[j].projectItem.getMediaPath()) === want) anchor = sel[j]; } catch (eA) {}
    }
    var startSec, endSec, offsetSec;
    if (anchor) {
        startSec = anchor.start.seconds; endSec = anchor.end.seconds;
        offsetSec = startSec - anchor.inPoint.seconds + (opts.srcOffset || 0);   // process hue hisse ka 0:00 timeline par yahan aata hai
    } else {
        startSec = seq.getPlayerPosition().seconds; endSec = startSec + 1; offsetSec = startSec;
        note = "Original clip not selected in the timeline, so clips were placed at the playhead.";
    }
    var placeAt = offsetSec;
    if (placeAt < 0) { placeAt = startSec; note += " Clip start was trimmed, so audio may need a manual nudge."; }

    // Free audio tracks
    var tracks = vsPPROPickTracks(seq, items.length, startSec, endSec);
    if (tracks.length < items.length) {
        try {
            app.enableQE();
            var q = qe.project.getActiveSequence();
            q.addTracks(0, 0, items.length - tracks.length, seq.audioTracks.numTracks, 1);
            tracks = vsPPROPickTracks(seq, items.length, startSec, endSec);
        } catch (eQ) {}
    }

    for (i = 0; i < items.length; i++) {
        if (!proj[i] || !tracks[i]) continue;
        var tr = seq.audioTracks[tracks[i].index];
        vsPPROOverwrite(tr, proj[i], placeAt);
        // Naya clip dhoondo aur naam do, aakhir tak trim karo
        for (j = 0; j < tr.clips.numItems; j++) {
            var tc = tr.clips[j];
            try {
                if (Math.abs(tc.start.seconds - placeAt) < 0.05 && vsNormPath(tc.projectItem.getMediaPath()) === vsNormPath(items[i].path)) {
                    tc.name = items[i].name;
                    if (anchor) { try { tc.end = anchor.end; } catch (eE) {} }
                    break;
                }
            } catch (eC) {}
        }
        if (items[i].kind === "noise" && tracks[i].empty) { try { tr.setMute(1); } catch (eM) {} }
        placed++;
    }
    if (placed < items.length) note += " Not enough free audio tracks - add tracks and place the rest from the 'Voice Isolator' bin.";

    if (anchor && opts.muteOriginal) {
        for (j = 0; j < sel.length; j++) {
            try { if (sel[j].mediaType === "Audio") sel[j].disabled = true; } catch (eD) {}
        }
    }
    return { count: items.length, placed: placed, note: note };
}
