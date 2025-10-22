// ps_utils.jsx — helper utilities for Photoshop ExtendScript (JSX)
// Lưu ý: KHÔNG dùng #target ở file phụ để tránh ảnh hưởng môi trường của file main.

var Utils = (function () {
    // ---- private logger (no-op mặc định) ----
    var _log = function(){};

    // Cho phép file main truyền logger vào
    function setLogger(fn){
        if (typeof fn === "function") _log = fn;
    }

    // ---- JSON helpers ----
    function safeParseJSON(s) {
        if (typeof JSON !== "undefined" && typeof JSON.parse === "function") return JSON.parse(s);
        if (s && s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
        return eval('(' + s + ')');
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

    // ---- File & string helpers ----
    function toParts(path) {
        if (!path) return [];
        var s = String(path);
        if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
        var arr = s.split(">");
        for (var i = 0; i < arr.length; i++) arr[i] = arr[i].replace(/^\s+|\s+$/g, "");
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

    function pushUnique(arr, val){
        for (var i=0;i<arr.length;i++) if (arr[i]===val) return;
        arr.push(val);
    }

    // ---- Layer/doc helpers ----
    function isSmartObjectLayer(layer){
        try { return layer.kind === LayerKind.SMARTOBJECT; } catch(e) {}
        return false;
    }

    function getChildLayerSet(container, name){
        try {
            for (var i=0;i<container.layerSets.length;i++)
                if (container.layerSets[i].name === name)
                    return container.layerSets[i];
        } catch(e){}
        return null;
    }

    function getChildArtLayer(container, name){
        try {
            for (var i=0;i<container.artLayers.length;i++)
                if (container.artLayers[i].name === name)
                    return container.artLayers[i];
        } catch(e){}
        return null;
    }

    function findArtLayerByName(container, name, recursive){
        try {
            for (var i=0;i<container.artLayers.length;i++)
                if (container.artLayers[i].name === name)
                    return container.artLayers[i];
            if (recursive){
                for (var j=0;j<container.layerSets.length;j++){
                    var r = arguments.callee(container.layerSets[j], name, true);
                    if (r) return r;
                }
            }
        } catch(e){}
        return null;
    }

    function setAllLayersVisibility(container, visible){
        try {
            for (var i=0;i<container.artLayers.length;i++)
                container.artLayers[i].visible = visible;
            for (var j=0;j<container.layerSets.length;j++){
                container.layerSets[j].visible = visible;
                setAllLayersVisibility(container.layerSets[j], visible);
            }
        } catch(e){}
    }

    function setArtLayerVisibleInGroup(group, name){
        try {
            for (var i=0;i<group.artLayers.length;i++)
                if (group.artLayers[i].name === name){
                    group.artLayers[i].visible = true;
                    return true;
                }
        } catch(e){}
        return false;
    }

    function openSOAndReturnDoc(soLayer){
        app.activeDocument.activeLayer = soLayer;
        var id = stringIDToTypeID("placedLayerEditContents");
        executeAction(id, new ActionDescriptor(), DialogModes.ALL);
        return app.activeDocument;
    }

    function closeSOChain(openedDocs, changed){
        for (var i = openedDocs.length - 1; i >= 0; i--){
            try {
                if (changed) openedDocs[i].save();
            } catch(e){ _log("SO save error: " + e); }
            try {
                openedDocs[i].close(changed ? SaveOptions.SAVECHANGES : SaveOptions.DONOTSAVECHANGES);
            } catch(e){ _log("SO close error: " + e); }
        }
    }

    // ---- public API ----
    return {
        setLogger: setLogger,
        safeParseJSON: safeParseJSON,
        safeStringify: safeStringify,
        toParts: toParts,
        readFile: readFile,
        pushUnique: pushUnique,

        isSmartObjectLayer: isSmartObjectLayer,
        getChildLayerSet: getChildLayerSet,
        getChildArtLayer: getChildArtLayer,
        findArtLayerByName: findArtLayerByName,
        setAllLayersVisibility: setAllLayersVisibility,
        setArtLayerVisibleInGroup: setArtLayerVisibleInGroup,
        openSOAndReturnDoc: openSOAndReturnDoc,
        closeSOChain: closeSOChain
    };
})();
