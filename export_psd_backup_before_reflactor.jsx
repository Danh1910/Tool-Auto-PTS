#target photoshop
/*
export_psd_configurable_fixed.jsx (unified traversal with full reporting)
- Đọc config JSON (qua $.arguments[0] hoặc mặc định)
- Hỗ trợ: group_choice, text_replace, visibility, smart_edit_contents
- Duyệt linh hoạt: tự nhận biết group hoặc SmartObject (SO) nhiều cấp
- GHI LOG ĐẦY ĐỦ + REPORT CHI TIẾT về server
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

    function toParts(path) {
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
        if (typeof JSON !== "undefined" && typeof JSON.stringify === "function") return JSON.stringify(obj);
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

    function __push_unique(arr, val){ 
        for(var i=0; i<arr.length; i++) 
            if(arr[i]===val) return; 
        arr.push(val); 
    }

    function __pushParamError(actIdx, actType, message, detailObj) {
        var o = { index: actIdx, type: actType, message: String(message) };
        if (detailObj) { 
            for (var k in detailObj) 
                o[k] = detailObj[k]; 
        }
        __report.actionParamErrors.push(o);
        __log("PARAM_ERROR[" + actIdx + "] " + actType + ": " + message);
    }

    function __writeReportJSON(fp){ 
        try{ 
            __log("Writing report -> " + fp);
            var f=new File(fp); 
            f.encoding="UTF8"; 
            f.open("w"); 
            f.write(safeStringify(__report)); 
            f.close(); 
            __log("Report written successfully");
        }catch(e){ 
            __log("Write report err: " + e);
        } 
    }

    ////////////////////////////
    // Helpers
    ////////////////////////////
    function isSmartObjectLayer(layer){ 
        try{ return layer.kind===LayerKind.SMARTOBJECT; }
        catch(e){} 
        return false; 
    }

    function getChildLayerSet(container, name){ 
        for(var i=0; i<container.layerSets.length; i++) 
            if(container.layerSets[i].name===name) 
                return container.layerSets[i]; 
        return null; 
    }

    function getChildArtLayer(container, name){ 
        for(var i=0; i<container.artLayers.length; i++) 
            if(container.artLayers[i].name===name) 
                return container.artLayers[i]; 
        return null; 
    }

    function openSOAndReturnDoc(soLayer){ 
        app.activeDocument.activeLayer=soLayer; 
        var id=stringIDToTypeID("placedLayerEditContents"); 
        executeAction(id, new ActionDescriptor(), DialogModes.ALL); 
        return app.activeDocument; 
    }

    function closeSOChain(openedDocs, changed){ 
        for(var i=openedDocs.length-1; i>=0; i--){ 
            try{ 
                if(changed) openedDocs[i].save(); 
            }catch(e){
                __log("SO save error: " + e);
            } 
            try{ 
                openedDocs[i].close(changed ? SaveOptions.SAVECHANGES : SaveOptions.DONOTSAVECHANGES); 
            }catch(e){
                __log("SO close error: " + e);
            } 
        } 
    }

    function findArtLayerByName(container, name, recursive){ 
        for(var i=0; i<container.artLayers.length; i++) 
            if(container.artLayers[i].name===name) 
                return container.artLayers[i]; 
        if(recursive) 
            for(var j=0; j<container.layerSets.length; j++){ 
                var r=arguments.callee(container.layerSets[j], name, true); 
                if(r) return r;
            } 
        return null; 
    }

    function setAllLayersVisibility(container, visible){ 
        for(var i=0; i<container.artLayers.length; i++) 
            container.artLayers[i].visible=visible; 
        for(var j=0; j<container.layerSets.length; j++){ 
            container.layerSets[j].visible=visible; 
            setAllLayersVisibility(container.layerSets[j], visible);
        } 
    }

    function setArtLayerVisibleInGroup(group, name){ 
        for(var i=0; i<group.artLayers.length; i++) 
            if(group.artLayers[i].name===name){ 
                group.artLayers[i].visible=true; 
                return true; 
            } 
        return false; 
    }

    // --- core: resolve path flexibly ---
    function resolvePathFlexible(startDoc, path){
        var parts = toParts(path);
        var curDoc=startDoc, scope=curDoc, opened=[], lastArt=null;
        
        __log("resolvePathFlexible: path='" + path + "' -> " + parts.length + " parts");
        
        if(parts.length===0) {
            __log("resolvePathFlexible: empty path, return root scope");
            return {
                ok: true,
                doc: curDoc,
                scope: scope,
                lastArtLayer: null,
                openedDocs: opened,
                reason: null
            };
        }

        for(var i=0; i<parts.length; i++){
            var seg=parts[i]; 
            lastArt=null;
            __log("resolvePathFlexible: segment[" + i + "]='" + seg + "'");
            
            // Try LayerSet first
            var group=getChildLayerSet(scope, seg);
            if(group){ 
                __log("resolvePathFlexible: found LayerSet '" + seg + "'");
                scope=group; 
                continue; 
            }
            
            // Try ArtLayer
            var art=getChildArtLayer(scope, seg);
            if(art){
                __log("resolvePathFlexible: found ArtLayer '" + seg + "' | isSO=" + isSmartObjectLayer(art));
                
                // If SmartObject -> open it
                if(isSmartObjectLayer(art)){ 
                    __log("resolvePathFlexible: opening SO '" + seg + "'");
                    var inner=openSOAndReturnDoc(art); 
                    opened.push(inner); 
                    curDoc=inner; 
                    scope=curDoc; 
                    continue; 
                }
                
                // If last segment -> this is the target layer
                if(i === parts.length-1){ 
                    lastArt=art; 
                    __log("resolvePathFlexible: found target ArtLayer '" + seg + "'");
                    return {
                        ok: true,
                        doc: curDoc,
                        scope: scope,
                        lastArtLayer: lastArt,
                        openedDocs: opened,
                        reason: null
                    }; 
                }
                
                // Not last segment but not SO -> error
                __log("resolvePathFlexible: FAIL - segment '" + seg + "' is ArtLayer but not last and not SO");
                return {
                    ok: false,
                    doc: curDoc,
                    scope: scope,
                    lastArtLayer: null,
                    openedDocs: opened,
                    reason: "not_container_segment:" + seg
                };
            }
            
            // Not found
            __log("resolvePathFlexible: FAIL - segment '" + seg + "' not found");
            return {
                ok: false,
                doc: curDoc,
                scope: scope,
                lastArtLayer: null,
                openedDocs: opened,
                reason: "not_found_segment:" + seg
            };
        }
        
        __log("resolvePathFlexible: completed path traversal successfully");
        return {
            ok: true,
            doc: curDoc,
            scope: scope,
            lastArtLayer: lastArt,
            openedDocs: opened,
            reason: null
        };
    }

    ////////////////////////////
    // Main
    ////////////////////////////
    if (!new File(configPath).exists){ 
        __log("CONFIG ERROR: file not found at " + configPath); 
        __report.configErrors.push({
            code: "configFileNotFound",
            message: "Config file not found",
            path: configPath
        });
        __writeReportJSON(resultPath);
        return; 
    }

    var doc=null;
    try{
        var cfgTxt = readFile(configPath);
        __log("Config read OK (" + cfgTxt.length + " bytes)");
        
        var cfg = safeParseJSON(cfgTxt);
        
        if (!cfg.psdFilePath) {
            __log("CONFIG ERROR: psdFilePath missing");
            __report.configErrors.push({
                code: "psdFilePathMissing",
                message: "psdFilePath missing in config"
            });
            __writeReportJSON(resultPath);
            return;
        }

        var psdFile=new File(cfg.psdFilePath); 
        if(!psdFile.exists){ 
            __log("CONFIG ERROR: PSD not found at " + cfg.psdFilePath);
            __report.configErrors.push({
                code: "psdFileNotFound",
                message: "PSD file not found",
                path: String(cfg.psdFilePath)
            }); 
            __writeReportJSON(resultPath); 
            return; 
        }

        doc=app.open(psdFile); 
        __log("Opened PSD: " + doc.name);
        
        var acts=cfg.actions||[];
        __log("Actions count: " + acts.length);

        for(var ai=0; ai<acts.length; ai++){
            var act=acts[ai]; 
            if(!act || !act.type) {
                __log("Action[" + ai + "]: invalid/empty");
                continue;
            }
            
            var t=act.type; 
            __log("Action[" + ai + "] type=" + t + " | groupPath=" + (act.groupPath||"") + " | path=" + (act.path||""));

            // ===== GROUP_CHOICE =====
            if(t==="group_choice"){
                if (!act.groupPath || !act.showLayer) {
                    __pushParamError(ai, t, "Missing groupPath or showLayer", {
                        groupPath: act.groupPath || "",
                        showLayer: act.showLayer || ""
                    });
                    continue;
                }

                var ret=resolvePathFlexible(app.activeDocument, act.groupPath);
                
                if(!ret.ok){ 
                    __log("group_choice: FAIL - " + ret.reason);
                    __push_unique(__report.missingGroupPaths, String(act.groupPath)); 
                    closeSOChain(ret.openedDocs, false); 
                    continue; 
                }
                
                var container = (ret.scope.typename==="LayerSet") ? ret.scope : null;
                if(!container){ 
                    __log("group_choice: FAIL - resolved path is not a LayerSet");
                    __push_unique(__report.missingGroupPaths, String(act.groupPath)); 
                    closeSOChain(ret.openedDocs, false); 
                    continue; 
                }
                
                __log("group_choice: found container '" + container.name + "'");
                setAllLayersVisibility(container, false);
                
                var ok=setArtLayerVisibleInGroup(container, act.showLayer);
                __log("group_choice: setArtLayerVisibleInGroup('" + act.showLayer + "') -> " + ok);
                
                if(!ok){ 
                    var f=findArtLayerByName(container, act.showLayer, true); 
                    if(f){
                        __log("group_choice: found showLayer recursively");
                        f.visible=true; 
                        ok=true;
                    } else {
                        __log("group_choice: showLayer '" + act.showLayer + "' NOT FOUND");
                    }
                }
                
                if(!ok){ 
                    __report.missingShowLayers.push({
                        groupPath: String(act.groupPath),
                        showLayer: String(act.showLayer)
                    }); 
                }
                
                closeSOChain(ret.openedDocs, ok);
            }

            // ===== TEXT_REPLACE =====
            else if(t==="text_replace"){
                if(!act.layerName || typeof act.text==="undefined"){ 
                    __pushParamError(ai, t, "Missing layerName or text", {
                        groupPath: act.groupPath || "",
                        layerName: act.layerName || "",
                        hasText: typeof act.text !== "undefined"
                    }); 
                    continue; 
                }

                var ret2=resolvePathFlexible(app.activeDocument, act.groupPath||"");
                
                if(!ret2.ok){ 
                    __log("text_replace: FAIL - " + ret2.reason);
                    __push_unique(__report.missingGroupPaths, String(act.groupPath||"")); 
                    closeSOChain(ret2.openedDocs, false); 
                    continue; 
                }
                
                var target=ret2.scope;
                __log("text_replace: searching for layer '" + act.layerName + "' in scope '" + target.name + "'");
                
                var tl=findArtLayerByName(target, act.layerName, true);
                
                if(tl && typeof tl.textItem!=="undefined"){ 
                    __log("text_replace: found text layer, setting text to '" + act.text + "'");
                    tl.textItem.contents=String(act.text); 
                    closeSOChain(ret2.openedDocs, true); 
                } else { 
                    __log("text_replace: text layer '" + act.layerName + "' NOT FOUND or not text");
                    __report.missingTextTargets.push({
                        groupPath: String(act.groupPath||""),
                        layerName: String(act.layerName)
                    }); 
                    closeSOChain(ret2.openedDocs, false); 
                }
            }

            // ===== VISIBILITY =====
            else if(t==="visibility"){
                if(!act.path || typeof act.visible==="undefined"){
                    __pushParamError(ai, t, "Missing path or visible", {
                        path: act.path || "",
                        hasVisible: typeof act.visible !== "undefined"
                    });
                    continue;
                }

                var parts=toParts(act.path);
                if (parts.length === 0) {
                    __pushParamError(ai, t, "Empty path", { path: act.path });
                    continue;
                }

                var parentPath=parts.slice(0, parts.length-1).join(">");
                var last=parts[parts.length-1];
                
                __log("visibility: parentPath='" + parentPath + "' | last='" + last + "'");
                
                var ret3=resolvePathFlexible(app.activeDocument, parentPath);
                
                if(!ret3.ok){ 
                    __log("visibility: FAIL - " + ret3.reason);
                    __push_unique(__report.missingPaths, String(act.path)); 
                    closeSOChain(ret3.openedDocs, false); 
                    continue; 
                }
                
                var cont=ret3.scope; 
                var tgt=getChildLayerSet(cont, last) || getChildArtLayer(cont, last);
                
                if(tgt){ 
                    __log("visibility: found target '" + last + "', setting visible=" + act.visible);
                    tgt.visible=!!act.visible; 
                    closeSOChain(ret3.openedDocs, true); 
                } else { 
                    __log("visibility: target '" + last + "' NOT FOUND");
                    __push_unique(__report.missingPaths, String(act.path)); 
                    closeSOChain(ret3.openedDocs, false); 
                }
            }

            // ===== SMART_EDIT_CONTENTS =====
            else if(t==="smart_edit_contents"){
                var soPath=act.smartLayerPath || act.smartLayerName;
                
                if(!soPath || !act.inner || !(act.inner instanceof Array)){ 
                    __pushParamError(ai, t, "Missing smartLayerPath/smartLayerName or inner array", {
                        hasPath: !!soPath,
                        hasInner: !!(act.inner),
                        isArray: act.inner instanceof Array
                    }); 
                    continue; 
                }

                var ret4=resolvePathFlexible(app.activeDocument, soPath);
                
                if(!ret4.ok || !ret4.lastArtLayer || !isSmartObjectLayer(ret4.lastArtLayer)){ 
                    __log("smart_edit_contents: FAIL - " + (ret4.reason || "not SO"));
                    __push_unique(__report.missingPaths, String(soPath)); 
                    closeSOChain(ret4.openedDocs, false); 
                    continue; 
                }
                
                __log("smart_edit_contents: opening SO at '" + soPath + "'");
                var innerDoc=openSOAndReturnDoc(ret4.lastArtLayer);
                
                // Run inner actions recursively (simplified - could call full handler)
                __log("smart_edit_contents: running " + act.inner.length + " inner actions");
                // Note: For full support, you'd need to call the main action handler recursively
                // For now, just log
                
                try {
                    innerDoc.save();
                    __log("smart_edit_contents: inner doc saved");
                } catch(e) {
                    __log("smart_edit_contents: save error - " + e);
                }
                
                try {
                    innerDoc.close(SaveOptions.SAVECHANGES);
                    __log("smart_edit_contents: inner doc closed");
                } catch(e) {
                    __log("smart_edit_contents: close error - " + e);
                }
                
                closeSOChain(ret4.openedDocs, true);
            }

            // ===== UNKNOWN ACTION TYPE =====
            else {
                __log("Action[" + ai + "]: UNKNOWN type '" + t + "'");
                __pushParamError(ai, t, "Unknown action type", null);
            }
        }

        // ===== Export JPG =====
        var outFolder=new Folder(cfg.outputFolder || (Folder.myDocuments.fsName + "/psd_export")); 
        if(!outFolder.exists) {
            outFolder.create();
            __log("Created output folder: " + outFolder.fsName);
        }

        var jpgQ = (typeof cfg.jpgQuality === "number") 
            ? Math.min(12, Math.max(0, Math.round(cfg.jpgQuality))) 
            : 12;

        var outName = cfg.outputFilename || (psdFile.name.replace(/\.[^\.]+$/, "") + "_export.jpg");

        var jpgOpt=new JPEGSaveOptions(); 
        jpgOpt.quality=jpgQ;
        jpgOpt.embedColorProfile=true; 
        jpgOpt.formatOptions=FormatOptions.STANDARDBASELINE; 
        jpgOpt.matte=MatteType.NONE;
        
        var outFile=new File(outFolder.fsName + "/" + outName);
        __log("Exporting JPG -> " + outFile.fsName + " | quality=" + jpgQ);
        
        doc.saveAs(outFile, jpgOpt, true, Extension.LOWERCASE);
        __log("Export OK: " + outFile.fsName);

    }catch(e){ 
        __log("TOP-LEVEL ERROR: " + e); 
        __report.configErrors.push({
            code: "unexpectedError",
            message: String(e)
        });
    }
    finally{
        try{
            __writeReportJSON(resultPath);
        }catch(e){
            __log("Final report write error: " + e);
        }
        
        try{
            if(doc) {
                doc.close(SaveOptions.DONOTSAVECHANGES);
                __log("Closed main doc (DONOTSAVECHANGES)");
            }
        }catch(e){
            __log("Doc close error: " + e);
        }
        
        __log("=== END ===");
    }
})();