#target photoshop
/*
export_psd_configurable.jsx (unified traversal with full reporting)
- Chỉ giữ "main flow" và logic chính
- Nạp helpers từ ps_utils.jsx bằng $.evalFile
*/

(function () {
    app.displayDialogs = DialogModes.NO;

    ////////////////////////////
    // Load utils (cùng thư mục)
    ////////////////////////////
    (function loadUtilsOnce(){
        if (typeof Utils !== "undefined") return;
        var here = File($.fileName).parent;
        var utilPath = File(here + "/ps_utils.jsx"); // đổi sang ps_utils.jsxbin nếu cần
        if (!utilPath.exists) throw new Error("Utils not found at: " + utilPath.fsName);
        $.evalFile(utilPath);
    })();

    ////////////////////////////
    // Logging
    ////////////////////////////
    var configPath = ($.arguments && $.arguments[0]) || Folder.myDocuments.fsName + "/psd_config.json";
    var resultPath = ($.arguments && $.arguments[1]) || Folder.myDocuments.fsName + "/psd_result.json";
    var __logPath = (function(){
        try {
            if ($.arguments && $.arguments.length > 2 && $.arguments[2])
                return $.arguments[2];
            return String(resultPath).replace(/\.json$/i, "_debug.log");
        } catch(e){ return Folder.myDocuments.fsName + "/psd_debug.log"; }
    })();

    function __appendLine(fp, s) {
        try {
            var f = new File(fp);
            f.encoding = "UTF8";
            if (!f.open("a")) f.open("w");
            f.writeln(new Date().toISOString() + " | " + s);
            f.close();
        } catch(e){}
    }
    function __log(s){ __appendLine(__logPath, s); }

    // Cho Utils dùng chung logger
    if (typeof Utils !== "undefined" && Utils.setLogger) {
        try { Utils.setLogger(__log); } catch(e) {}
    }

    __log("=== START ===");
    __log("config=" + configPath);
    __log("result=" + resultPath);
    __log("log=" + __logPath);

    ////////////////////////////
    // Report accumulator
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

    function __pushParamError(actIdx, actType, message, detailObj) {
        var o = { index: actIdx, type: actType, message: String(message) };
        if (detailObj) { for (var k in detailObj) o[k] = detailObj[k]; }
        __report.actionParamErrors.push(o);
        __log("PARAM_ERROR[" + actIdx + "] " + actType + ": " + message);
    }

    function __writeReportJSON(fp){
        try{
            __log("Writing report -> " + fp);
            var f = new File(fp);
            f.encoding = "UTF8";
            f.open("w");
            f.write(Utils.safeStringify(__report));
            f.close();
            __log("Report written successfully");
        }catch(e){
            __log("Write report err: " + e);
        }
    }

    ////////////////////////////
    // Resolve path (main logic)
    ////////////////////////////
    function resolvePathFlexible(startDoc, path){
        var parts = Utils.toParts(path);
        var curDoc = startDoc, scope = curDoc, opened = [], lastArt = null;

        __log("resolvePathFlexible: path='" + path + "' -> " + parts.length + " parts");

        if (parts.length === 0) {
            __log("resolvePathFlexible: empty path, return root scope");
            return { ok:true, doc:curDoc, scope:scope, lastArtLayer:null, openedDocs:opened, reason:null };
        }

        for (var i=0; i<parts.length; i++){
            var seg = parts[i];
            lastArt = null;
            __log("resolvePathFlexible: segment[" + i + "]='" + seg + "'");

            // LayerSet?
            var group = Utils.getChildLayerSet(scope, seg);
            if (group){
                __log("resolvePathFlexible: found LayerSet '" + seg + "'");
                scope = group;
                continue;
            }

            // ArtLayer?
            var art = Utils.getChildArtLayer(scope, seg);
            if (art){
                __log("resolvePathFlexible: found ArtLayer '" + seg + "' | isSO=" + Utils.isSmartObjectLayer(art));

                // Nếu SmartObject -> mở
                if (Utils.isSmartObjectLayer(art)){
                    __log("resolvePathFlexible: opening SO '" + seg + "'");
                    var inner = Utils.openSOAndReturnDoc(art);
                    opened.push(inner);
                    curDoc = inner;
                    scope = curDoc;
                    continue;
                }

                // Nếu là segment cuối -> target
                if (i === parts.length - 1){
                    lastArt = art;
                    __log("resolvePathFlexible: found target ArtLayer '" + seg + "'");
                    return { ok:true, doc:curDoc, scope:scope, lastArtLayer:lastArt, openedDocs:opened, reason:null };
                }

                // Không phải cuối & không phải SO -> lỗi
                __log("resolvePathFlexible: FAIL - segment '" + seg + "' is ArtLayer but not last and not SO");
                return { ok:false, doc:curDoc, scope:scope, lastArtLayer:null, openedDocs:opened, reason:"not_container_segment:" + seg };
            }

            // Không tìm thấy
            __log("resolvePathFlexible: FAIL - segment '" + seg + "' not found");
            return { ok:false, doc:curDoc, scope:scope, lastArtLayer:null, openedDocs:opened, reason:"not_found_segment:" + seg };
        }

        __log("resolvePathFlexible: completed path traversal successfully");
        return { ok:true, doc:curDoc, scope:scope, lastArtLayer:lastArt, openedDocs:opened, reason:null };
    }

    ////////////////////////////
    // Main
    ////////////////////////////
    if (!new File(configPath).exists){
        __log("CONFIG ERROR: file not found at " + configPath);
        __report.configErrors.push({ code:"configFileNotFound", message:"Config file not found", path:configPath });
        __writeReportJSON(resultPath);
        return;
    }

    var doc = null;
    try {
        var cfgTxt = Utils.readFile(configPath);
        __log("Config read OK (" + cfgTxt.length + " bytes)");

        var cfg = Utils.safeParseJSON(cfgTxt);

        if (!cfg.psdFilePath) {
            __log("CONFIG ERROR: psdFilePath missing");
            __report.configErrors.push({ code:"psdFilePathMissing", message:"psdFilePath missing in config" });
            __writeReportJSON(resultPath);
            return;
        }

        var psdFile = new File(cfg.psdFilePath);
        if (!psdFile.exists){
            __log("CONFIG ERROR: PSD not found at " + cfg.psdFilePath);
            __report.configErrors.push({ code:"psdFileNotFound", message:"PSD file not found", path:String(cfg.psdFilePath) });
            __writeReportJSON(resultPath);
            return;
        }

        doc = app.open(psdFile);
        __log("Opened PSD: " + doc.name);

        var acts = cfg.actions || [];
        __log("Actions count: " + acts.length);

        for (var ai=0; ai<acts.length; ai++){
            var act = acts[ai];
            if (!act || !act.type) {
                __log("Action[" + ai + "]: invalid/empty");
                continue;
            }

            var t = act.type;
            __log("Action[" + ai + "] type=" + t + " | groupPath=" + (act.groupPath||"") + " | path=" + (act.path||""));

            // ===== GROUP_CHOICE =====
            if (t === "group_choice") {
                if (!act.groupPath || !act.showLayer) {
                    __pushParamError(ai, t, "Missing groupPath or showLayer", { groupPath: act.groupPath||"", showLayer: act.showLayer||"" });
                    continue;
                }

                var ret = resolvePathFlexible(app.activeDocument, act.groupPath);

                if (!ret.ok){
                    __log("group_choice: FAIL - " + ret.reason);
                    Utils.pushUnique(__report.missingGroupPaths, String(act.groupPath));
                    Utils.closeSOChain(ret.openedDocs, false);
                    continue;
                }

                var container = (ret.scope.typename === "LayerSet") ? ret.scope : null;
                if (!container){
                    __log("group_choice: FAIL - resolved path is not a LayerSet");
                    Utils.pushUnique(__report.missingGroupPaths, String(act.groupPath));
                    Utils.closeSOChain(ret.openedDocs, false);
                    continue;
                }

                __log("group_choice: found container '" + container.name + "'");
                Utils.setAllLayersVisibility(container, false);

                var ok = Utils.setArtLayerVisibleInGroup(container, act.showLayer);
                __log("group_choice: setArtLayerVisibleInGroup('" + act.showLayer + "') -> " + ok);

                if (!ok){
                    var f = Utils.findArtLayerByName(container, act.showLayer, true);
                    if (f){
                        __log("group_choice: found showLayer recursively");
                        f.visible = true;
                        ok = true;
                    } else {
                        __log("group_choice: showLayer '" + act.showLayer + "' NOT FOUND");
                    }
                }

                if (!ok){
                    __report.missingShowLayers.push({ groupPath:String(act.groupPath), showLayer:String(act.showLayer) });
                }

                Utils.closeSOChain(ret.openedDocs, ok);
            }

            // ===== TEXT_REPLACE =====
            else if (t === "text_replace") {
                if (!act.layerName || typeof act.text === "undefined"){
                    __pushParamError(ai, t, "Missing layerName or text", {
                        groupPath: act.groupPath || "",
                        layerName: act.layerName || "",
                        hasText: (typeof act.text !== "undefined")
                    });
                    continue;
                }

                var ret2 = resolvePathFlexible(app.activeDocument, act.groupPath||"");

                if (!ret2.ok){
                    __log("text_replace: FAIL - " + ret2.reason);
                    Utils.pushUnique(__report.missingGroupPaths, String(act.groupPath||""));
                    Utils.closeSOChain(ret2.openedDocs, false);
                    continue;
                }

                var target = ret2.scope;
                __log("text_replace: searching for layer '" + act.layerName + "' in scope '" + target.name + "'");

                var tl = Utils.findArtLayerByName(target, act.layerName, true);

                if (tl && typeof tl.textItem !== "undefined"){
                    __log("text_replace: found text layer, setting text to '" + act.text + "'");
                    tl.textItem.contents = String(act.text);
                    Utils.closeSOChain(ret2.openedDocs, true);
                } else {
                    __log("text_replace: text layer '" + act.layerName + "' NOT FOUND or not text");
                    __report.missingTextTargets.push({ groupPath:String(act.groupPath||""), layerName:String(act.layerName) });
                    Utils.closeSOChain(ret2.openedDocs, false);
                }
            }

            // ===== VISIBILITY =====
            else if (t === "visibility") {
                if (!act.path || typeof act.visible === "undefined"){
                    __pushParamError(ai, t, "Missing path or visible", { path: act.path || "", hasVisible: (typeof act.visible !== "undefined") });
                    continue;
                }

                var parts = Utils.toParts(act.path);
                if (parts.length === 0) {
                    __pushParamError(ai, t, "Empty path", { path: act.path });
                    continue;
                }

                var parentPath = parts.slice(0, parts.length - 1).join(">");
                var last = parts[parts.length - 1];

                __log("visibility: parentPath='" + parentPath + "' | last='" + last + "'");

                var ret3 = resolvePathFlexible(app.activeDocument, parentPath);

                if (!ret3.ok){
                    __log("visibility: FAIL - " + ret3.reason);
                    Utils.pushUnique(__report.missingPaths, String(act.path));
                    Utils.closeSOChain(ret3.openedDocs, false);
                    continue;
                }

                var cont = ret3.scope;
                var tgt = Utils.getChildLayerSet(cont, last) || Utils.getChildArtLayer(cont, last);

                if (tgt){
                    __log("visibility: found target '" + last + "', setting visible=" + act.visible);
                    tgt.visible = !!act.visible;
                    Utils.closeSOChain(ret3.openedDocs, true);
                } else {
                    __log("visibility: target '" + last + "' NOT FOUND");
                    Utils.pushUnique(__report.missingPaths, String(act.path));
                    Utils.closeSOChain(ret3.openedDocs, false);
                }
            }

            // ===== SMART_EDIT_CONTENTS =====
            else if (t === "smart_edit_contents") {
                var soPath = act.smartLayerPath || act.smartLayerName;

                if (!soPath || !act.inner || !(act.inner instanceof Array)){
                    __pushParamError(ai, t, "Missing smartLayerPath/smartLayerName or inner array", {
                        hasPath: !!soPath, hasInner: !!(act.inner), isArray: act.inner instanceof Array
                    });
                    continue;
                }

                var ret4 = resolvePathFlexible(app.activeDocument, soPath);

                if (!ret4.ok || !ret4.lastArtLayer || !Utils.isSmartObjectLayer(ret4.lastArtLayer)){
                    __log("smart_edit_contents: FAIL - " + (ret4.reason || "not SO"));
                    Utils.pushUnique(__report.missingPaths, String(soPath));
                    Utils.closeSOChain(ret4.openedDocs, false);
                    continue;
                }

                __log("smart_edit_contents: opening SO at '" + soPath + "'");
                var innerDoc = Utils.openSOAndReturnDoc(ret4.lastArtLayer);

                // NOTE: Ở đây bạn có thể implement xử lý act.inner tương tự main-loop nếu cần
                __log("smart_edit_contents: running " + act.inner.length + " inner actions (stub)");

                try { innerDoc.save(); __log("smart_edit_contents: inner doc saved"); }
                catch(e){ __log("smart_edit_contents: save error - " + e); }

                try { innerDoc.close(SaveOptions.SAVECHANGES); __log("smart_edit_contents: inner doc closed"); }
                catch(e){ __log("smart_edit_contents: close error - " + e); }

                Utils.closeSOChain(ret4.openedDocs, true);
            }

            // ===== UNKNOWN =====
            else {
                __log("Action[" + ai + "]: UNKNOWN type '" + t + "'");
                __pushParamError(ai, t, "Unknown action type", null);
            }
        }

        // ===== Export JPG =====
        var outFolder = new Folder(cfg.outputFolder || (Folder.myDocuments.fsName + "/psd_export"));
        if (!outFolder.exists) {
            outFolder.create();
            __log("Created output folder: " + outFolder.fsName);
        }

        var jpgQ = (typeof cfg.jpgQuality === "number")
            ? Math.min(12, Math.max(0, Math.round(cfg.jpgQuality)))
            : 12;

        var outName = cfg.outputFilename || (psdFile.name.replace(/\.[^\.]+$/, "") + "_export.jpg");

        var jpgOpt = new JPEGSaveOptions();
        jpgOpt.quality = jpgQ;
        jpgOpt.embedColorProfile = true;
        jpgOpt.formatOptions = FormatOptions.STANDARDBASELINE;
        jpgOpt.matte = MatteType.NONE;

        var outFile = new File(outFolder.fsName + "/" + outName);
        __log("Exporting JPG -> " + outFile.fsName + " | quality=" + jpgQ);

        doc.saveAs(outFile, jpgOpt, true, Extension.LOWERCASE);
        __log("Export OK: " + outFile.fsName);

    } catch(e){
        __log("TOP-LEVEL ERROR: " + e);
        __report.configErrors.push({ code:"unexpectedError", message:String(e) });
    } finally {
        try { __writeReportJSON(resultPath); }
        catch(e){ __log("Final report write error: " + e); }

        try {
            if (doc){
                doc.close(SaveOptions.DONOTSAVECHANGES);
                __log("Closed main doc (DONOTSAVECHANGES)");
            }
        } catch(e){ __log("Doc close error: " + e); }

        __log("=== END ===");
    }
})();
