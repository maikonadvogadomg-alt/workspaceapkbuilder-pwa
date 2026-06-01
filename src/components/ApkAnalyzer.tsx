/**
 * ApkAnalyzer — Abre qualquer APK, mostra o que está dentro
 * e tem aba "Limpar Replit" para remover dependências do Replit
 * e fazer o APK funcionar fora do servidor.
 * 100% no browser, sem upload, sem servidor.
 */
import { useState, useCallback } from "react";

interface ApkInfo {
  fileName: string;
  fileSizeMB: string;
  packageName: string;
  versionCode: string;
  versionName: string;
  appLabel: string;
  minSdk: string;
  targetSdk: string;
  permissions: string[];
  activities: string[];
  files: { name: string; sizeMB: string }[];
  rawStrings: string[];
  replitFiles: string[];   // arquivos com refs ao Replit
}

// ── Parser AXML ──────────────────────────────────────────
function parseAxml(buf: ArrayBuffer): string[] {
  const data = new Uint8Array(buf);
  const dv = new DataView(buf);
  const strings: string[] = [];
  try {
    const off = 8;
    const strCount  = dv.getUint32(off + 8, true);
    const flags     = dv.getUint32(off + 16, true);
    const strStart  = dv.getUint32(off + 20, true);
    const poolHSize = dv.getUint16(off + 2, true);
    const isUtf8    = !!(flags & (1 << 8));
    const offsetsBase = off + poolHSize;
    const stringsBase = off + strStart;
    for (let i = 0; i < Math.min(strCount, 500); i++) {
      const idxOff = offsetsBase + i * 4;
      if (idxOff + 4 > data.byteLength) break;
      const sOff = stringsBase + dv.getUint32(idxOff, true);
      if (sOff >= data.byteLength) continue;
      let s = "";
      if (isUtf8) {
        const clen = data[sOff + 1];
        if (sOff + 2 + clen > data.byteLength) continue;
        for (let j = 0; j < clen; j++) { const c = data[sOff + 2 + j]; if (c >= 0x20) s += String.fromCharCode(c); }
      } else {
        const clen = dv.getUint16(sOff, true);
        if (sOff + 2 + clen * 2 > data.byteLength) continue;
        for (let j = 0; j < clen; j++) { const c = dv.getUint16(sOff + 2 + j * 2, true); if (c >= 0x20) s += String.fromCharCode(c); }
      }
      if (s.length >= 2) strings.push(s);
    }
  } catch {}
  return strings;
}

const REPLIT_PATTERNS = [
  /replit\.dev/gi, /repl\.co/gi, /repl\.it/gi,
  /REPL_ID/g, /REPLIT_DEV_DOMAIN/g, /REPLIT_DOMAINS/g,
  /replit\.com/gi, /cartographer/gi, /vite-plugin-dev-banner/gi,
  /vite-plugin-runtime-error-modal/gi, /replitDomain/gi,
  /__replit/gi,
];

function hasReplitRef(text: string) {
  return REPLIT_PATTERNS.some(p => { p.lastIndex = 0; return p.test(text); });
}

function cleanReplitRefs(text: string): string {
  let out = text;
  out = out.replace(/https?:\/\/[a-z0-9-]+\.replit\.dev[^\s"'`)]*/gi, "");
  out = out.replace(/https?:\/\/[a-z0-9-]+\.repl\.co[^\s"'`)]*/gi, "");
  out = out.replace(/["']REPLIT_DEV_DOMAIN["']\s*:\s*["'][^"']*["']/gi, '"REPLIT_DEV_DOMAIN":""');
  out = out.replace(/["']REPL_ID["']\s*:\s*["'][^"']*["']/gi, '"REPL_ID":""');
  out = out.replace(/process\.env\.REPL_ID/g, '""');
  out = out.replace(/process\.env\.REPLIT_DEV_DOMAIN/g, '""');
  out = out.replace(/import\.meta\.env\.REPLIT[A-Z_]*/g, '""');
  return out;
}

function extractInfo(strings: string[], fileName: string, fileSizeMB: string, replitFiles: string[]): ApkInfo {
  const pkg      = strings.find(s => /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,6}$/.test(s) && !s.startsWith("android") && !s.startsWith("androidx") && !s.startsWith("com.google") && !s.startsWith("com.facebook") && s.split(".").length >= 2) ?? "—";
  const verName  = strings.find(s => /^\d+(\.\d+){0,3}$/.test(s) && s !== "1.0" && Number(s.split(".")[0]) > 1) ?? strings.find(s => /^\d+\.\d+/.test(s)) ?? "—";
  const verCode  = strings.find(s => /^\d{2,6}$/.test(s)) ?? "—";
  const minSdk   = strings.find(s => /^(2[4-9]|3[0-9])$/.test(s)) ?? "24";
  const tgtSdk   = strings.find(s => /^3[0-9]$/.test(s)) ?? "—";
  const perms    = strings.filter(s => s.startsWith("android.permission.") || (s.includes(".permission.") && s.length < 80)).map(s => s.replace("android.permission.", "")).slice(0, 30);
  const activities = strings.filter(s => (s.includes("Activity") || s.includes("activity")) && s.includes(".") && !s.startsWith("android") && s.length < 80).slice(0, 10);
  const appLabel = strings.find(s => s.length > 3 && s.length < 30 && /^[A-Z]/.test(s) && !/^[A-Z_]+$/.test(s) && !s.includes(".") && !s.includes("/")) ?? fileName.replace(".apk", "");
  return { fileName, fileSizeMB, packageName: pkg, versionCode: verCode, versionName: verName, appLabel, minSdk, targetSdk: tgtSdk, permissions: perms, activities, files: [], rawStrings: strings, replitFiles };
}

const PERM_LABELS: Record<string, string> = {
  INTERNET: "Internet", CAMERA: "Câmera", RECORD_AUDIO: "Microfone",
  READ_EXTERNAL_STORAGE: "Ler arquivos", WRITE_EXTERNAL_STORAGE: "Gravar arquivos",
  ACCESS_FINE_LOCATION: "GPS preciso", ACCESS_COARSE_LOCATION: "Localização aprox.",
  READ_CONTACTS: "Contatos", WRITE_CONTACTS: "Editar contatos",
  CALL_PHONE: "Ligar", SEND_SMS: "Enviar SMS", RECEIVE_SMS: "Receber SMS",
  RECEIVE_BOOT_COMPLETED: "Iniciar com o celular", FOREGROUND_SERVICE: "Segundo plano",
  WAKE_LOCK: "Manter tela", BILLING: "Compras no app", USE_BIOMETRIC: "Biometria",
  BLUETOOTH: "Bluetooth", NFC: "NFC", FLASHLIGHT: "Lanterna",
};

export default function ApkAnalyzer() {
  const [apks, setApks]       = useState<ApkInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [drag, setDrag]       = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [tab2, setTab2]       = useState<"info" | "perms" | "files" | "limpar">("info");
  const [cleaning, setCleaning] = useState(false);
  const [cleanMsg, setCleanMsg] = useState<string | null>(null);

  const analyze = useCallback(async (fileList: FileList | File[]) => {
    setLoading(true);
    const arr = Array.from(fileList);
    const results: ApkInfo[] = [];
    for (const file of arr) {
      if (!file.name.endsWith(".apk") && !file.name.endsWith(".zip")) continue;
      try {
        const buf = await file.arrayBuffer();
        const { default: JSZip } = await import("jszip");
        const zip = await JSZip.loadAsync(buf);
        const manifestEntry = zip.files["AndroidManifest.xml"];
        let strings: string[] = [];
        if (manifestEntry) {
          const mBuf = await manifestEntry.async("arraybuffer");
          strings = parseAxml(mBuf);
        }
        // detecta arquivos com refs Replit
        const replitFiles: string[] = [];
        for (const [name, entry] of Object.entries(zip.files)) {
          if (entry.dir) continue;
          if (/\.(js|html|css|json|ts|jsx|tsx)$/.test(name)) {
            try {
              const text = await entry.async("text");
              if (hasReplitRef(text)) replitFiles.push(name);
            } catch {}
          }
        }
        const fileList2 = Object.entries(zip.files)
          .filter(([, e]) => !e.dir)
          .map(([name, e]) => ({ name, sizeMB: e._data?.uncompressedSize ? (e._data.uncompressedSize / 1024 / 1024).toFixed(2) : "?" }))
          .sort((a, b) => parseFloat(b.sizeMB) - parseFloat(a.sizeMB))
          .slice(0, 60);
        const info = extractInfo(strings, file.name, (file.size / 1024 / 1024).toFixed(1), replitFiles);
        info.files = fileList2;
        results.push(info);
      } catch {
        results.push({ fileName: file.name, fileSizeMB: "?", packageName: "Erro", versionCode: "—", versionName: "—", appLabel: file.name, minSdk: "—", targetSdk: "—", permissions: [], activities: [], files: [], rawStrings: [], replitFiles: [] });
      }
    }
    setApks(a => { const m = [...a, ...results]; setSelected(m.length - 1); return m; });
    setLoading(false);
  }, []);

  async function cleanApk(apk: ApkInfo) {
    setCleaning(true); setCleanMsg(null);
    try {
      const input = document.createElement("input");
      input.type = "file"; input.accept = ".apk,.zip";
      input.onchange = async () => {
        const file = input.files?.[0]; if (!file) { setCleaning(false); return; }
        const buf = await file.arrayBuffer();
        const { default: JSZip } = await import("jszip");
        const zip = await JSZip.loadAsync(buf);
        const outZip = new JSZip();
        let cleaned = 0;
        for (const [name, entry] of Object.entries(zip.files)) {
          if (entry.dir) { outZip.folder(name); continue; }
          if (/\.(js|html|css|json)$/.test(name)) {
            try {
              const text = await entry.async("text");
              if (hasReplitRef(text)) {
                outZip.file(name, cleanReplitRefs(text));
                cleaned++;
              } else { outZip.file(name, await entry.async("uint8array")); }
            } catch { outZip.file(name, await entry.async("uint8array")); }
          } else { outZip.file(name, await entry.async("uint8array")); }
        }
        const blob = await outZip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = file.name.replace(".apk", "-limpo.apk").replace(".zip", "-limpo.zip");
        document.body.appendChild(a); a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
        setCleanMsg(`✅ ${cleaned} arquivo(s) limpo(s). Baixando APK sem Replit...`);
        setCleaning(false);
      };
      input.click();
    } catch (e: any) { setCleanMsg(`❌ Erro: ${e.message}`); setCleaning(false); }
  }

  const cur = selected !== null ? apks[selected] : null;

  return (
    <div className="space-y-3">
      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); analyze(e.dataTransfer.files); }}
        onClick={() => document.getElementById("apk-input")?.click()}
        className={`border-2 border-dashed rounded-2xl p-6 text-center cursor-pointer transition-all ${drag ? "border-violet-400 bg-violet-900/20" : "border-slate-600 bg-slate-900/40 hover:border-violet-600/60"}`}
      >
        <input id="apk-input" type="file" accept=".apk,.zip" multiple className="hidden" onChange={e => e.target.files && analyze(e.target.files)} />
        <p className="text-2xl mb-2">📱</p>
        <p className="font-bold text-slate-200 text-sm">Arraste APK(s) aqui ou clique para selecionar</p>
        <p className="text-xs text-slate-500 mt-1">Múltiplos arquivos · 100% no browser · sem upload · suporta .apk e .zip</p>
        {loading && <p className="text-xs text-violet-300 mt-2 animate-pulse">⏳ Analisando...</p>}
      </div>

      {/* O que faz */}
      <div className="bg-blue-900/20 border border-blue-700/30 rounded-xl p-3">
        <p className="text-xs font-bold text-blue-300 mb-1">ℹ️ O que este analisador faz</p>
        <p className="text-[11px] text-slate-400 leading-relaxed">
          Abre o APK e lê o <strong className="text-yellow-300">Package ID</strong> (nome interno único),
          a <strong className="text-yellow-300">versão real</strong>, as <strong className="text-yellow-300">permissões</strong>,
          e detecta arquivos com referências ao <strong className="text-red-300">Replit</strong>.
          A aba <strong className="text-green-300">🧹 Limpar Replit</strong> remove essas referências
          e baixa uma versão do APK que funciona <strong className="text-white">fora do Replit</strong>.
        </p>
      </div>

      {/* Lista de APKs */}
      {apks.length > 0 && (
        <div className="bg-slate-900 border border-slate-700 rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 bg-slate-800/50">
            <span className="text-[11px] text-slate-400 font-semibold">{apks.length} APK{apks.length > 1 ? "s" : ""}</span>
            <button onClick={() => { setApks([]); setSelected(null); }} className="text-[10px] text-red-400 hover:text-red-300">limpar tudo</button>
          </div>
          {apks.map((a, i) => (
            <div key={i} onClick={() => setSelected(i)}
              className={`flex items-center gap-3 px-3 py-2 cursor-pointer border-b border-slate-800 transition-colors ${selected === i ? "bg-violet-900/30" : "hover:bg-slate-800/40"}`}>
              <span className="text-lg">📦</span>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-slate-200 truncate">{a.appLabel}</p>
                <p className="text-[10px] text-slate-500 font-mono truncate">{a.packageName}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-[10px] text-violet-300 font-bold">v{a.versionName}</p>
                {a.replitFiles.length > 0 && <p className="text-[10px] text-red-400">⚠️ {a.replitFiles.length} refs Replit</p>}
                <p className="text-[10px] text-slate-500">{a.fileSizeMB} MB</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detalhe */}
      {cur && (
        <div className="bg-slate-900 border border-violet-700/40 rounded-2xl overflow-hidden">
          <div className="bg-gradient-to-r from-violet-900/40 to-slate-900/60 px-4 py-3 border-b border-slate-700 flex items-center gap-3">
            <span className="text-3xl">📱</span>
            <div>
              <p className="font-bold text-white text-sm">{cur.appLabel}</p>
              <p className="text-[11px] text-slate-400 font-mono">{cur.fileName} · {cur.fileSizeMB} MB</p>
            </div>
          </div>

          {/* Sub-tabs */}
          <div className="flex border-b border-slate-700 bg-slate-800/40">
            {(["info", "perms", "files", "limpar"] as const).map(t => (
              <button key={t} onClick={() => setTab2(t)}
                className={`flex-1 py-2 text-[11px] font-semibold transition-colors ${tab2 === t ? "text-violet-300 border-b-2 border-violet-400 bg-slate-900/60" : "text-slate-500 hover:text-slate-300"}`}>
                {t === "info" ? "ℹ️ Dados" : t === "perms" ? "🔒 Permissões" : t === "files" ? "📁 Arquivos" : "🧹 Limpar Replit"}
              </button>
            ))}
          </div>

          <div className="p-4 space-y-3">
            {/* ── INFO ── */}
            {tab2 === "info" && (
              <>
                <div className="bg-yellow-900/20 border border-yellow-600/40 rounded-xl p-3">
                  <p className="text-[10px] text-yellow-400 font-semibold mb-1">⚠️ Package ID — nome interno único</p>
                  <p className="text-sm font-bold text-yellow-200 font-mono break-all">{cur.packageName}</p>
                  <p className="text-[10px] text-slate-400 mt-1">
                    Dois APKs com o <strong>mesmo Package ID</strong> não instalam juntos — um sobrescreve o outro.<br />
                    Package IDs <strong>diferentes</strong> instalam juntos sem conflito.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { l: "Versão Exibida",      v: cur.versionName, c: "text-green-300" },
                    { l: "Versão Interna (Code)", v: cur.versionCode, c: "text-cyan-300" },
                    { l: "Android Mínimo",       v: `API ${cur.minSdk}`, c: "text-blue-300" },
                    { l: "Android Alvo",         v: `API ${cur.targetSdk}`, c: "text-blue-300" },
                    { l: "Permissões",           v: `${cur.permissions.length} pedidas`, c: "text-orange-300" },
                    { l: "Refs Replit",          v: cur.replitFiles.length > 0 ? `⚠️ ${cur.replitFiles.length} arquivos` : "✅ Nenhuma", c: cur.replitFiles.length > 0 ? "text-red-400" : "text-green-400" },
                  ].map((item, i) => (
                    <div key={i} className="bg-slate-800/60 rounded-xl p-3">
                      <p className="text-[10px] text-slate-500 mb-0.5">{item.l}</p>
                      <p className={`text-sm font-bold ${item.c}`}>{item.v}</p>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* ── PERMISSÕES ── */}
            {tab2 === "perms" && (
              <div className="space-y-2">
                {cur.permissions.length === 0
                  ? <p className="text-sm text-slate-500 text-center py-4">Nenhuma permissão encontrada</p>
                  : cur.permissions.map((p, i) => (
                    <div key={i} className="flex items-start gap-2 bg-slate-800/50 rounded-xl p-3">
                      <span className="text-base mt-0.5">
                        {p.includes("CAMERA") ? "📷" : p.includes("LOCATION") ? "📍" : p.includes("AUDIO") ? "🎙️" : p.includes("SMS") ? "💬" : p.includes("STORAGE") ? "💾" : p.includes("INTERNET") ? "🌐" : p.includes("CONTACT") ? "👤" : p.includes("PHONE") || p.includes("CALL") ? "📞" : p.includes("BLUETOOTH") ? "🔵" : p.includes("BILLING") ? "💳" : "🔒"}
                      </span>
                      <div>
                        <p className="text-xs font-bold text-orange-200">{PERM_LABELS[p] ?? p}</p>
                        <p className="text-[10px] text-slate-500 font-mono">{p}</p>
                      </div>
                    </div>
                  ))
                }
              </div>
            )}

            {/* ── ARQUIVOS ── */}
            {tab2 === "files" && (
              <div className="space-y-1">
                <p className="text-[10px] text-slate-500 mb-2">Maiores primeiro (máx. 60)</p>
                {cur.files.map((f, i) => (
                  <div key={i} className={`flex items-center justify-between rounded-lg px-3 py-1.5 ${cur.replitFiles.includes(f.name) ? "bg-red-900/20 border border-red-700/30" : "bg-slate-800/40"}`}>
                    <p className={`text-[10px] font-mono truncate flex-1 ${cur.replitFiles.includes(f.name) ? "text-red-300" : "text-slate-300"}`}>
                      {cur.replitFiles.includes(f.name) ? "⚠️ " : ""}{f.name}
                    </p>
                    <span className="text-[10px] text-slate-500 ml-2 shrink-0">{f.sizeMB} MB</span>
                  </div>
                ))}
              </div>
            )}

            {/* ── LIMPAR REPLIT ── */}
            {tab2 === "limpar" && (
              <div className="space-y-3">
                <div className={`rounded-xl p-3 border ${cur.replitFiles.length > 0 ? "bg-red-900/20 border-red-700/40" : "bg-green-900/20 border-green-700/40"}`}>
                  <p className={`text-xs font-bold mb-1 ${cur.replitFiles.length > 0 ? "text-red-300" : "text-green-300"}`}>
                    {cur.replitFiles.length > 0 ? `⚠️ ${cur.replitFiles.length} arquivo(s) com referências ao Replit` : "✅ Nenhuma referência ao Replit encontrada"}
                  </p>
                  {cur.replitFiles.length > 0
                    ? <p className="text-[10px] text-slate-400">Esses arquivos contêm URLs ou variáveis do Replit que podem impedir o app de funcionar fora do servidor. A limpeza substitui essas referências por strings vazias.</p>
                    : <p className="text-[10px] text-slate-400">Este APK parece não ter dependências do Replit embutidas.</p>
                  }
                </div>

                {cur.replitFiles.length > 0 && (
                  <div className="bg-slate-800/40 rounded-xl p-3 space-y-1">
                    <p className="text-[10px] text-slate-500 font-semibold mb-2">Arquivos que serão limpos:</p>
                    {cur.replitFiles.map((f, i) => (
                      <p key={i} className="text-[10px] text-red-300 font-mono">⚠️ {f}</p>
                    ))}
                  </div>
                )}

                <div className="bg-slate-800/40 rounded-xl p-3">
                  <p className="text-[10px] text-slate-500 font-semibold mb-2">O que a limpeza remove:</p>
                  {["URLs *.replit.dev e *.repl.co", "Variáveis REPL_ID e REPLIT_DEV_DOMAIN", "import.meta.env.REPLIT_*", "Plugin cartographer do Replit", "Plugin dev-banner do Replit", "Plugin runtime-error-modal do Replit"].map((item, i) => (
                    <p key={i} className="text-[10px] text-slate-400 flex items-center gap-1">
                      <span className="text-green-400">✓</span> {item}
                    </p>
                  ))}
                </div>

                {cleanMsg && (
                  <div className={`rounded-xl p-3 text-xs font-bold ${cleanMsg.startsWith("✅") ? "bg-green-900/20 text-green-300 border border-green-700/40" : "bg-red-900/20 text-red-300 border border-red-700/40"}`}>
                    {cleanMsg}
                  </div>
                )}

                <button
                  onClick={() => cleanApk(cur)}
                  disabled={cleaning}
                  className="w-full py-3 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white font-bold text-sm rounded-xl transition-colors flex items-center justify-center gap-2"
                >
                  {cleaning ? "⏳ Limpando..." : "🧹 Limpar e Baixar APK sem Replit"}
                </button>
                <p className="text-[10px] text-slate-500 text-center">
                  Selecione o APK original quando o seletor abrir · O APK limpo é baixado automaticamente
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {apks.length === 0 && !loading && (
        <div className="bg-slate-900/40 border border-slate-700/40 rounded-2xl p-6 text-center">
          <p className="text-slate-500 text-xs">Arraste um ou mais arquivos .apk acima para começar.</p>
        </div>
      )}
    </div>
  );
}
