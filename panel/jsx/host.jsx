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
        var p = null;

        if (vsIsAE()) {
            var i, sel = app.project.selection;
            for (i = 0; i < sel.length; i++) {
                if (sel[i] instanceof FootageItem && sel[i].file) { p = sel[i].file.fsName; break; }
            }
            if (!p && app.project.activeItem instanceof CompItem) {
                var layers = app.project.activeItem.selectedLayers;
                for (i = 0; i < layers.length; i++) {
                    var src = layers[i].source;
                    if (src instanceof FootageItem && src.file) { p = src.file.fsName; break; }
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
                            if (mp) { p = mp; break; }
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
        return vsOk({ path: p });
    } catch (e) {
        return vsErr(e.toString());
    }
}

// ---------------------------------------------------------------
// Files ko project mein import karo ("Voice Separator" bin/folder mein)
// ---------------------------------------------------------------
function importFiles(opts) {
    try {
        var files = opts.files;
        var binName = opts.bin || "Voice Separator";
        var i;

        if (vsIsAE()) {
            app.beginUndoGroup("Voice Separator import");
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
