#target photoshop
/*
export_psd_configurable_fixed.jsx
- Đọc config JSON (qua $.arguments[0] hoặc mặc định)
- Hỗ trợ: group_choice, text_replace, visibility, smart_edit_contents
- Bổ sung: fallback thông minh vào Smart Object khi không tìm thấy group/layer ở doc chính
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
            // object
            var ks = [];
            for (var k in v) if (v.hasOwnProperty(k)) ks.push("\"" + esc(k) + "\":" + ser(v[k]));
            return "{" + ks.join(",") + "}";
        }
        return ser(obj);
    }

    // ====== REPORT ACCUMULATOR ======
    var __report = {
        missingGroupPaths: [],    // groupPath không tìm thấy group
        missingPaths: [],         // path không tìm thấy (visibility)
        missingTextTargets: [],   // text_replace: không tìm thấy layer text
        missingShowLayers: [],    // group_choice: group có nhưng không tìm ra showLayer
        configErrors: [],         // lỗi cấp config (psdFilePath...)
        actionParamErrors: [],    // lỗi thiếu tham số trong từng action
        notes: []
    };

    function __push_unique(arr, val) {
        for (var i = 0; i < arr.length; i++) if (arr[i] == val) return;
        arr.push(val);
    }

    function __writeReportJSON(fp) {
        try {
            var f = new File(fp);
            f.encoding = "UTF8";
            f.open("w");
            f.write(safeStringify(__report));
            f.close();
        } catch (e) {
            // im lặng
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
                var r = arguments.callee(container.layerSets[j], name, true); // dùng đệ quy
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
        for (var i = 0; i < innerActions.length; i++) {
            var act = innerActions[i];
            if (!act || !act.type) continue;
            var t = act.type;

            if (t === "group_choice") {
                var gp = toParts(act.groupPath || "");
                var group = getLayerSetByPath(doc, gp);
                if (!group) continue;
                setAllLayersVisibility(group, false);
                var ok = setArtLayerVisibleInGroup(group, act.showLayer);
                if (!ok) {
                    var f = findArtLayerByName(group, act.showLayer, true);
                    if (f) f.visible = true;
                }
            }
            else if (t === "text_replace") {
                if (!act.layerName || typeof act.text === "undefined") continue;
                var target = doc;
                if (act.groupPath) {
                    var gp2 = toParts(act.groupPath);
                    var g2 = getLayerSetByPath(doc, gp2);
                    if (g2) target = g2;
                }
                var tl = findArtLayerByName(target, act.layerName, true);
                if (tl && typeof tl.textItem !== "undefined")
                    tl.textItem.contents = String(act.text);
            }
            else if (t === "visibility") {
                if (!act.path || typeof act.visible === "undefined") continue;
                var p = toParts(act.path);
                var obj = findContainerOrLayer(doc, p);
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
        // Tìm ArtLayer là Smart Object
        for (var i = 0; i < container.artLayers.length; i++) {
            var L = container.artLayers[i];
            if (L.name === name && isSmartObjectLayer(L)) return L;
        }
        // Dò sâu trong group
        for (var j = 0; j < container.layerSets.length; j++) {
            var r = findSmartLayerByName(container.layerSets[j], name);
            if (r) return r;
        }
        return null;
    }

    function remapPathAfterSmart(parts, smartName) {
        var idx = -1;
        for (var i = 0; i < parts.length; i++) {
            if (parts[i] === smartName) { idx = i; break; }
        }
        if (idx < 0) return null;
        var remain = parts.slice(idx + 1);
        return remain.join(">");
    }

    function openSmartObjectAndRun(soLayer, innerActions) {
        app.activeDocument.activeLayer = soLayer;
        editSmartObjectContents();                // mở .psb
        var innerDoc = app.activeDocument;
        var ok = true;
        try {
            runActionsOnCurrentDoc(innerActions); // chạy lại y hệt logic trên .psb
            try { innerDoc.save(); } catch (e) {}
            try { innerDoc.close(SaveOptions.SAVECHANGES); } catch (e) {}
        } catch (e2) {
            ok = false;
            try { innerDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (ee) {}
        }
        return ok;
    }

    // Thử fallback 1 action qua Smart Object (trả true nếu thành công)
    function tryActionViaSmartFallback(doc, act) {
        if (!act.groupPath) return false;
        var parts = toParts(act.groupPath);

        // Thử từng segment như là tên Smart Object
        for (var i = 0; i < parts.length; i++) {
            var seg = parts[i];
            var soLayer = findSmartLayerByName(doc, seg);
            if (!soLayer) continue;

            var remapped = remapPathAfterSmart(parts, seg);
            if (remapped === null) continue;

            // Clone action và thay groupPath = phần còn lại bên trong SO
            var cloned = {};
            for (var k in act) if (act.hasOwnProperty(k)) cloned[k] = act[k];
            cloned.groupPath = remapped;

            var ok = openSmartObjectAndRun(soLayer, [cloned]);
            if (ok) return true;
        }
        return false;
    }

    ////////////////////////////
    // Main Execution
    ////////////////////////////
    var configDefault = Folder.myDocuments.fsName + "/psd_config.json";
    var configPath = configDefault;
    if (typeof $.arguments !== "undefined" && $.arguments.length > 0 && $.arguments[0])
        configPath = $.arguments[0];

    var resultDefault = Folder.myDocuments.fsName + "/psd_result.json";
    var resultPath = resultDefault;
    if (typeof $.arguments !== "undefined" && $.arguments.length > 1 && $.arguments[1])
        resultPath = $.arguments[1];

    if (!new File(configPath).exists) {
        alert("Config JSON not found: " + configPath);
        return;
    }

    var doc = null;
    try {
        var cfg = safeParseJSON(readFile(configPath));
        if (!cfg.psdFilePath) {
            __report.configErrors.push({
                code: "psdFilePathMissing",
                message: "psdFilePath missing in config"
            });
            __writeReportJSON(resultPath);
            return; // dừng sớm
        }

        var psdFile = new File(cfg.psdFilePath);
        if (!psdFile.exists) {
            __report.configErrors.push({
                code: "psdFileNotFound",
                message: "PSD file not found",
                path: String(cfg.psdFilePath)
            });
            __writeReportJSON(resultPath);
            return; // dừng sớm
        }

        var outFolder = new Folder(cfg.outputFolder || (Folder.myDocuments.fsName + "/psd_export"));
        if (!outFolder.exists) outFolder.create();

        var outName = cfg.outputFilename || psdFile.name.replace(/\.[^\.]+$/, "") + "_export.jpg";
        var jpgQ = (typeof cfg.jpgQuality === "number") ? Math.max(0, Math.min(12, Math.round(cfg.jpgQuality))) : 12;

        doc = app.open(psdFile);
        var acts = cfg.actions || [];

        for (var ai = 0; ai < acts.length; ai++) {
            var act = acts[ai];
            if (!act || !act.type) continue;
            var t = act.type;

            if (t === "group_choice") {
                var gp = toParts(act.groupPath || "");
                var group = getLayerSetByPath(doc, gp);
                if (!group) {
                    // Fallback qua Smart Object
                    var okSmart = tryActionViaSmartFallback(doc, act);
                    if (!okSmart) {
                        if (act.groupPath) __push_unique(__report.missingGroupPaths, String(act.groupPath));
                    }
                    continue;
                }
                setAllLayersVisibility(group, false);
                var ok = setArtLayerVisibleInGroup(group, act.showLayer);
                if (!ok) {
                    var fnd = findArtLayerByName(group, act.showLayer, true);
                    if (fnd) {
                        fnd.visible = true;
                    } else {
                        // Fallback khi showLayer không có trong group
                        var okSmart2 = tryActionViaSmartFallback(doc, act);
                        if (!okSmart2) {
                            __report.missingShowLayers.push({
                                groupPath: act.groupPath || "",
                                showLayer: String(act.showLayer)
                            });
                        }
                    }
                }
            }
            else if (t === "text_replace") {
                if (!act.layerName || typeof act.text === "undefined") {
                    __pushParamError(ai, t, "Missing layerName or text", { groupPath: act.groupPath || "" });
                    continue;
                }
                var target = doc;
                if (act.groupPath) {
                    var gp2 = toParts(act.groupPath);
                    var g2 = getLayerSetByPath(doc, gp2);
                    if (g2) {
                        target = g2;
                    } else {
                        // Fallback qua Smart Object khi group không có
                        var okSmartA = tryActionViaSmartFallback(doc, act);
                        if (!okSmartA) {
                            __push_unique(__report.missingGroupPaths, String(act.groupPath));
                        }
                        continue;
                    }
                }
                var tl = findArtLayerByName(target, act.layerName, true);
                if (tl && typeof tl.textItem !== "undefined") {
                    tl.textItem.contents = String(act.text);
                } else {
                    // Fallback khi không tìm thấy layer text trong group hiện tại
                    var okSmartB = tryActionViaSmartFallback(doc, act);
                    if (!okSmartB) {
                        __report.missingTextTargets.push({
                            groupPath: act.groupPath || "",
                            layerName: String(act.layerName)
                        });
                    }
                }
            }
            else if (t === "visibility") {
                if (!act.path || typeof act.visible === "undefined") {
                    __pushParamError(ai, t, "Missing path or visible", null);
                    continue;
                }
                var p = toParts(act.path);
                var obj = findContainerOrLayer(doc, p);
                if (obj && obj.obj) {
                    obj.obj.visible = !!act.visible;
                } else {
                    // thử fallback qua Smart Object cho visibility theo path có chứa tên smart
                    var okSmartV = tryActionViaSmartFallback(doc, {
                        type: "visibility",
                        groupPath: act.path, // reuse cùng quy ước path
                        path: act.path,
                        visible: act.visible
                    });
                    if (!okSmartV) {
                        __push_unique(__report.missingPaths, String(act.path));
                    }
                }
            }
            else if (t === "smart_edit_contents") {
                var path = act.smartLayerPath || act.smartLayerName;
                if (!path || !act.inner || !(act.inner instanceof Array)) {
                    __pushParamError(ai, t, "Missing smartLayerPath/smartLayerName or inner[]", null);
                    continue;
                }
                var pathParts = toParts(path);
                var soLayer = getLayerByPath(doc, pathParts);
                if (!soLayer) { $.writeln("Smart Object not found: " + path); continue; }
                app.activeDocument.activeLayer = soLayer;

                editSmartObjectContents(); // mở .psb
                var innerDoc = app.activeDocument;
                runActionsOnCurrentDoc(act.inner);
                try { innerDoc.save(); } catch(e){}
                try { innerDoc.close(SaveOptions.SAVECHANGES); } catch(e){}
            }
        }

        // Export JPG
        var jpgOpt = new JPEGSaveOptions();
        jpgOpt.quality = jpgQ;
        jpgOpt.embedColorProfile = true;
        jpgOpt.formatOptions = FormatOptions.STANDARDBASELINE;
        jpgOpt.matte = MatteType.NONE;

        var outFile = new File(outFolder.fsName + "/" + outName);
        doc.saveAs(outFile, jpgOpt, true, Extension.LOWERCASE);

    } catch (err) {
        // im lặng
    } finally {
        try { __writeReportJSON(resultPath); } catch (e) {}
        try { if (doc) doc.close(SaveOptions.DONOTSAVECHANGES); } catch(e){}
    }

})();
