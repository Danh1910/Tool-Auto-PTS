#target photoshop
/*
export_psd_configurable_fixed.jsx (with logging)
- Đọc config JSON (qua $.arguments[0] hoặc mặc định)
- Hỗ trợ: group_choice, text_replace, visibility, smart_edit_contents
- Fallback thông minh vào Smart Object khi không tìm thấy group/layer ở doc chính
- GHI LOG đầy đủ ra file (resultPath đổi đuôi -> _debug.log) hoặc $.arguments[2]
*/

(function () {
    app.displayDialogs = DialogModes.NO;

    ////////////////////////////
    // Utility & Polyfill
    ////////////////////////////
    function safeParseJSON(s) {
        if (typeof JSON !== "undefined" && typeof JSON.parse === "function") return JSON.parse(s);
        if (s && s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
        return eval('(' + s + ')');
    }

    if (typeof String.prototype.trim !== "function")
        String.prototype.trim = function () { return this.replace(/^\s+|\s+$/g, ""); };

    function toParts(path) {        // "A>B>C" -> ["A","B","C"]
        if (!path) return [];
        var s = String(path);
        if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
        var arr = s.split(">");
        for (var i = 0; i < arr.length; i++)
            arr[i] = arr[i].replace(/^\s+|\s+$/g, "");
        return arr;
    }

    function readFile(path) {
        var f = new File(path);
        if (!f.exists) throw new Error("File not found: " + path);
        f.encoding = "UTF8";
        f.open("r");
        var c = f.read();
        f.close();
        return c;
    }

    function safeStringify(obj) {
        if (typeof JSON !== "undefined" && typeof JSON.stringify === "function") {
            return JSON.stringify(obj);
        }
        // Fallback rất đơn giản cho ExtendScript
        function esc(s) { return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
        function ser(v) {
            var t = typeof v;
            if (v === null) return "null";
            if (t === "number" || t === "boolean") return String(v);
            if (t === "string") return "\"" + esc(v) + "\"";
            if (v instanceof Array) {
                var arr = [];
                for (var i = 0; i < v.length; i++) arr.push(ser(v[i]));
                return "[" + arr.join(",") + "]";
            }
            var ks = [];
            for (var k in v) if (v.hasOwnProperty(k)) ks.push("\"" + esc(k) + "\":" + ser(v[k]));
            return "{" + ks.join(",") + "}";
        }
        return ser(obj);
    }

    ////////////////////////////
    // LOGGING
    ////////////////////////////
    var configDefault = Folder.myDocuments.fsName + "/psd_config.json";
    var configPath = configDefault;
    if (typeof $.arguments !== "undefined" && $.arguments.length > 0 && $.arguments[0])
        configPath = $.arguments[0];

    var resultDefault = Folder.myDocuments.fsName + "/psd_result.json";
    var resultPath = resultDefault;
    if (typeof $.arguments !== "undefined" && $.arguments.length > 1 && $.arguments[1])
        resultPath = $.arguments[1];

    // logPath: ưu tiên $.arguments[2], nếu không thì dựa trên resultPath
    var __logPath = (function(){
        try {
            if (typeof $.arguments !== "undefined" && $.arguments.length > 2 && $.arguments[2]) {
                return $.arguments[2];
            }
            var rp = resultPath || (Folder.myDocuments.fsName + "/psd_result.json");
            return String(rp).replace(/\.json$/i, "_debug.log");
        } catch (e) {
            return Folder.myDocuments.fsName + "/psd_debug.log";
        }
    })();

    function __appendLine(fp, s) {
        try {
            var f = new File(fp);
            f.encoding = "UTF8";
            if (!f.open("a")) { f.open("w"); }
            f.writeln(new Date().toISOString() + " | " + s);
            f.close();
        } catch(e) {}
    }
    function __log(s){ __appendLine(__logPath, s); }

    __log("=== START ===");
    __log("configPath=" + configPath);
    __log("resultPath=" + resultPath);
    __log("logPath=" + __logPath);

    ////////////////////////////
    // REPORT ACCUMULATOR
    ////////////////////////////
    var __report = {
        missingGroupPaths: [],
        missingPaths: [],
        missingTextTargets: [],
        missingShowLayers: [],
        configErrors: [],
        actionParamErrors: [],
        notes: []
    };

    function __push_unique(arr, val) { for (var i=0;i<arr.length;i++) if (arr[i]==val) return; arr.push(val); }

    function __writeReportJSON(fp) {
        try {
            __log("Writing report -> " + fp);
            var f = new File(fp);
            f.encoding = "UTF8";
            f.open("w");
            f.write(safeStringify(__report));
            f.close();
        } catch (e) {
            __log("Write report error: " + e);
        }
    }

    function __pushParamError(actIdx, actType, message, detailObj) {
        var o = { index: actIdx, type: actType, message: String(message) };
        if (detailObj) { for (var k in detailObj) o[k] = detailObj[k]; }
        __report.actionParamErrors.push(o);
    }

    ////////////////////////////
    // Layer Traversal
    ////////////////////////////
    function getLayerSetByPath(doc, parts) {
        var cur = doc;
        for (var i = 0; i < parts.length; i++) {
            var name = parts[i], found = null;
            for (var j = 0; j < cur.layerSets.length; j++) {
                if (cur.layerSets[j].name === name) { found = cur.layerSets[j]; break; }
            }
            if (!found) return null;
            cur = found;
        }
        return cur;
    }

    function getLayerByPath(doc, parts) {
        var cur = doc;
        for (var i = 0; i < parts.length; i++) {
            var name = parts[i], found = null;
            for (var j = 0; j < cur.artLayers.length; j++) {
                if (cur.artLayers[j].name === name) { found = cur.artLayers[j]; break; }
            }
            if (found) { cur = found; continue; }
            for (var k = 0; k < cur.layerSets.length; k++) {
                if (cur.layerSets[k].name === name) { found = cur.layerSets[k]; break; }
            }
            if (!found) return null;
            cur = found;
        }
        return cur;
    }

    function findArtLayerByName(container, name, recursive) {
        for (var i = 0; i < container.artLayers.length; i++)
            if (container.artLayers[i].name === name) return container.artLayers[i];
        if (recursive)
            for (var j = 0; j < container.layerSets.length; j++) {
                var r = arguments.callee(container.layerSets[j], name, true);
                if (r) return r;
            }
        return null;
    }

    function setAllLayersVisibility(container, visible) {
        for (var i = 0; i < container.artLayers.length; i++)
            container.artLayers[i].visible = visible;
        for (var j = 0; j < container.layerSets.length; j++) {
            container.layerSets[j].visible = visible;
            setAllLayersVisibility(container.layerSets[j], visible);
        }
    }

    function setArtLayerVisibleInGroup(group, name) {
        for (var i = 0; i < group.artLayers.length; i++) {
            if (group.artLayers[i].name === name) {
                group.artLayers[i].visible = true;
                return true;
            }
        }
        return false;
    }

    function findContainerOrLayer(doc, parts) {
        var ls = getLayerSetByPath(doc, parts);
        if (ls) return { type: "layerSet", obj: ls };
        var al = findArtLayerByName(doc, parts[parts.length - 1], true);
        if (al) return { type: "artLayer", obj: al };
        return null;
    }

    ////////////////////////////
    // Smart Object Helpers (cũ)
    ////////////////////////////
    function editSmartObjectContents() {
        var id = stringIDToTypeID("placedLayerEditContents");
        executeAction(id, new ActionDescriptor(), DialogModes.ALL);
    }

    function runActionsOnCurrentDoc(innerActions) {
        var doc = app.activeDocument;
        __log("runActionsOnCurrentDoc: innerActions=" + innerActions.length);
        for (var i = 0; i < innerActions.length; i++) {
            var act = innerActions[i];
            if (!act || !act.type) continue;
            var t = act.type;
            __log("[inner] Action[" + i + "] type=" + t + (act.groupPath?(" | groupPath="+act.groupPath):"") + (typeof act.showLayer!=="undefined"?(" | showLayer="+act.showLayer):"") + (act.layerName?(" | layerName="+act.layerName):""));

            if (t === "group_choice") {
                var gp = toParts(act.groupPath || "");
                var group = getLayerSetByPath(doc, gp);
                __log("[inner] group_choice: group " + (group ? "FOUND" : "NOT FOUND"));
                if (!group) continue;
                setAllLayersVisibility(group, false);
                var ok = setArtLayerVisibleInGroup(group, act.showLayer);
                if (!ok) {
                    var f = findArtLayerByName(group, act.showLayer, true);
                    __log("[inner] group_choice: showLayer " + (f ? "FOUND (recursive)" : "NOT FOUND"));
                    if (f) f.visible = true;
                }
            }
            else if (t === "text_replace") {
                if (!act.layerName || typeof act.text === "undefined") { __log("[inner] text_replace: missing params"); continue; }
                var target = doc;
                if (act.groupPath) {
                    var gp2 = toParts(act.groupPath);
                    var g2 = getLayerSetByPath(doc, gp2);
                    __log("[inner] text_replace: group " + (g2 ? "FOUND" : "NOT FOUND"));
                    if (g2) target = g2;
                }
                var tl = findArtLayerByName(target, act.layerName, true);
                __log("[inner] text_replace: layer " + (tl ? "FOUND" : "NOT FOUND"));
                if (tl && typeof tl.textItem !== "undefined")
                    tl.textItem.contents = String(act.text);
            }
            else if (t === "visibility") {
                if (!act.path || typeof act.visible === "undefined") { __log("[inner] visibility: missing params"); continue; }
                var p = toParts(act.path);
                var obj = findContainerOrLayer(doc, p);
                __log("[inner] visibility: target " + (obj && obj.obj ? "FOUND" : "NOT FOUND"));
                if (obj && obj.obj) obj.obj.visible = !!act.visible;
            }
        }
    }

    ////////////////////////////
    // Smart Object Helpers (mới - fallback tự động)
    ////////////////////////////
    function isSmartObjectLayer(layer) {
        try { return layer.kind === LayerKind.SMARTOBJECT; } catch (e) {}
        return false;
    }

    function findSmartLayerByName(container, name) {
        for (var i = 0; i < container.artLayers.length; i++) {
            var L = container.artLayers[i];
            if (L.name === name && isSmartObjectLayer(L)) return L;
        }
        for (var j = 0; j < container.layerSets.length; j++) {
            var r = findSmartLayerByName(container.layerSets[j], name);
            if (r) return r;
        }
        return null;
    }

    function remapPathAfterSmart(parts, smartName) {
        var idx = -1;
        for (var i = 0; i < parts.length; i++) { if (parts[i] === smartName) { idx = i; break; } }
        if (idx < 0) return null;
        var remain = parts.slice(idx + 1);
        return remain.join(">");
    }

    function openSmartObjectAndRun(soLayer, innerActions) {
        __log("SO: opening contents for layer=" + soLayer.name);
        app.activeDocument.activeLayer = soLayer;
        editSmartObjectContents();
        var innerDoc = app.activeDocument;
        __log("SO: innerDoc opened -> " + innerDoc.name + " | run " + innerActions.length + " action(s)");
        var ok = true;
        try {
            runActionsOnCurrentDoc(innerActions);
            try { innerDoc.save(); __log("SO: innerDoc saved"); } catch (e) { __log("SO: save error: " + e); }
            try { innerDoc.close(SaveOptions.SAVECHANGES); __log("SO: innerDoc closed (SAVECHANGES)"); } catch (e2) { __log("SO: close error: " + e2); }
        } catch (e3) {
            ok = false;
            __log("SO: runActions error: " + e3);
            try { innerDoc.close(SaveOptions.DONOTSAVECHANGES); __log("SO: innerDoc closed (DONOTSAVECHANGES)"); } catch (ee) {}
        }
        return ok;
    }

    function tryActionViaSmartFallback(doc, act) {
        if (!act.groupPath) return false;
        var parts = toParts(act.groupPath);
        __log("SO-FALLBACK: checking segments for groupPath='" + act.groupPath + "'");

        for (var i = 0; i < parts.length; i++) {
            var seg = parts[i];
            var soLayer = findSmartLayerByName(doc, seg);
            __log("SO-FALLBACK: segment '" + seg + "' -> " + (soLayer ? "SmartObject FOUND" : "not found"));
            if (!soLayer) continue;

            var remapped = remapPathAfterSmart(parts, seg);
            if (remapped === null) { __log("SO-FALLBACK: remap failed (null)"); continue; }

            var cloned = {};
            for (var k in act) if (act.hasOwnProperty(k)) cloned[k] = act[k];
            cloned.groupPath = remapped;
            __log("SO-FALLBACK: open SO='" + seg + "' and run cloned action with remapped groupPath='" + remapped + "'");

            var ok = openSmartObjectAndRun(soLayer, [cloned]);
            __log("SO-FALLBACK: handler returned " + ok);
            if (ok) return true;
        }
        __log("SO-FALLBACK: no suitable SmartObject found / all attempts failed");
        return false;
    }

    ////////////////////////////
    // Main Execution
    ////////////////////////////
    if (!new File(configPath).exists) {
        __log("Config JSON not found at " + configPath);
        alert("Config JSON not found: " + configPath);
        return;
    }

    var doc = null;
    try {
        var cfgTxt = readFile(configPath);
        __log("Config read OK (" + cfgTxt.length + " bytes)");
        var cfg = safeParseJSON(cfgTxt);

        if (!cfg.psdFilePath) {
            __log("CONFIG ERROR: psdFilePath missing");
            __report.configErrors.push({ code: "psdFilePathMissing", message: "psdFilePath missing in config" });
            __writeReportJSON(resultPath);
            __log("=== END (config error) ===");
            return;
        }

        var psdFile = new File(cfg.psdFilePath);
        if (!psdFile.exists) {
            __log("CONFIG ERROR: PSD not found at " + cfg.psdFilePath);
            __report.configErrors.push({ code: "psdFileNotFound", message: "PSD file not found", path: String(cfg.psdFilePath) });
            __writeReportJSON(resultPath);
            __log("=== END (config error) ===");
            return;
        }

        var outFolder = new Folder(cfg.outputFolder || (Folder.myDocuments.fsName + "/psd_export"));
        if (!outFolder.exists) { outFolder.create(); __log("Created outputFolder: " + outFolder.fsName); }

        var outName = cfg.outputFilename || psdFile.name.replace(/\.[^\.]+$/, "") + "_export.jpg";
        var jpgQ = (typeof cfg.jpgQuality === "number") ? Math.max(0, Math.min(12, Math.round(cfg.jpgQuality))) : 12;

        __log("Opening PSD: " + psdFile.fsName);
        doc = app.open(psdFile);
        __log("Opened PSD: " + doc.name);

        var acts = cfg.actions || [];
        __log("Actions count=" + acts.length);

        for (var ai = 0; ai < acts.length; ai++) {
            var act = acts[ai];
            if (!act || !act.type) { __log("Action[" + ai + "]: invalid/empty"); continue; }
            var t = act.type;

            __log("Action[" + ai + "] type=" + t +
                  (act.groupPath ? (" | groupPath=" + act.groupPath) : "") +
                  (typeof act.showLayer !== "undefined" ? (" | showLayer=" + act.showLayer) : "") +
                  (act.layerName ? (" | layerName=" + act.layerName) : ""));

            if (t === "group_choice") {
                var gp = toParts(act.groupPath || "");
                var group = getLayerSetByPath(doc, gp);
                __log("group_choice: main doc group " + (group ? "FOUND" : "NOT FOUND"));
                if (!group) {
                    var okSmart = tryActionViaSmartFallback(doc, act);
                    if (!okSmart) {
                        __log("group_choice: record missingGroupPaths -> " + (act.groupPath||""));
                        if (act.groupPath) __push_unique(__report.missingGroupPaths, String(act.groupPath));
                    }
                    continue;
                }
                setAllLayersVisibility(group, false);
                var ok = setArtLayerVisibleInGroup(group, act.showLayer);
                __log("group_choice: setArtLayerVisibleInGroup('" + act.showLayer + "') -> " + ok);
                if (!ok) {
                    var fnd = findArtLayerByName(group, act.showLayer, true);
                    __log("group_choice: recursive find showLayer -> " + (fnd ? "FOUND" : "NOT FOUND"));
                    if (fnd) {
                        fnd.visible = true;
                    } else {
                        var okSmart2 = tryActionViaSmartFallback(doc, act);
                        if (!okSmart2) {
                            __log("group_choice: record missingShowLayers -> " + (act.groupPath||"") + " / " + act.showLayer);
                            __report.missingShowLayers.push({ groupPath: act.groupPath || "", showLayer: String(act.showLayer) });
                        }
                    }
                }
            }
            else if (t === "text_replace") {
                if (!act.layerName || typeof act.text === "undefined") {
                    __log("text_replace: missing layerName or text");
                    __pushParamError(ai, t, "Missing layerName or text", { groupPath: act.groupPath || "" });
                    continue;
                }
                var target = doc;
                if (act.groupPath) {
                    var gp2 = toParts(act.groupPath);
                    var g2 = getLayerSetByPath(doc, gp2);
                    __log("text_replace: main doc group " + (g2 ? "FOUND" : "NOT FOUND"));
                    if (g2) {
                        target = g2;
                    } else {
                        var okSmartA = tryActionViaSmartFallback(doc, act);
                        if (!okSmartA) {
                            __log("text_replace: record missingGroupPaths -> " + (act.groupPath||""));
                            __push_unique(__report.missingGroupPaths, String(act.groupPath));
                        }
                        continue;
                    }
                }
                var tl = findArtLayerByName(target, act.layerName, true);
                __log("text_replace: layer " + (tl ? "FOUND" : "NOT FOUND"));
                if (tl && typeof tl.textItem !== "undefined") {
                    __log("text_replace: set text='" + act.text + "'");
                    tl.textItem.contents = String(act.text);
                } else {
                    var okSmartB = tryActionViaSmartFallback(doc, act);
                    if (!okSmartB) {
                        __log("text_replace: record missingTextTargets -> " + (act.groupPath||"") + " / " + act.layerName);
                        __report.missingTextTargets.push({ groupPath: act.groupPath || "", layerName: String(act.layerName) });
                    }
                }
            }
            else if (t === "visibility") {
                if (!act.path || typeof act.visible === "undefined") {
                    __log("visibility: missing path or visible");
                    __pushParamError(ai, t, "Missing path or visible", null);
                    continue;
                }
                var p = toParts(act.path);
                var obj = findContainerOrLayer(doc, p);
                __log("visibility: target " + (obj && obj.obj ? "FOUND" : "NOT FOUND"));
                if (obj && obj.obj) {
                    obj.obj.visible = !!act.visible;
                } else {
                    var okSmartV = tryActionViaSmartFallback(doc, { type: "visibility", groupPath: act.path, path: act.path, visible: act.visible });
                    if (!okSmartV) {
                        __log("visibility: record missingPaths -> " + act.path);
                        __push_unique(__report.missingPaths, String(act.path));
                    }
                }
            }
            else if (t === "smart_edit_contents") {
                var path = act.smartLayerPath || act.smartLayerName;
                if (!path || !act.inner || !(act.inner instanceof Array)) {
                    __log("smart_edit_contents: missing smartLayerPath/smartLayerName or inner[]");
                    __pushParamError(ai, t, "Missing smartLayerPath/smartLayerName or inner[]", null);
                    continue;
                }
                var soLayer = getLayerByPath(doc, toParts(path));
                __log("smart_edit_contents: SO " + (soLayer ? "FOUND" : "NOT FOUND") + " at path=" + path);
                if (!soLayer) { continue; }
                app.activeDocument.activeLayer = soLayer;

                __log("smart_edit_contents: opening SO contents...");
                editSmartObjectContents();
                var innerDoc = app.activeDocument;
                __log("smart_edit_contents: inner opened -> " + innerDoc.name + " | run inner actions=" + act.inner.length);
                runActionsOnCurrentDoc(act.inner);
                try { innerDoc.save(); __log("smart_edit_contents: inner saved"); } catch(e){ __log("smart_edit_contents: save err=" + e); }
                try { innerDoc.close(SaveOptions.SAVECHANGES); __log("smart_edit_contents: inner closed"); } catch(e){ __log("smart_edit_contents: close err=" + e); }
            }
            else {
                __log("Action[" + ai + "]: UNKNOWN type -> " + t);
            }
        }

        // Export JPG
        var jpgOpt = new JPEGSaveOptions();
        jpgOpt.quality = jpgQ;
        jpgOpt.embedColorProfile = true;
        jpgOpt.formatOptions = FormatOptions.STANDARDBASELINE;
        jpgOpt.matte = MatteType.NONE;

        var outFile = new File(outFolder.fsName + "/" + outName);
        __log("Exporting JPG -> " + outFile.fsName + " | quality=" + jpgQ);
        doc.saveAs(outFile, jpgOpt, true, Extension.LOWERCASE);
        __log("Export OK");

    } catch (err) {
        __log("TOP-LEVEL ERROR: " + err);
    } finally {
        try { __writeReportJSON(resultPath); } catch (e) { __log("Write report finally error: " + e); }
        try { if (doc) { doc.close(SaveOptions.DONOTSAVECHANGES); __log("Closed main doc (DONOTSAVECHANGES)"); } } catch(e){}
        __log("=== END ===");
    }

})();
