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


    // ===== Smart font helpers =====
    function __uniquePush(arr, v){ for (var i=0;i<arr.length;i++) if (arr[i]===v) return; arr.push(v); }

    function __buildFontCandidates(userFont) {
        var base = String(userFont || '').trim();
        var cands = [];
        if (!base) return cands;

        var baseNoSpace = base.replace(/\s+/g, '');
        var baseDash    = base.replace(/\s+/g, '-');
        var baseUnder   = base.replace(/\s+/g, '_');
        var baseLow     = base.toLowerCase();

        // chính xác & dạng đơn giản
        __uniquePush(cands, base);
        __uniquePush(cands, baseNoSpace);
        __uniquePush(cands, baseDash);
        __uniquePush(cands, baseUnder);
        __uniquePush(cands, baseLow);
        __uniquePush(cands, baseLow.replace(/\s+/g, ''));

        var styles = ['Regular', 'Roman', 'Book', 'Normal', 'Medium'];
        for (var i=0; i<styles.length; i++) {
            var st = styles[i];

            var suffixes = [
                '-' + st,
                '_' + st,
                ' ' + st,
                '-' + st.toLowerCase(),
                '_' + st.toLowerCase()
            ];

            for (var j=0; j<suffixes.length; j++) {
                var suf = suffixes[j];
                __uniquePush(cands, base + suf);
                __uniquePush(cands, baseNoSpace + suf);
                __uniquePush(cands, baseDash + suf);
                __uniquePush(cands, baseUnder + suf);

                // Thêm kiểu double (Acme_Regular-Regular)
                __uniquePush(cands, baseUnder + '_Regular');
                __uniquePush(cands, baseUnder + '-Regular');
            }
        }

        // fallback cuối: kiểu PS name liền mạch
        __uniquePush(cands, baseNoSpace + 'Regular');
        __uniquePush(cands, baseNoSpace + '-Regular');
        __uniquePush(cands, baseNoSpace + '_Regular');

        return cands;
    }


    function __setFontSmart(textLayer, userFont, logPrefix) {
        var tried = [];
        var cands = __buildFontCandidates(userFont);

        for (var i=0; i<cands.length; i++) {
            var cand = cands[i];
            try {
                textLayer.textItem.font = cand; // Photoshop sẽ throw nếu tên không hợp lệ
                __log((logPrefix||'') + "set font OK -> " + cand);
                return cand; // thành công
            } catch (e) {
                tried.push(cand);
            }
        }
        __log((logPrefix||'') + "set font FAIL. Tried: " + tried.join(', '));
        return null; // không đặt được
    }

    function __injectRegularSuffixIfBare(name){
        // 1) bỏ hết khoảng trắng trước
        var s = __stripSpaces(String(name || ''));
        if (!s) return s;

        // 2) nếu đã có style ở cuối thì giữ nguyên
        if (/(Regular|Roman|Book|Normal|Medium|Bold|Italic)$/i.test(s)) return s;

        // 3) nếu đã có dấu '-' (tức đã có hậu tố/biến thể gì đó) thì giữ nguyên
        if (/-/.test(s)) return s;

        // 4) mặc định ép thêm -Regular
        return s + '-Regular';
    }

    function __stripSpaces(s){
        return String(s||'').replace(/\s+/g, '');
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
            else if (t === "text_replace") {
                if (!act.layerName || typeof act.text === "undefined") {
                    __pushParamError(ai, t, "Missing layerName or text", {
                        groupPath: act.groupPath || "",
                        layerName: act.layerName || "",
                        hasText: typeof act.text !== "undefined"
                    });
                    continue;
                }

                var ret2 = resolvePathFlexible(app.activeDocument, act.groupPath || "");
                if (!ret2.ok) {
                    __log("text_replace: FAIL - " + ret2.reason);
                    __push_unique(__report.missingGroupPaths, String(act.groupPath || ""));
                    closeSOChain(ret2.openedDocs, false);
                    continue;
                }

                var target = ret2.scope;
                __log("text_replace: searching for layer '" + act.layerName + "' in scope '" + target.name + "'");

                var tl = findArtLayerByName(target, act.layerName, true);

                if (tl && typeof tl.textItem !== "undefined") {
                    // 1) Đổi nội dung
                    __log("text_replace: found text layer, setting text to '" + act.text + "'");
                    tl.textItem.contents = String(act.text);

                    // 2) (Optional) Đổi font nếu có
                    if (act.font) {
                        var rawReq = String(act.font);

                        // Chuẩn hoá tên để so family: bỏ khoảng trắng / gạch / ký tự không chữ số
                        function __fontKey(s){
                            return String(s || "")
                                .toLowerCase()
                                .replace(/regular|roman|book|normal|medium|bold|italic/g, "") // bỏ style từ khoá
                                .replace(/[^a-z0-9]/g, ""); // bỏ mọi thứ còn lại
                        }

                        // Build candidates: ƯU TIÊN -Regular trước, sau đó tới bare
                        function __buildFontCandidates_RegularThenBare(base) {
                            var arr = [];
                            function push(u){ for (var i=0;i<arr.length;i++) if (arr[i]===u) return; arr.push(u); }

                            var b       = String(base || '');
                            var bTrim   = b.replace(/^\s+|\s+$/g,'');
                            var bNoSp   = bTrim.replace(/\s+/g,'');
                            var bDash   = bTrim.replace(/\s+/g,'-');
                            var bUnder  = bTrim.replace(/\s+/g,'_');
                            var bLower  = bTrim.toLowerCase();
                            var bLowerNo= bLower.replace(/\s+/g,'');

                            // 1) Regular-first (đủ biến thể)
                            push(bTrim + '-Regular');
                            push(bTrim + '_Regular');
                            push(bTrim + 'Regular');

                            push(bNoSp + '-Regular');
                            push(bNoSp + '_Regular');
                            push(bNoSp + 'Regular');

                            push(bDash + '-Regular');
                            push(bUnder + '_Regular');

                            push(bLower + '-regular');
                            push(bLower + '_regular');
                            push(bLower + 'regular');

                            push(bLowerNo + '-regular');
                            push(bLowerNo + '_regular');
                            push(bLowerNo + 'regular');

                            // 2) Bare (không hậu tố)
                            push(bTrim);
                            push(bNoSp);
                            push(bDash);
                            push(bUnder);
                            push(bLower);
                            push(bLowerNo);

                            // 3) “double” hay gặp (để cuối cùng)
                            push(bUnder + '_Regular');
                            push(bUnder + '-Regular');

                            return arr;
                        }

                        // So khớp family: applied phải “giống gốc” sau khi bỏ style/hyphen/space
                        var baseKey = __fontKey(rawReq);

                        function __tryApplyFont(layer, cand) {
                            try {
                                layer.textItem.font = cand; // có thể "set được" nhưng bị map
                            } catch(e) {
                                return { ok:false, applied:"", reason:"throw:"+e };
                            }
                            var applied = String(layer.textItem.font || "");
                            var appliedKey = __fontKey(applied);

                            // Chấp nhận khi appliedKey chứa baseKey hoặc khớp hoàn toàn.
                            // (Dùng contains để cover case PS name thêm foundry prefix/suffix nhẹ.)
                            var ok = (appliedKey === baseKey) || (appliedKey.indexOf(baseKey) !== -1);

                            return { ok: ok, applied: applied, reason: ok ? "verified" : ("mismatch:"+applied) };
                        }

                        var tried = [], okFont = null;
                        var cands = __buildFontCandidates_RegularThenBare(rawReq);

                        __log("text_replace: font candidates order -> " + cands.join(' | '));

                        for (var ci=0; ci<cands.length; ci++){
                            var cand = cands[ci];
                            var r = __tryApplyFont(tl, cand);
                            if (r.ok) {
                                __log("text_replace: set font OK -> " + cand + " (applied: " + r.applied + ")");
                                okFont = r.applied || cand;
                                break;
                            } else {
                                tried.push(cand + " [" + r.reason + "]");
                            }
                        }

                        if (!okFont) {
                            __log("text_replace: set font FAIL. Tried: " + tried.join(', '));
                            __pushParamError(ai, t, "Cannot resolve font name", { requested: rawReq });
                        }
                    }




                    // 3) (Optional) Đổi màu
                    //    - luôn set text color (an toàn)
                    //    - và mặc định set Color Overlay (designer hay dùng FX). Có thể điều khiển qua act.apply:
                    //        + "overlay" hoặc true  => chỉ/ưu tiên overlay
                    //        + "text"               => chỉ đổi text color
                    //        + undefined            => set cả text color và overlay
                    if (act.color) {
                        var hex = String(act.color);
                        var mode = (typeof act.apply === "undefined") ? "both" : String(act.apply);

                        try {
                            if (mode === "text" || mode === "both") {
                                __setTextColorHex(tl, hex);
                                __log("text_replace: set text color -> " + hex);
                            }
                        } catch (e1) {
                            __log("text_replace: WARN cannot set text color: " + e1);
                        }

                        try {
                            if (mode === "overlay" || mode === "both" || mode === "true") {
                                app.activeDocument.activeLayer = tl; // target layer
                                __setColorOverlayHex(hex, 100);
                                __log("text_replace: set Color Overlay -> " + hex);
                            }
                        } catch (e2) {
                            __log("text_replace: WARN cannot set Color Overlay: " + e2);
                        }
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

                // ===== Export (JPG / PNG tùy config) =====
        var outFolder = new Folder(cfg.outputFolder || (Folder.myDocuments.fsName + "/psd_export"));
        if (!outFolder.exists) {
            outFolder.create();
            __log("Created output folder: " + outFolder.fsName);
        }

        // NEW: đọc format từ config, mặc định jpg
        var outFormat = (cfg.outputFormat ? String(cfg.outputFormat) : "jpg").toLowerCase();
        if (outFormat === "jpeg") outFormat = "jpg";

        // tên file xuất
        var outName = cfg.outputFilename;
        if (!outName || outName === "") {
            // nếu không gửi sẵn tên thì tự build
            if (outFormat === "png") {
                outName = psdFile.name.replace(/\.[^\.]+$/, "") + "_export.png";
            } else {
                outName = psdFile.name.replace(/\.[^\.]+$/, "") + "_export.jpg";
            }
        }

        var outFile = new File(outFolder.fsName + "/" + outName);

        if (outFormat === "png") {
            // ---- PNG ----
            var pngOpt = new PNGSaveOptions();
            __log("Exporting PNG -> " + outFile.fsName);
            doc.saveAs(outFile, pngOpt, true, Extension.LOWERCASE);
            __log("Export PNG OK: " + outFile.fsName);
        } else {
            // ---- JPG (mặc định) ----
            var jpgQ = (typeof cfg.jpgQuality === "number")
                ? Math.min(12, Math.max(0, Math.round(cfg.jpgQuality)))
                : 12;

            var jpgOpt = new JPEGSaveOptions();
            jpgOpt.quality = jpgQ;
            jpgOpt.embedColorProfile = true;
            jpgOpt.formatOptions = FormatOptions.STANDARDBASELINE;
            jpgOpt.matte = MatteType.NONE;

            __log("Exporting JPG -> " + outFile.fsName + " | quality=" + jpgQ);
            doc.saveAs(outFile, jpgOpt, true, Extension.LOWERCASE);
            __log("Export JPG OK: " + outFile.fsName);
        }

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