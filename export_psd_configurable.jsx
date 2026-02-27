#target photoshop
/*
export_psd_configurable.jsx (unified traversal with full reporting)
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
        missingGroupPaths: [], // group_path không tới được
        missingPaths: [],       // path (group/layer) không tìm thấy
        missingTextTargets: [], // text layer không tìm thấy
        missingShowLayers: [],  //group_choice: showLayer không tìm thấy
        configErrors: [],       // lỗi config chung
        actionParamErrors: [],  // action thiếu tham số hoặc sai
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

    // ==== Helpers ====
    function __hexToRGB(hex) {
        var h = String(hex).replace(/^#/, '');
        if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
        var r = parseInt(h.substring(0,2), 16);
        var g = parseInt(h.substring(2,4), 16);
        var b = parseInt(h.substring(4,6), 16);
        return {r:r, g:g, b:b};
    }

    function __setTextColorHex(textLayer, hex) {
        var rgb = __hexToRGB(hex);
        var c = new SolidColor();
        c.rgb.red   = rgb.r;
        c.rgb.green = rgb.g;
        c.rgb.blue  = rgb.b;
        textLayer.textItem.color = c;
    }

    // Bật/đổi Color Overlay cho layer đang active (Action Manager)
    function __setColorOverlayHex(hex, opacityPct) {
        var rgb = __hexToRGB(hex);
        var desc = new ActionDescriptor();
        var ref  = new ActionReference();
        ref.putProperty(charIDToTypeID('Prpr'), stringIDToTypeID('layerEffects'));
        ref.putEnumerated(charIDToTypeID('Lyr '), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
        desc.putReference(charIDToTypeID('null'), ref);

        var fx = new ActionDescriptor();
        var so = new ActionDescriptor();
        so.putBoolean(stringIDToTypeID('enabled'), true);
        so.putUnitDouble(stringIDToTypeID('opacity'), charIDToTypeID('#Prc'), opacityPct || 100);

        var color = new ActionDescriptor();
        color.putDouble(charIDToTypeID('Rd  '), rgb.r);
        color.putDouble(charIDToTypeID('Grn '), rgb.g);
        color.putDouble(charIDToTypeID('Bl  '), rgb.b);
        so.putObject(charIDToTypeID('Clr '), charIDToTypeID('RGBC'), color);

        fx.putObject(stringIDToTypeID('solidFill'), stringIDToTypeID('solidFill'), so);
        desc.putObject(charIDToTypeID('T   '), stringIDToTypeID('layerEffects'), fx);

        executeAction(charIDToTypeID('setd'), desc, DialogModes.NO);
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



    // ===== Special: toggle by name length for PRE-BIBLE07-PTH-THD-BCV.psd =====
    // Lấy danh sách LayerSet con theo thứ tự số (1,2,3,...) nếu tên là số;
    // nếu không parse được số thì giữ nguyên thứ tự xuất hiện
    function __getIndexedChildren(layerSet) {
        var arr = [];
        for (var i = 0; i < layerSet.layerSets.length; i++) {
            var g = layerSet.layerSets[i];
            var n = parseInt(g.name, 10);
            arr.push({
                group: g,
                order: isNaN(n) ? (100000 + i) : n // nhóm tên số sẽ xếp trước, còn lại theo thứ tự
            });
        }
        // nếu không có group con thì có thể chính các artLayer là slot — vẫn hỗ trợ luôn
        for (var j = 0; j < layerSet.artLayers.length; j++) {
            var a = layerSet.artLayers[j];
            var m = parseInt(a.name, 10);
            arr.push({
                layer: a,
                order: isNaN(m) ? (200000 + j) : m
            });
        }
        arr.sort(function(a,b){ return a.order - b.order; });
        return arr;
    }

    // Thêm tham số detailPath (chuỗi, vd: "1", "1>SO")
    // rootsAlternatives vẫn như cũ: [ ["1>1","1"] ] ...
    function __applyNameLengthVisibilityForBible07(doc, nameValue, rootsAlternatives, detailPath, alignCenter) {
        
        alignCenter = !!alignCenter;
        var clean = String(nameValue || '').replace(/\s+/g, '');
        var chars = clean.split('');
        var L = chars.length;
        __log("[PRE-BIBLE07] Name='" + nameValue + "' -> chars=" + chars.join(',') + " | length=" + L);

        var roots = (rootsAlternatives && rootsAlternatives.length) ? rootsAlternatives : [["1>1","1"]];
        var detail = __normalizeDetailPath_ES5(detailPath); // ← dùng detail_path từ action

        for (var i = 0; i < roots.length; i++) {
            var tried = roots[i];
            var doneRoot = false;

            for (var j = 0; j < tried.length && !doneRoot; j++) {
                var p = tried[j];
                var r = resolvePathFlexible(doc, p);

                if (!r.ok) {
                    __log("[PRE-BIBLE07] path fail: " + p + " | reason=" + (r.reason || ""));
                    closeSOChain(r.openedDocs || [], false);
                    continue;
                }

                var scope = r.scope;
                var type  = scope && scope.typename;
                if (type !== "LayerSet" && type !== "Document") {
                    __log("[PRE-BIBLE07] unsupported scope type=" + type + " at path=" + p);
                    closeSOChain(r.openedDocs || [], false);
                    continue;
                }

                // 1) Bật đúng L slot, có thể canh giữa nếu alignCenter = true
                var slots = __getIndexedChildren(scope);
                var totalSlots = slots.length;
                var letterCount = {}; // đếm số lần xuất hiện mỗi ký tự

                if (totalSlots === 0) {
                    closeSOChain(r.openedDocs || [], false);
                    continue;
                }

                // Tính vị trí bắt đầu nếu canh giữa
                var startIndex = 0;
                if (alignCenter && L < totalSlots) {
                    startIndex = Math.floor((totalSlots - L - 1) / 2); // ví dụ 9-5=4 -> 2 → slot 3..7
                }

                for (var s = 0; s < totalSlots; s++) {
                    var slot = slots[s].group || slots[s].layer;

                    // index tương ứng trong chuỗi ký tự
                    var charIdx = s - startIndex;
                    var visible = (charIdx >= 0 && charIdx < L);

                    slot.visible = visible;
                    if (!visible) continue;


                    // 2) Dò theo detail_path tương đối bên trong SLOT (không fallback).
                    var innerScope = slot;
                    var innerOpened = [];
                    if (detail) {
                        var rr = __resolveRelativePathFlexible(slot, detail);
                        if (rr.ok) {
                            innerScope = rr.scope;
                            innerOpened = rr.openedDocs || [];
                        } else {
                            // Ghi log + report, KHÔNG fallback
                            __log("[PRE-BIBLE07] detail_path FAIL: '" + detail + "' | slot='" + (slot.name || "?") + "' | reason=" + (rr.reason || ""));
                            __report.missingPaths.push({
                                context: "text_parse.detail_path",
                                rootPath: String(p),          // p là groupPath đang chạy
                                slotName: String(slot.name || ""),
                                detailPath: String(detail),
                                reason: String(rr.reason || "")
                            });
                            closeSOChain(rr.openedDocs || [], false);
                            // Bỏ qua slot này
                            continue;
                        }
                    }


                    // 3) Bật layer <chữ>1 hoặc <chữ>2 tuỳ lần lặp lại
                    var ch = chars[charIdx].toUpperCase();
                    letterCount[ch] = (letterCount[ch] || 0) + 1;

                    var varIdx = ((letterCount[ch] - 1) % 2) + 1; // 1,2,1,2,…
                    var targetName = ch + String(varIdx);

                    var letter1 = __findLayerAnyRecursive(innerScope, ch + "1");
                    var letter2 = __findLayerAnyRecursive(innerScope, ch + "2");

                    if (varIdx === 1) {
                        if (letter1) { try { letter1.visible = true; } catch(e){} }
                        if (letter2) { try { letter2.visible = false; } catch(e){} }
                    } else {
                        if (letter2) { try { letter2.visible = true; } catch(e){} }
                        if (letter1) { try { letter1.visible = false; } catch(e){} }
                    }

                    if (!letter1 && !letter2) {
                        var letterAny = __findLayerAnyRecursive(innerScope, targetName);
                        if (letterAny) {
                            try { letterAny.visible = true; } catch(e3){ __log("WARN cannot set visible '" + targetName + "': " + e3); }
                        } else {
                            __log("WARN: not found '" + ch + "1' or '" + ch + "2' inside slot " + slot.name);
                        }
                    }

                    __log("slot#" + (s+1) + " -> show '" + targetName + "'");

                    // đóng SO con (nếu có mở) với save=true vì ta đã thay đổi visibility
                    closeSOChain(innerOpened, true);
                }

                closeSOChain(r.openedDocs || [], true);
                doneRoot = true;
            }

            if (!doneRoot) {
                __push_unique(__report.missingGroupPaths, String(tried.join(" | ")));
            }
        }
    }


    function __findLayerAnyRecursive(scope, name) {
        // 1) thử con trực tiếp
        var g = getChildLayerSet(scope, name); if (g) return g;
        var a = getChildArtLayer(scope, name); if (a) return a;

        // 2) đi đệ quy trong các group con
        for (var i = 0; i < scope.layerSets.length; i++) {
            var r = __findLayerAnyRecursive(scope.layerSets[i], name);
            if (r) return r;
        }
        return null;
    }


    function __normalizeGroupPathAlternatives_ES5(gp) {
        // Trả về dạng: [ [ "1>1", "1" ] ]  (một mảng các phương án thử lần lượt)
        // Các trường hợp:
        //  - null/undefined           -> [["1>1","1"]] (fallback tương thích ngược)
        //  - "1>1"                    -> [["1>1"]]
        //  - "1>1 | 1"                -> [["1>1","1"]]
        //  - ["1>1","1"]              -> [["1>1","1"]]
        function __trimSafe(s){ return String(s||"").replace(/^\s+|\s+$/g,""); }

        if (gp == null) return [["1>1","1"]];

        // Nếu là array phẳng
        if (gp instanceof Array) {
            var out = [];
            for (var i=0;i<gp.length;i++){
                var it = __trimSafe(gp[i]);
                if (it) out.push(it);
            }
            if (out.length===0) out.push("1>1","1");
            return [out];
        }

        // Nếu là string: cho phép "a>b | x>y"
        var s = __trimSafe(gp);
        if (!s) return [["1>1","1"]];

        var alts = [];
        // tách theo ký tự |
        var pieces = s.split("|");
        for (var j=0;j<pieces.length;j++){
            var p = __trimSafe(pieces[j]);
            if (p) alts.push(p);
        }
        if (alts.length===0) alts.push(s);
        return [alts];
    }

    // Đi từ 1 scope (slot) theo đường dẫn tương đối (vd: "1", "1>SO", "A>B>1")
    // Tự mở Smart Object nếu gặp ArtLayer là SO.
    // Trả về: { ok, scope, openedDocs, reason }
    function __resolveRelativePathFlexible(scope, relPath) {
        var opened = [];
        function __trimSafe(s){ return String(s||"").replace(/^\s+|\s+$/g,""); }
        var s = __trimSafe(relPath || "");
        if (!s) return { ok:true, scope: scope, openedDocs: opened }; // không chỉ định -> dùng chính scope

        var parts = s.split(">");
        var cur = scope;

        for (var i=0; i<parts.length; i++) {
            var name = __trimSafe(parts[i]);
            if (!name) continue;

            // Ưu tiên group
            var g = getChildLayerSet(cur, name);
            if (g) { cur = g; continue; }

            // Không phải group -> thử ArtLayer
            var a = getChildArtLayer(cur, name);
            if (a) {
                if (isSmartObjectLayer(a)) {
                    // mở SO để đi sâu
                    try {
                        var innerDoc = openSOAndReturnDoc(a);
                        opened.push(innerDoc);
                        cur = innerDoc;
                        continue;
                    } catch (eOpen) {
                        return { ok:false, reason: "Cannot open SO '" + name + "': " + eOpen, openedDocs: opened };
                    }
                } else {
                    // Gặp ArtLayer thường thì chỉ chấp nhận nếu là node cuối
                    if (i === parts.length - 1) {
                        cur = a; // trỏ vào layer này
                        continue;
                    } else {
                        return { ok:false, reason: "ArtLayer '" + name + "' is not SO and not terminal", openedDocs: opened };
                    }
                }
            }

            return { ok:false, reason: "Not found '" + name + "' under current scope", openedDocs: opened };
        }

        return { ok:true, scope: cur, openedDocs: opened };
    }

    function __normalizeDetailPath_ES5(dp) {
        // Không còn default. Nếu không truyền -> trả về chuỗi rỗng.
        // Nếu truyền -> trim thôi.
        if (dp == null) return "";
        return String(dp).replace(/^\s+|\s+$/g, "");
    }



    ////////////////////////////
    // Main (refactored)
    ////////////////////////////
    var doc = null;

    // --- Local helpers (chỉ dùng trong Main) ---
    function loadConfigOrReport(path) {
        if (!new File(path).exists) {
            __log("CONFIG ERROR: file not found at " + path);
            __report.configErrors.push({
                code: "configFileNotFound",
                message: "Config file not found",
                path: path
            });
            __writeReportJSON(resultPath);
            return null;
        }
        var txt = readFile(path);
        __log("Config read OK (" + txt.length + " bytes)");
        var cfg = null;
        try {
            cfg = safeParseJSON(txt);
        } catch (e) {
            __log("CONFIG ERROR: parse JSON failed: " + e);
            __report.configErrors.push({
                code: "configJSONInvalid",
                message: "Config JSON invalid: " + e
            });
            __writeReportJSON(resultPath);
            return null;
        }
        if (!cfg.psdFilePath) {
            __log("CONFIG ERROR: psdFilePath missing");
            __report.configErrors.push({
                code: "psdFilePathMissing",
                message: "psdFilePath missing in config"
            });
            __writeReportJSON(resultPath);
            return null;
        }
        return cfg;
    }

    function openPSDOrReport(psdPath) {
        var f = new File(psdPath);
        if (!f.exists) {
            __log("CONFIG ERROR: PSD not found at " + psdPath);
            __report.configErrors.push({
                code: "psdFileNotFound",
                message: "PSD file not found",
                path: String(psdPath)
            });
            __writeReportJSON(resultPath);
            return null;
        }
        var d = app.open(f);
        __log("Opened PSD: " + d.name);
        return d;
    }

    // ========== Action Handlers ==========
    function handle_group_choice(ai, act) {
        if (!act.groupPath || !act.showLayer) {
            __pushParamError(ai, "group_choice", "Missing groupPath or showLayer", {
                groupPath: act.groupPath || "",
                showLayer: act.showLayer || ""
            });
            return;
        }

        var ret = resolvePathFlexible(app.activeDocument, act.groupPath);
        if (!ret.ok) {
            __log("group_choice: FAIL - " + ret.reason);
            __push_unique(__report.missingGroupPaths, String(act.groupPath));
            closeSOChain(ret.openedDocs, false);
            return;
        }

        var container = (ret.scope.typename === "LayerSet") ? ret.scope : null;
        if (!container) {
            __log("group_choice: FAIL - resolved path is not a LayerSet");
            __push_unique(__report.missingGroupPaths, String(act.groupPath));
            closeSOChain(ret.openedDocs, false);
            return;
        }

        __log("group_choice: found container '" + container.name + "'");
        setAllLayersVisibility(container, false);

        var ok = setArtLayerVisibleInGroup(container, act.showLayer);
        __log("group_choice: setArtLayerVisibleInGroup('" + act.showLayer + "') -> " + ok);

        if (!ok) {
            var f = findArtLayerByName(container, act.showLayer, true);
            if (f) {
                __log("group_choice: found showLayer recursively");
                f.visible = true;
                ok = true;
            } else {
                __log("group_choice: showLayer '" + act.showLayer + "' NOT FOUND");
            }
        }

        if (!ok) {
            __report.missingShowLayers.push({
                groupPath: String(act.groupPath),
                showLayer: String(act.showLayer)
            });
        }
        closeSOChain(ret.openedDocs, ok);
    }

    function handle_text_replace(ai, act) {
        if (!act.layerName || typeof act.text === "undefined") {
            __pushParamError(ai, "text_replace", "Missing layerName or text", {
                groupPath: act.groupPath || "",
                layerName: act.layerName || "",
                hasText: typeof act.text !== "undefined"
            });
            return;
        }

        var ret2 = resolvePathFlexible(app.activeDocument, act.groupPath || "");
        if (!ret2.ok) {
            __log("text_replace: FAIL - " + ret2.reason);
            __push_unique(__report.missingGroupPaths, String(act.groupPath || ""));
            closeSOChain(ret2.openedDocs, false);
            return;
        }

        var target = ret2.scope;
        __log("text_replace: searching for layer '" + act.layerName + "' in scope '" + (target.name || target.typename) + "'");

        var tl = findArtLayerByName(target, act.layerName, true);

        if (tl && typeof tl.textItem !== "undefined") {
            // (1) Nội dung
            __log("text_replace: found text layer, setting text to '" + act.text + "'");
            tl.textItem.contents = String(act.text);

            // (2) Font (optional)
            if (act.font) {
                var rawReq = String(act.font);

                function __fontKey(s) {
                    return String(s || "")
                        .toLowerCase()
                        .replace(/regular|roman|book|normal|medium|bold|italic/g, "")
                        .replace(/[^a-z0-9]/g, "");
                }
                function __buildFontCandidates_RegularThenBare(base) {
                    var arr = [];
                    function push(u) { for (var i = 0; i < arr.length; i++) if (arr[i] === u) return; arr.push(u); }
                    var b = String(base || '');
                    var bTrim = b.replace(/^\s+|\s+$/g, '');
                    var bNoSp = bTrim.replace(/\s+/g, '');
                    var bDash = bTrim.replace(/\s+/g, '-');
                    var bUnder = bTrim.replace(/\s+/g, '_');
                    var bLower = bTrim.toLowerCase();
                    var bLowerNo = bLower.replace(/\s+/g, '');

                    push(bTrim + '-Regular'); push(bTrim + '_Regular'); push(bTrim + 'Regular');
                    push(bNoSp + '-Regular'); push(bNoSp + '_Regular'); push(bNoSp + 'Regular');
                    push(bDash + '-Regular');  push(bUnder + '_Regular');
                    push(bLower + '-regular'); push(bLower + '_regular'); push(bLower + 'regular');
                    push(bLowerNo + '-regular'); push(bLowerNo + '_regular'); push(bLowerNo + 'regular');

                    // Bare
                    push(bTrim); push(bNoSp); push(bDash); push(bUnder); push(bLower); push(bLowerNo);

                    // “double”
                    push(bUnder + '_Regular'); push(bUnder + '-Regular');
                    return arr;
                }
                var baseKey = __fontKey(rawReq);
                function __tryApplyFont(layer, cand) {
                    try { layer.textItem.font = cand; }
                    catch (e) { return { ok: false, applied: "", reason: "throw:" + e }; }
                    var applied = String(layer.textItem.font || "");
                    var appliedKey = __fontKey(applied);
                    var ok = (appliedKey === baseKey) || (appliedKey.indexOf(baseKey) !== -1);
                    return { ok: ok, applied: applied, reason: ok ? "verified" : ("mismatch:" + applied) };
                }

                var tried = [], okFont = null;
                var cands = __buildFontCandidates_RegularThenBare(rawReq);
                __log("text_replace: font candidates order -> " + cands.join(' | '));
                for (var ci = 0; ci < cands.length; ci++) {
                    var cand = cands[ci];
                    var r = __tryApplyFont(tl, cand);
                    if (r.ok) { __log("text_replace: set font OK -> " + cand + " (applied: " + r.applied + ")"); okFont = r.applied || cand; break; }
                    else tried.push(cand + " [" + r.reason + "]");
                }
                if (!okFont) {
                    __log("text_replace: set font FAIL. Tried: " + tried.join(', '));
                    __pushParamError(ai, "text_replace", "Cannot resolve font name", { requested: rawReq });
                }
            }

            // (3) Color (optional)
            if (act.color) {
                var hex = String(act.color);
                var mode = (typeof act.apply === "undefined") ? "text" : String(act.apply);
                try {
                    if (mode === "text" || mode === "both") {
                        __setTextColorHex(tl, hex);
                        __log("text_replace: set text color -> " + hex);
                    }
                } catch (e1) { __log("text_replace: WARN cannot set text color: " + e1); }

                try {
                    if (mode === "overlay" || mode === "both" || mode === "true") {
                        app.activeDocument.activeLayer = tl;
                        __setColorOverlayHex(hex, 100);
                        __log("text_replace: set Color Overlay -> " + hex);
                    }
                } catch (e2) { __log("text_replace: WARN cannot set Color Overlay: " + e2); }
            }

            closeSOChain(ret2.openedDocs, true);
        } else {
            __log("text_replace: text layer '" + act.layerName + "' NOT FOUND or not text");
            __report.missingTextTargets.push({
                groupPath: String(act.groupPath || ""),
                layerName: String(act.layerName)
            });
            closeSOChain(ret2.openedDocs, false);
        }
    }

    function handle_text_parse(ai, act) {
        var val = (typeof act.value === "string") ? act.value : "";
        if (!val || !val.replace(/\s+/g, '')) {
            __pushParamError(ai, "text_parse", "Missing or empty value", { value: val });
            return;
        }
        var roots = __normalizeGroupPathAlternatives_ES5(act.groupPath);
        var detail = (typeof act.detail_path === "string") ? act.detail_path : null;
        var alignCenter = !!act.align_center; // NEW

        try {
            __applyNameLengthVisibilityForBible07(app.activeDocument, val, roots, detail, alignCenter);
        } catch (e) {
            __pushParamError(ai, "text_parse", "apply PRE-BIBLE07 failed", { error: String(e) });
        }
    }


    function handle_visibility(ai, act) {
        if (!act.path || typeof act.visible === "undefined") {
            __pushParamError(ai, "visibility", "Missing path or visible", {
                path: act.path || "",
                hasVisible: typeof act.visible !== "undefined"
            });
            return;
        }
        var parts = toParts(act.path);
        if (parts.length === 0) {
            __pushParamError(ai, "visibility", "Empty path", { path: act.path });
            return;
        }
        var parentPath = parts.slice(0, parts.length - 1).join(">");
        var last = parts[parts.length - 1];

        __log("visibility: parentPath='" + parentPath + "' | last='" + last + "'");

        var ret3 = resolvePathFlexible(app.activeDocument, parentPath);
        if (!ret3.ok) {
            __log("visibility: FAIL - " + ret3.reason);
            __push_unique(__report.missingPaths, String(act.path));
            closeSOChain(ret3.openedDocs, false);
            return;
        }
        var cont = ret3.scope;
        var tgt = getChildLayerSet(cont, last) || getChildArtLayer(cont, last);

        if (tgt) {
            __log("visibility: found target '" + last + "', setting visible=" + act.visible);
            tgt.visible = !!act.visible;
            closeSOChain(ret3.openedDocs, true);
        } else {
            __log("visibility: target '" + last + "' NOT FOUND");
            __push_unique(__report.missingPaths, String(act.path));
            closeSOChain(ret3.openedDocs, false);
        }
    }

    function handle_smart_edit_contents(ai, act) {
        var soPath = act.smartLayerPath || act.smartLayerName;
        if (!soPath || !act.inner || !(act.inner instanceof Array)) {
            __pushParamError(ai, "smart_edit_contents", "Missing smartLayerPath/smartLayerName or inner array", {
                hasPath: !!soPath,
                hasInner: !!(act.inner),
                isArray: act.inner instanceof Array
            });
            return;
        }

        var ret4 = resolvePathFlexible(app.activeDocument, soPath);
        if (!ret4.ok || !ret4.lastArtLayer || !isSmartObjectLayer(ret4.lastArtLayer)) {
            __log("smart_edit_contents: FAIL - " + (ret4.reason || "not SO"));
            __push_unique(__report.missingPaths, String(soPath));
            closeSOChain(ret4.openedDocs, false);
            return;
        }

        __log("smart_edit_contents: opening SO at '" + soPath + "'");
        var innerDoc = openSOAndReturnDoc(ret4.lastArtLayer);

        // Ở đây chỉ log như bản gốc; nếu muốn đầy đủ có thể đệ quy dispatcher.
        __log("smart_edit_contents: running " + act.inner.length + " inner actions");

        try { innerDoc.save(); __log("smart_edit_contents: inner doc saved"); }
        catch (e) { __log("smart_edit_contents: save error - " + e); }

        try { innerDoc.close(SaveOptions.SAVECHANGES); __log("smart_edit_contents: inner doc closed"); }
        catch (e2) { __log("smart_edit_contents: close error - " + e2); }

        closeSOChain(ret4.openedDocs, true);
    }

    function dispatchAction(ai, act) {
        if (!act || !act.type) { __log("Action[" + ai + "]: invalid/empty"); return; }
        var t = act.type;
        __log("Action[" + ai + "] type=" + t + " | groupPath=" + (act.groupPath || "") + " | path=" + (act.path || ""));

        switch (t) {
            case "group_choice":         return handle_group_choice(ai, act);
            case "text_replace":         return handle_text_replace(ai, act);
            case "text_parse":           return handle_text_parse(ai, act);
            case "visibility":           return handle_visibility(ai, act);
            case "smart_edit_contents":  return handle_smart_edit_contents(ai, act);
            default:
                __log("Action[" + ai + "]: UNKNOWN type '" + t + "'");
                __pushParamError(ai, t, "Unknown action type", null);
        }
    }

    function exportOutput(cfg, psdFile, docRef) {
        var outFolder = new Folder(cfg.outputFolder || (Folder.myDocuments.fsName + "/psd_export"));
        if (!outFolder.exists) { outFolder.create(); __log("Created output folder: " + outFolder.fsName); }

        var outFormat = (cfg.outputFormat ? String(cfg.outputFormat) : "jpg").toLowerCase();
        if (outFormat === "jpeg") outFormat = "jpg";

        var outName = cfg.outputFilename;
        if (!outName || outName === "") {
            if (outFormat === "png") outName = psdFile.name.replace(/\.[^\.]+$/, "") + "_export.png";
            else outName = psdFile.name.replace(/\.[^\.]+$/, "") + "_export.jpg";
        }
        var outFile = new File(outFolder.fsName + "/" + outName);

        if (outFormat === "png") {
            var pngOpt = new PNGSaveOptions();
            __log("Exporting PNG -> " + outFile.fsName);
            docRef.saveAs(outFile, pngOpt, true, Extension.LOWERCASE);
            __log("Export PNG OK: " + outFile.fsName);
        } else {
            var jpgQ = (typeof cfg.jpgQuality === "number")
                ? Math.min(12, Math.max(0, Math.round(cfg.jpgQuality)))
                : 12;

            var jpgOpt = new JPEGSaveOptions();
            jpgOpt.quality = jpgQ;
            jpgOpt.embedColorProfile = true;
            jpgOpt.formatOptions = FormatOptions.STANDARDBASELINE;
            jpgOpt.matte = MatteType.NONE;

            __log("Exporting JPG -> " + outFile.fsName + " | quality=" + jpgQ);
            docRef.saveAs(outFile, jpgOpt, true, Extension.LOWERCASE);
            __log("Export JPG OK: " + outFile.fsName);
        }
    }

    // ========== Chạy Main ==========
    try {
        var cfg = loadConfigOrReport(configPath);
        if (!cfg) { return; }

        var psdFile = new File(cfg.psdFilePath);
        doc = openPSDOrReport(psdFile.fsName);
        if (!doc) { return; }

        var acts = cfg.actions || [];
        __log("Actions count: " + acts.length);

        for (var ai = 0; ai < acts.length; ai++) {
            dispatchAction(ai, acts[ai]);
        }

        exportOutput(cfg, psdFile, doc);

    } catch (eMain) {
        __log("TOP-LEVEL ERROR: " + eMain);
        __report.configErrors.push({
            code: "unexpectedError",
            message: String(eMain)
        });
    } finally {
        try {
            __writeReportJSON(resultPath);
        } catch (eWR) {
            __log("Final report write error: " + eWR);
        }

        try {
            if (doc) {
                doc.close(SaveOptions.DONOTSAVECHANGES);
                __log("Closed main doc (DONOTSAVECHANGES)");
            }
        } catch (eC) {
            __log("Doc close error: " + eC);
        }

        __log("=== END ===");
    }

    
})();