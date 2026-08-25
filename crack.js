const asarMod = require("asar");
const fs = require("fs");
const path = require("path");
const {execSync} = require("child_process");
const {flipFuses, FuseV1Options, FuseVersion} = require("@electron/fuses");

// 控制台 UTF-8（修复中文乱码）
if (process.platform === "win32") {
    try {
        execSync("chcp 65001 >nul", {stdio: "ignore"});
    } catch (e) {
    }
}

// ========== 查找 Typora 安装路径 ==========

function findFromRegistry() {
    var roots = [
        "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ];
    for (var i = 0; i < roots.length; i++) {
        try {
            // 第1步：用关键词搜索，定位到子项路径（HKEY_ 开头的行）
            var out = execSync(
                'reg query "' + roots[i] + '" /s /f Typora',
                {encoding: "utf-8", timeout: 10000}
            );
            var subKeys = out.split(/\r?\n/)
                .map(function (s) {
                    return s.trim()
                })
                .filter(function (s) {
                    return /^HKEY_/i.test(s)
                });
            // 第2步：对每个匹配的子项，读取全部值，找 InstallLocation
            for (var j = 0; j < subKeys.length; j++) {
                try {
                    var detail = execSync(
                        'reg query "' + subKeys[j] + '"',
                        {encoding: "utf-8", timeout: 5000}
                    );
                    var m = detail.match(/InstallLocation\s+REG_SZ\s+(.+)/i);
                    if (m) {
                        var p = m[1].trim().replace(/\\/g, "/");
                        // 去掉末尾斜杠
                        p = p.replace(/\/+$/, "");
                        if (fs.existsSync(path.join(p, "Typora.exe"))) return p;
                    }
                } catch (e2) {
                }
            }
        } catch (e) {
        }
    }
    return null;
}

function findFromShortcut() {
    var os = require("os");
    var searchDirs = [
        path.join(os.homedir(), "Desktop"),
        "C:/Users/Public/Desktop",
        path.join(os.homedir(), "AppData/Roaming/Microsoft/Windows/Start Menu/Programs"),
        "C:/ProgramData/Microsoft/Windows/Start Menu/Programs",
    ];

    // 递归收集所有 .lnk
    function listLnk(dir) {
        var out = [];
        try {
            var stack = [dir];
            while (stack.length) {
                var cur = stack.pop();
                var entries;
                try {
                    entries = fs.readdirSync(cur, {withFileTypes: true});
                } catch (e) {
                    continue;
                }
                for (var i = 0; i < entries.length; i++) {
                    var full = path.join(cur, entries[i].name);
                    if (entries[i].isDirectory()) {
                        if (entries[i].name === "Internet Explorer") continue; // 跳过慢目录
                        stack.push(full);
                    } else if (entries[i].name.toLowerCase().endsWith(".lnk")) {
                        out.push(full);
                    }
                }
            }
        } catch (e) {
        }
        return out;
    }

    // 用 PowerShell 解析单个 .lnk（单文件调用，避免引号嵌套）
    function resolveLnk(lnkPath) {
        // Base64 编码命令，彻底避开引号/空格问题
        // -NoProfile -ExecutionPolicy Bypass 跳过首次加载；重定向 6>$null 抑制 CLIXML 进度噪音
        var cmd = '$ErrorActionPreference="SilentlyContinue"; $ProgressPreference="SilentlyContinue"; $ws=New-Object -ComObject WScript.Shell; $ws.CreateShortcut("' + lnkPath.replace(/"/g, '`"') + '").TargetPath';
        var b64 = Buffer.from(cmd, "utf16le").toString("base64");
        try {
            var out = execSync('powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + b64 + ' 6>$null', {
                encoding: "utf-8",
                timeout: 5000
            });
            var t = out.trim();
            if (t) return t;
        } catch (e) {
        }
        return null;
    }

    var lnkFiles = [];
    for (var i = 0; i < searchDirs.length; i++) {
        if (fs.existsSync(searchDirs[i])) {
            lnkFiles = lnkFiles.concat(listLnk(searchDirs[i]));
        }
    }
    for (var j = 0; j < lnkFiles.length; j++) {
        // 先按文件名快速过滤
        if (!/typora/i.test(path.basename(lnkFiles[j], ".lnk"))) continue;
        var target = resolveLnk(lnkFiles[j]);
        if (target && /Typora\.exe$/i.test(target) && fs.existsSync(target)) {
            return {lnk: lnkFiles[j], dir: path.dirname(target)};
        }
    }
    return null;
}

function resolvePath(input) {
    input = input.trim().replace(/"/g, "").replace(/\\/g, "/");
    if (!fs.existsSync(input)) return null;
    var stat = fs.statSync(input);
    if (stat.isDirectory()) {
        if (fs.existsSync(path.join(input, "Typora.exe"))) return input;
        return null;
    }
    if (stat.isFile() && input.toLowerCase().endsWith(".exe")) {
        return path.dirname(input);
    }
    return null;
}

function launch(cliPath) {
    // 1. 命令行参数
    if (cliPath) {
        var r = resolvePath(cliPath);
        if (r) {
            console.log("Typora 安装路径: " + r + "  【命令行参数】");
            start(r);
            return;
        }
    }
    // 2. 注册表
    var reg = findFromRegistry();
    if (reg) {
        console.log("Typora 安装路径: " + reg + "  【注册表】");
        start(reg);
        return;
    }
    // 3. 桌面快捷方式
    var sc = findFromShortcut();
    if (sc) {
        console.log("Typora 安装路径: " + sc.dir + "  【桌面快捷方式】");
        start(sc.dir);
        return;
    }
    // 4. 手动输入
    console.log("未自动找到 Typora，请手动输入路径。");
    console.log("支持: 安装目录 (D:/software/Typora) 或 exe 路径");
    var rl = require("readline").createInterface({input: process.stdin, output: process.stdout});
    rl.question("路径: ", function (input) {
        rl.close();
        var resolved = resolvePath(input);
        if (!resolved) {
            console.error("无效路径，未找到 Typora.exe");
            process.exit(1);
        }
        console.log("Typora 路径: " + resolved);
        start(resolved);
    });
}

launch(process.argv[2]);

// ========== 主流程 ==========

async function start(typoraPath) {
    var RESOURCES = path.join(typoraPath, "resources");
    var ASAR_PATH = path.join(RESOURCES, "app.asar");
    var APP_DIR = path.join(RESOURCES, "app");
    var APP_BAK_DIR = path.join(RESOURCES, "app.bak");
    var EXE_PATH = path.join(typoraPath, "Typora.exe");
    var LAUNCH_JS = path.join(APP_DIR, "launch.dist.js");

    var now = new Date();
    var dateStr = [
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
        now.getFullYear(),
    ].join("/");

    console.log("=== 初始化 ===");

    // 备份 exe
    if (!fs.existsSync(EXE_PATH + ".bak")) {
        fs.copyFileSync(EXE_PATH, EXE_PATH + ".bak");
        console.log("Typora.exe → .bak");
    }
    // 备份 asar
    if (!fs.existsSync(ASAR_PATH + ".bak") && fs.existsSync(ASAR_PATH)) {
        fs.copyFileSync(ASAR_PATH, ASAR_PATH + ".bak");
        console.log("app.asar → .bak");
    }
    // 解压 asar
    if (fs.existsSync(ASAR_PATH)) {
        try {
            fs.rmSync(APP_DIR, {recursive: true, force: true});
        } catch (e) {
        }
        asarMod.extractAll(ASAR_PATH, APP_DIR);
        console.log("asar → app/");
    }
    // 复制原始文件
    if (!fs.existsSync(APP_BAK_DIR)) {
        (function copyDir(s, d) {
            if (!fs.existsSync(d)) fs.mkdirSync(d, {recursive: true});
            var entries = fs.readdirSync(s, {withFileTypes: true});
            for (var i = 0; i < entries.length; i++) {
                var sp = path.join(s, entries[i].name);
                var dp = path.join(d, entries[i].name);
                entries[i].isDirectory() ? copyDir(sp, dp) : fs.copyFileSync(sp, dp);
            }
        })(APP_DIR, APP_BAK_DIR);
        console.log("app/ → app.bak/");
    }
    // 删除 app.asar
    if (fs.existsSync(ASAR_PATH)) {
        fs.rmSync(ASAR_PATH, {force: true});
        console.log("app.asar 已删除");
    }
    // flipFuses
    try {
        await flipFuses(EXE_PATH, {
            version: FuseVersion.V1,
            [FuseV1Options.OnlyLoadAppFromAsar]: false,
        });
        console.log("Fuse 已修改");
    } catch (e) {
        if (e.code === "EBUSY") {
            console.error("Typora.exe 被占用，请先关闭所有 Typora 进程再运行。");
            process.exit(1);
        }
        throw e;
    }

    // ========== 版本检查 ==========
    var version = "unknown";
    try {
        // 从刚解压的 app/package.json 读取
        var pkgPath = path.join(APP_DIR, "package.json");
        var pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        version = pkg.version;
    } catch (e) {
    }
    console.log("Typora 版本: " + version);
    if (version !== "1.13.7") {
        console.log("警告: 仅 1.13.7 验证通过，其他版本可能不兼容，继续执行...");
    }

    // ========== Hook 注入 ==========
    var hookCode = `
        var hookFs=require("fs"),hookCp=require("child_process"),hookOs=require("os");
        var DEBUG_LOG=false;
        var LOG="${typoraPath.replace(/\\/g, "\\\\")}\\\\typora.log";
        function W(){if(!DEBUG_LOG)return;var a=arguments;try{hookFs.appendFileSync(LOG,"["+new Date().toISOString()+"] "+Array.prototype.slice.call(a).join(" ")+"\\n")}catch(e){}}
        
        W("========== Hook 启动 ==========");
        
        // -- 0. 写入 SLicense（抢在字节码检查注册表之前） --
        W("[REG] 写入 SLicense...");
        try{
            hookCp.execSync('reg add "HKCU\\\\Software\\\\Typora" /v SLicense /t REG_SZ /d "VHlwb3Jh#0#12/31/2099" /f',{encoding:"utf-8",timeout:5000});
            W("[REG] SLicense 写入完成");
        }catch(e){W("[REG] SLicense 写入失败:",e.message)}
        
        // -- 1. 读取机器码缓存 --
        var cachedMC=null;
        W("[MC] 读取机器码缓存...");
        try{
            var o=hookCp.execSync('reg query "HKCU\\\\Software\\\\Typora" /v MCInfo',{encoding:"utf-8",timeout:5000});
            var m=o.match(/MCInfo\\s+REG_SZ\\s+(.+)/i);
            if(m){
                cachedMC=JSON.parse(Buffer.from(m[1].trim(),"base64").toString("utf-8"));
                W("[MC] 缓存命中, fingerprint="+cachedMC.i);
            }
        }catch(e){W("[MC] 缓存未命中 (首次运行)")}
        
        // -- 2. fs 路径重定向 --
        var redirectFrom=/resources[\\\\/]app[\\\\/]/i,redirectTo="resources\\\\app.bak\\\\";
        var hookedCount=0;
        [hookFs].forEach(function(fsMod){
            ["readFileSync","readFile","statSync","stat","open","openSync","existsSync","exists","lstatSync","lstat","readdirSync","readdir","accessSync","access","realpathSync","realpath"].forEach(function(p){
                if(typeof fsMod[p]==="function"){var origFn=fsMod[p];fsMod[p]=function(fp){if(typeof fp==="string"&&redirectFrom.test(fp))fp=fp.replace(redirectFrom,redirectTo);return origFn.apply(this,arguments)};hookedCount++}
            });
            if(fsMod.promises){["readFile","open","stat","access","lstat","readdir","realpath"].forEach(function(p){
                if(typeof fsMod.promises[p]==="function"){var origP=fsMod.promises[p];fsMod.promises[p]=function(fp){if(typeof fp==="string"&&redirectFrom.test(fp))fp=fp.replace(redirectFrom,redirectTo);return origP.apply(this,arguments)};hookedCount++}
            })}
        });
        W("[HOOK] fs 重定向已安装 (函数数="+hookedCount+")");
        
        // -- 3. 机器码自动捕获 --
        var electron=require("electron"),origHandle=electron.ipcMain.handle;
        electron.ipcMain.handle=function(ch,listener){
            // 日志所有 IPC 注册
            W("[IPC:reg] "+ch);
            if(ch==="license.machineCode"){
                return origHandle.call(this,ch,async function(evt){
                    var r=await listener.apply(this,arguments);
                    try{
                        var mc=JSON.parse(Buffer.from(r,"base64").toString("utf-8"));
                        if(!cachedMC||cachedMC.i!==mc.i){
                            cachedMC=mc;
                            hookCp.execSync('reg add "HKCU\\\\Software\\\\Typora" /v MCInfo /t REG_SZ /d "'+r+'" /f',{encoding:"utf-8",timeout:5000});
                            W("[MC] 捕获新机器码 -> 已写入注册表, fingerprint="+mc.i);
                        }
                    }catch(e){W("[MC] 解析失败:",e.message)}
                    return r
                });
            }
            // 所有 IPC 调用都记录（过滤高频的 document.addSnapAndLastSync 和 document.setContent）
            if(ch!=="document.addSnapAndLastSync"&&ch!=="document.setContent"){
                return origHandle.call(this,ch,async function(evt){
                    var args=Array.prototype.slice.call(arguments,1);
                    W("[IPC:call] "+ch+" "+JSON.stringify(args).substring(0,200));
                    var r=await listener.apply(this,arguments);
                    var rs=JSON.stringify(r);
                    if(rs&&rs.length<500)W("[IPC:resp] "+ch+" "+rs);
                    return r
                });
            }
            return origHandle.call(this,ch,listener)
        };
        W("[HOOK] 机器码自动捕获已安装");
        
        // -- 4. crypto.publicDecrypt 劫持 --
        var cryptoMod=require("crypto");
        cryptoMod.publicDecrypt=function(k,buf){
            var mc=cachedMC;
            var deviceId=mc?mc.l:(hookOs.hostname()+" | "+(hookOs.userInfo().username||"user")+" | Windows");
            var fingerprint=mc?mc.i:"pending";
            var ver=mc?mc.v:"win|1.13.7";
            W("[CRYPTO] publicDecrypt 被调用, 输入="+buf.length+"字节, fingerprint="+fingerprint+(mc?"":" (待捕获)"));
            var data={
                deviceId:deviceId,
                fingerprint:fingerprint,
                email:"admin@localhost",
                license:"Cracked_Typora",
                version:ver,
                date:"${dateStr}",
                type:"Standard"
            };
            return Buffer.from(JSON.stringify(data))
        };
        W("[HOOK] crypto.publicDecrypt 已安装");
        
        // -- 5. electron.net.fetch 劫持 --
        var origFetch=electron.net.fetch;
        electron.net.fetch=function(input,init){
            var u="";if(typeof input==="string")u=input;else if(input&&input.url)u=input.url;else u=String(input);
            if(u.indexOf("renew")>=0){
                W("[NET] 拦截 renew 请求");
                return Promise.resolve(new Response(JSON.stringify({success:true,msg:B("ok")}),{status:200,headers:{"content-type":"application/json"}}))
            }
            return origFetch.apply(this,arguments)
        };
        W("[HOOK] electron.net.fetch 已安装 (拦截 renew)");
        
        // -- 6. protocol handle 兜底 --
        electron.app.whenReady().then(function(){
            electron.protocol.handle("https",async function(req){
                if(req.url.indexOf("renew")>=0){
                    W("[NET] protocol 拦截 renew");
                    return new Response(JSON.stringify({success:true,msg:B("ok")}),{status:200,headers:{"content-type":"application/json"}})
                }
                try{return await electron.net.fetch(req,{bypassCustomProtocolHandlers:true})}catch(e){throw e}
            });
            W("[HOOK] protocol handle 已安装")
        });
        
        function B(s){return Buffer.from(s).toString("base64")}
        W("========== Hook 全部就绪 (MC="+(cachedMC?"已缓存,指纹="+cachedMC.i:"待捕获")+") ==========");
        `;

    var original = fs.readFileSync(path.join(APP_BAK_DIR, "launch.dist.js"), "utf-8");
    fs.writeFileSync(LAUNCH_JS, hookCode + "\n" + original, "utf-8");
    console.log("Hook 注入完成");
    console.log("");
    console.log("====================================");
    console.log("  激活码格式: +XXXXXXXX#");
    console.log("  示例: +12345678#");
    console.log("  必须以 + 开头、# 结尾，中间任意字符");
    console.log("====================================");
    console.log("");

    // 注册表 IDate
    try {
        execSync('powershell -Command "Set-ItemProperty -Path \'HKCU:\\Software\\Typora\' -Name \'IDate\' -Value \'' + dateStr + '\' -Force"', {encoding: "utf-8"});
    } catch (e) {
    }

    try {
        fs.rmSync(path.join(typoraPath, "typora.log"), {force: true});
    } catch (e) {
    }
    console.log("Typora 已启动。");
    execSync('start "" "' + EXE_PATH + '"', {encoding: "utf-8"});
}
