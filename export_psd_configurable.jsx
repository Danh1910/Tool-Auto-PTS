#target photoshop
/*
export_psd_configurable_fixed.jsx
- Đọc config JSON (qua $.arguments[0] hoặc mặc định)
- Hỗ trợ: group_choice, text_replace, visibility, smart_edit_contents
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

    function toParts(path) {        // tách chuỗi "Group 1 > Group 2 > Layer Name" thành mảng ["Group 1", "Group 2", "Layer Name"]
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
        configErrors: [],        // << NEW: lỗi cấp config (psdFilePath...)
        actionParamErrors: [],   // << NEW: lỗi thiếu tham số trong từng action
        notes: []                 // ghi chú khác nếu cần
    };

    function __push_unique(arr, val) {
        // tránh trùng lặp
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
    function getLayerSetByPath(doc, parts) {        // Tìm đúng group
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
                var r = findArtLayerByName(container.layerSets[j], name, true);
                if (r) return r;
            }
        return null;
    }

    function setAllLayersVisibility(container, visible) {       // Tắt hết layer trong group
        for (var i = 0; i < container.artLayers.length; i++)
            container.artLayers[i].visible = visible;
        for (var j = 0; j < container.layerSets.length; j++) {
            container.layerSets[j].visible = visible;
            setAllLayersVisibility(container.layerSets[j], visible);
        }
    }

    function setArtLayerVisibleInGroup(group, name) {       // Nếu tìm thấy, bật visible, trả về true; nếu không, false.
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
    // Smart Object Helpers
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
                var gp = toParts(act.groupPath || "");      // tách chuỗi group1 > group2 thành mảng ["group1", "Color"]
                var group = getLayerSetByPath(doc, gp);      // tìm đúng group theo mảng trên
                if (!group) {
                    if (act.groupPath) __push_unique(__report.missingGroupPaths, String(act.groupPath));
                    continue;   // không tìm thấy group thì bỏ qua     
                }                                    
                setAllLayersVisibility(group, false);   // tắt hết layer trong group
                var ok = setArtLayerVisibleInGroup(group, act.showLayer); // tìm layer cần bật trong group
                if (!ok) {                             // nếu không tìm thấy layer trực tiếp trong group
                    var fnd = findArtLayerByName(group, act.showLayer, true);   // tìm trong group (đệ quy)
                    if (fnd) {
                        fnd.visible = true;
                    } else {
                        __report.missingShowLayers.push({
                            groupPath: act.groupPath || "",
                            showLayer: String(act.showLayer) // nếu tìm thấy thì bật visible
                        });
                    }        
                }
            }
            else if (t === "text_replace") {
                if (!act.layerName || typeof act.text === "undefined") continue;    // Nếu không khai báo tên layer hoặc nội dung text, bỏ qua action này.
                var target = doc;               // Mặc định tìm trong toàn tài liệu PSD
                if (act.groupPath) {             // Nếu có groupPath, giới hạn phạm vi tìm kiếm trong group đó.
                    var gp2 = toParts(act.groupPath);
                    var g2 = getLayerSetByPath(doc, gp2);
                    if (g2) {
                        target = g2;    // Nếu tìm thấy group, đặt target là group đó.
                    } else {
                        __push_unique(__report.missingGroupPaths, String(act.groupPath));
                        continue; // không có group thì bỏ qua action này
                    }        
                }
                var tl = findArtLayerByName(target, act.layerName, true);  // Tìm (đệ quy) ArtLayer tên layerName trong target. Nếu tìm thấy, trả về layer.
                if (tl && typeof tl.textItem !== "undefined") { // Nếu tìm thấy layer và có textItem (là layer text)
                    tl.textItem.contents = String(act.text); // Thay thế nội dung text.
                } else {
                    __report.missingTextTargets.push({
                        groupPath: act.groupPath || "",
                        layerName: String(act.layerName) 
                    });
                }    
            }
            else if (t === "visibility") {
                if (!act.path || typeof act.visible === "undefined") continue;
                var p = toParts(act.path);
                var obj = findContainerOrLayer(doc, p);
                if (obj && obj.obj) obj.obj.visible = !!act.visible;
            }
            else if (t === "smart_edit_contents") {
                var path = act.smartLayerPath || act.smartLayerName;
                if (!path || !act.inner || !(act.inner instanceof Array)) continue;
                var pathParts = toParts(path);
                var soLayer = getLayerByPath(doc, pathParts);
                if (!soLayer) { $.writeln("Smart Object not found: " + path); continue; }
                app.activeDocument.activeLayer = soLayer;

                editSmartObjectContents(); // mở Girl.psb
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
        // alert("✅ Exported: " + outFile.fsName);
        $.writeln("[JSX] resultPath = " + resultPath);

    } catch (err) {
        // alert("❌ Error: " + (err && err.message ? err.message : String(err)));
    } finally {
        try { __writeReportJSON(resultPath); } catch (e) {}
        try { if (doc) doc.close(SaveOptions.DONOTSAVECHANGES); } catch(e){}
    }

})();
