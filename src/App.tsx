import { useState, useRef, useEffect, useCallback } from "react";
import { extractArchive, extractApk, guessConfig, analyzeProject, type ArchiveFile, type ProjectAnalysis } from "./lib/archive";
import { buildAndroidZip, buildAndroidFilesForGithub, buildEASFilesForGithub, genEASCloudWorkflow, DEFAULT_CFG, type AppConfig } from "./lib/android";
import {
  ghGetUser, ghListRepos, ghGetRepo, ghImportRepo, ghImportPublicRepo,
  ghCreateRepo, ghPushFiles, ghPublishPages, ghSetRepoSecret, type GhUser, type GhRepo,
} from "./lib/github";
import { saveSession, loadSession, getSavedMeta, clearSession, type SavedSession, type SaveResult } from "./lib/storage";
import TerminalTab from "./components/TerminalTab";
import ApkAnalyzer from "./components/ApkAnalyzer";

/* ─── AI helpers ────────────────────────────────────────── */
interface AIKeys { url: string; key: string; model: string; }
interface ChatMsg { role: "user" | "assistant"; text: string; }

async function callAI(keys: AIKeys, userMsg: string, context: string) {
  const base = (keys.url || "https://api.openai.com/v1").replace(/\/$/, "");
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${keys.key}` },
    body: JSON.stringify({
      model: keys.model || "gpt-4o-mini",
      messages: [
        { role: "system", content: "Você é especialista em Android, PWA, Capacitor, Gradle e React Native. Responda em português de forma clara e prática." },
        { role: "user", content: context ? `[Contexto: ${context}]\n\n${userMsg}` : userMsg },
      ],
    }),
  });
  if (!r.ok) throw new Error(`IA ${r.status}: ${(await r.json().catch(() => ({}))).error?.message ?? r.statusText}`);
  return (await r.json()).choices[0].message.content as string;
}

/* ─── AI key auto-detect ─────────────────────────────────── */
function detectAIProvider(key: string): { url: string; model: string } | null {
  const k = key.trim();
  if (!k || k.length < 8) return null;
  if (k.startsWith("sk-ant-"))  return { url: "https://api.anthropic.com/v1",                            model: "claude-3-5-haiku-20241022" };
  if (k.startsWith("sk-or-"))   return { url: "https://openrouter.ai/api/v1",                           model: "openai/gpt-4o-mini" };
  if (k.startsWith("gsk_"))     return { url: "https://api.groq.com/openai/v1",                         model: "llama-3.3-70b-versatile" };
  if (k.startsWith("AIza"))     return { url: "https://generativelanguage.googleapis.com/v1beta/openai/", model: "gemini-2.0-flash" };
  if (k.startsWith("pplx-"))    return { url: "https://api.perplexity.ai",                              model: "sonar" };
  if (k.startsWith("hf_"))      return { url: "https://api-inference.huggingface.co/v1",                model: "meta-llama/Llama-3.1-8B-Instruct" };
  if (k.startsWith("r8_"))      return { url: "https://api.replicate.com/v1",                           model: "meta/llama-3.1-405b-instruct" };
  if (k.startsWith("sk-"))      return { url: "https://api.openai.com/v1",                              model: "gpt-4o-mini" };
  return null;
}

/* ─── Google Drive ──────────────────────────────────────── */
async function uploadToDrive(token: string, blob: Blob, name: string) {
  const meta = JSON.stringify({ name, mimeType: "application/zip" });
  const form = new FormData();
  form.append("metadata", new Blob([meta], { type: "application/json" }));
  form.append("file", blob, name);
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.json()).error?.message}`);
  const j = await r.json();
  return `https://drive.google.com/file/d/${j.id}/view`;
}

/* ─── Download blob ─────────────────────────────────────── */
function downloadBlob(blob: Blob, name: string) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { document.body.removeChild(a); } catch {} URL.revokeObjectURL(url); }, 800);
  } catch (e) {
    alert("Erro ao baixar: " + String(e));
  }
}

/* ─── Version ───────────────────────────────────────────── */
const APP_VERSION = "v2.0";
const BUILD_DATE = "2025-05-04";

/* ─── Types ─────────────────────────────────────────────── */
type Tab = "import" | "github" | "export" | "ai" | "terminal" | "analisar" | "guide" | "downloads";

interface SysInfo {
  checkedAt: string;
  // Rede
  proxyOk: boolean | null;
  online: boolean | null;
  connType: string | null;
  downlinkMbps: number | null;
  rttMs: number | null;
  // Memória JS
  memUsedMB: number | null;
  memTotalMB: number | null;
  memLimitMB: number | null;
  deviceMemGB: number | null;
  // Storage
  storageUsedMB: number | null;
  storageQuotaMB: number | null;
  storagePct: number | null;
  // Device/Browser
  cores: number | null;
  browserInfo: string | null;
  platform: string | null;
  // GitHub
  ghRateLimit: number | null;
  ghRateLimitReset: string | null;
}

const AI_TOKEN_LIMITS = [
  { provider: "OpenAI",      model: "gpt-4o",               ctx: "128k",  out: "16k",   color: "#10b981" },
  { provider: "OpenAI",      model: "gpt-4o-mini",          ctx: "128k",  out: "16k",   color: "#10b981" },
  { provider: "OpenAI",      model: "gpt-4-turbo",          ctx: "128k",  out: "4k",    color: "#10b981" },
  { provider: "OpenAI",      model: "gpt-3.5-turbo",        ctx: "16k",   out: "4k",    color: "#10b981" },
  { provider: "OpenAI",      model: "o1 / o3",              ctx: "200k",  out: "100k",  color: "#10b981" },
  { provider: "Anthropic",   model: "claude-3.5-sonnet",    ctx: "200k",  out: "8k",    color: "#f59e0b" },
  { provider: "Anthropic",   model: "claude-3-opus",        ctx: "200k",  out: "4k",    color: "#f59e0b" },
  { provider: "Anthropic",   model: "claude-3-haiku",       ctx: "200k",  out: "4k",    color: "#f59e0b" },
  { provider: "Google",      model: "gemini-1.5-pro",       ctx: "1M",    out: "8k",    color: "#3b82f6" },
  { provider: "Google",      model: "gemini-1.5-flash",     ctx: "1M",    out: "8k",    color: "#3b82f6" },
  { provider: "Google",      model: "gemini-2.0-flash",     ctx: "1M",    out: "8k",    color: "#3b82f6" },
  { provider: "Groq",        model: "llama-3.1-70b",        ctx: "128k",  out: "8k",    color: "#8b5cf6" },
  { provider: "Groq",        model: "mixtral-8x7b",         ctx: "32k",   out: "32k",   color: "#8b5cf6" },
  { provider: "Groq",        model: "llama-3.3-70b",        ctx: "128k",  out: "8k",    color: "#8b5cf6" },
  { provider: "Perplexity",  model: "sonar-pro",            ctx: "200k",  out: "8k",    color: "#22d3ee" },
  { provider: "Perplexity",  model: "sonar",                ctx: "128k",  out: "8k",    color: "#22d3ee" },
  { provider: "DeepSeek",    model: "deepseek-chat",        ctx: "64k",   out: "8k",    color: "#ec4899" },
  { provider: "Mistral",     model: "mistral-large",        ctx: "128k",  out: "8k",    color: "#f97316" },
];

/* ════════════════════════════════════════════════════════════
   MAIN APP
═══════════════════════════════════════════════════════════════ */
export default function App() {
  /* ── Core project state ── */
  const [files, setFiles] = useState<ArchiveFile[]>([]);
  const [cfg, setCfg] = useState<AppConfig>(DEFAULT_CFG);
  const [source, setSource] = useState("");
  const [projectReady, setProjectReady] = useState(false);

  /* ── UI state ── */
  const [tab, setTab] = useState<Tab>("import");
  const [statusMsg, setStatusMsg] = useState<{ text: string; ok: boolean } | null>(null);

  /* ── Import / Upload ── */
  const [importLoading, setImportLoading] = useState(false);
  const [importInfo, setImportInfo] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  /* ── GitHub ── */
  const [ghToken, setGhToken] = useState(() => localStorage.getItem("gh_token") || "");
  const [ghUser, setGhUser] = useState<GhUser | null>(null);
  const [ghRepos, setGhRepos] = useState<GhRepo[]>([]);
  const [ghRepoFilter, setGhRepoFilter] = useState("");
  const [ghLoading, setGhLoading] = useState(false);
  const [ghMsg, setGhMsg] = useState("");
  const [ghSelectedRepo, setGhSelectedRepo] = useState<GhRepo | null>(null);
  const [ghCustomRepo, setGhCustomRepo] = useState("");
  /* import público sem token */
  const [ghPublicRepo, setGhPublicRepo] = useState("");
  const [ghPublicLoading, setGhPublicLoading] = useState(false);
  const [ghPublicMsg, setGhPublicMsg] = useState("");

  /* ── Export ── */
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [resultName, setResultName] = useState("");
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [driveToken, setDriveToken] = useState(() => localStorage.getItem("drive_token") || "");
  const [driveMsg, setDriveMsg] = useState("");
  const [driveLoading, setDriveLoading] = useState(false);
  const [pushRepoName, setPushRepoName] = useState("");
  const [pushPrivate, setPushPrivate] = useState(false);
  const [pushMsg, setPushMsg] = useState("");
  const [pushLoading, setPushLoading] = useState(false);

  /* ── GitHub Pages publish ── */
  const [pagesRepoName, setPagesRepoName] = useState("");
  const [pagesPrivate, setPagesPrivate] = useState(false);
  const [pagesMsg, setPagesMsg] = useState("");
  const [pagesLoading, setPagesLoading] = useState(false);
  const [pagesUrl, setPagesUrl] = useState("");

  /* ── Session persistence ── */
  const [savedMeta, setSavedMeta] = useState<SavedSession | null>(null);
  const [restoring, setRestoring] = useState(false);

  /* ── URL import ── */
  const [urlInput, setUrlInput] = useState("");
  const [urlLoading, setUrlLoading] = useState(false);
  const [urlMsg, setUrlMsg] = useState("");
  const [urlIssues, setUrlIssues] = useState<{ type: "ok" | "warn" | "err"; text: string }[]>([]);

  /* ── APK analysis / cleanup ── */
  const [analysis, setAnalysis] = useState<ProjectAnalysis | null>(null);
  const [cleanedFiles, setCleanedFiles] = useState<ArchiveFile[] | null>(null);
  const [customName, setCustomName] = useState("");
  const [nameApplied, setNameApplied] = useState(false);

  /* ── GitHub Actions cloud build ── */
  const [ciRepoOwner, setCiRepoOwner] = useState("");
  const [ciRepoName, setCiRepoName] = useState("");
  const [ciMsg, setCiMsg] = useState("");
  const [ciLoading, setCiLoading] = useState(false);
  const [ciRunUrl, setCiRunUrl] = useState("");

  /* ── Pipeline completo (1 clique) ── */
  const [pipeLoading, setPipeLoading] = useState(false);
  const [pipeMsg, setPipeMsg] = useState("");
  const [pipeRunUrl, setPipeRunUrl] = useState("");

  /* ── EAS (Expo) build ── */
  const [easLoading, setEasLoading] = useState(false);
  const [easMsg, setEasMsg] = useState("");
  const [easRunUrl, setEasRunUrl] = useState("");
  const [easToken, setEasToken] = useState(() => localStorage.getItem("expo_token") || "");

  /* ── AI ── */
  const [aiKeys, setAiKeys] = useState<AIKeys>(() => ({
    url: localStorage.getItem("custom_api_url") || "",
    key: localStorage.getItem("custom_api_key") || "",
    model: localStorage.getItem("custom_api_model") || "gpt-4o-mini",
  }));
  const [showAiKeys, setShowAiKeys] = useState(false);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const recognRef = useRef<any>(null);

  /* ── System status ── */
  const [sysInfo, setSysInfo] = useState<SysInfo>({
    checkedAt: "", proxyOk: null, online: null, connType: null,
    downlinkMbps: null, rttMs: null, memUsedMB: null, memTotalMB: null,
    memLimitMB: null, deviceMemGB: null, storageUsedMB: null,
    storageQuotaMB: null, storagePct: null, cores: null,
    browserInfo: null, platform: null, ghRateLimit: null, ghRateLimitReset: null,
  });
  const [sysChecking, setSysChecking] = useState(false);

  const checkSystem = useCallback(async () => {
    setSysChecking(true);
    const info: SysInfo = {
      checkedAt: new Date().toLocaleTimeString("pt-BR"),
      proxyOk: null, online: navigator.onLine, connType: null,
      downlinkMbps: null, rttMs: null, memUsedMB: null, memTotalMB: null,
      memLimitMB: null, deviceMemGB: null, storageUsedMB: null,
      storageQuotaMB: null, storagePct: null, cores: navigator.hardwareConcurrency || null,
      browserInfo: null, platform: navigator.platform || null,
      ghRateLimit: null, ghRateLimitReset: null,
    };
    // Rede
    const conn = (navigator as any).connection ?? (navigator as any).mozConnection ?? (navigator as any).webkitConnection;
    if (conn) { info.connType = conn.effectiveType ?? conn.type ?? null; info.downlinkMbps = conn.downlink ?? null; info.rttMs = conn.rtt ?? null; }
    // Browser
    const ua = navigator.userAgent;
    if (ua.includes("Chrome/")) info.browserInfo = `Chrome ${ua.match(/Chrome\/(\d+)/)?.[1] ?? ""}`;
    else if (ua.includes("Firefox/")) info.browserInfo = `Firefox ${ua.match(/Firefox\/(\d+)/)?.[1] ?? ""}`;
    else if (ua.includes("Safari/")) info.browserInfo = `Safari ${ua.match(/Version\/(\d+)/)?.[1] ?? ""}`;
    else if (ua.includes("Edg/")) info.browserInfo = `Edge ${ua.match(/Edg\/(\d+)/)?.[1] ?? ""}`;
    else info.browserInfo = ua.slice(0, 30);
    // Device memory
    info.deviceMemGB = (navigator as any).deviceMemory ?? null;
    // Heap JS (Chrome)
    try { const m = (performance as any).memory; if (m) { info.memUsedMB = Math.round(m.usedJSHeapSize / 1048576); info.memTotalMB = Math.round(m.totalJSHeapSize / 1048576); info.memLimitMB = Math.round(m.jsHeapSizeLimit / 1048576); } } catch { /* ok */ }
    // Storage
    try { const e = await navigator.storage.estimate(); info.storageUsedMB = Math.round((e.usage ?? 0) / 1048576); info.storageQuotaMB = Math.round((e.quota ?? 0) / 1048576); info.storagePct = info.storageQuotaMB > 0 ? Math.round((info.storageUsedMB! / info.storageQuotaMB) * 100) : 0; } catch { /* ok */ }
    // Proxy
    try {
      const domain = window.location.hostname !== "localhost" ? window.location.origin : "";
      const r = await fetch(`${domain}/api/healthz`);
      info.proxyOk = r.ok;
    } catch { info.proxyOk = false; }
    // GitHub rate limit
    const tok = localStorage.getItem("gh_token");
    if (tok) { try { const r = await fetch("https://api.github.com/rate_limit", { headers: { Authorization: `token ${tok}` } }); if (r.ok) { const d = await r.json(); info.ghRateLimit = d.rate?.remaining ?? null; info.ghRateLimitReset = d.rate?.reset ? new Date(d.rate.reset * 1000).toLocaleTimeString("pt-BR") : null; } } catch { /* ok */ } }
    setSysInfo(info);
    setSysChecking(false);
  }, []);

  /* ── Effects ── */
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chat]);

  useEffect(() => {
    if (ghToken) localStorage.setItem("gh_token", ghToken);
  }, [ghToken]);
  useEffect(() => {
    if (driveToken) localStorage.setItem("drive_token", driveToken);
  }, [driveToken]);
  useEffect(() => {
    localStorage.setItem("custom_api_url", aiKeys.url);
    localStorage.setItem("custom_api_key", aiKeys.key);
    localStorage.setItem("custom_api_model", aiKeys.model);
  }, [aiKeys]);

  // Load saved session metadata on mount + check system
  useEffect(() => {
    getSavedMeta().then(m => { if (m) setSavedMeta(m); });
    checkSystem();
    const id = setInterval(checkSystem, 30000);
    return () => clearInterval(id);
  }, [checkSystem]);

  // Auto-detect GitHub user when token changes
  useEffect(() => {
    if (!ghToken || ghToken.length < 10) { setGhUser(null); setGhRepos([]); return; }
    const t = setTimeout(async () => {
      try {
        const user = await ghGetUser(ghToken);
        setGhUser(user);
        const repos = await ghListRepos(ghToken);
        setGhRepos(repos);
        setGhMsg(`✅ Conectado como @${user.login}`);
      } catch (e) {
        setGhUser(null);
        setGhMsg("❌ " + String(e));
      }
    }, 600);
    return () => clearTimeout(t);
  }, [ghToken]);

  /* ── Import file ── */
  async function handleFileImport(file: File) {
    setImportLoading(true);
    setAnalysis(null); setCleanedFiles(null); setNameApplied(false);
    const isApk = file.name.toLowerCase().endsWith(".apk");
    setImportInfo(isApk ? `Abrindo APK ${file.name}...` : `Lendo ${file.name}...`);
    try {
      const extracted = isApk ? await extractApk(file) : await extractArchive(file);
      const a = analyzeProject(extracted, file.name.replace(/\.(apk|zip|tar\.gz|tgz|tar)$/i, ""));
      setAnalysis(a);
      setCustomName(a.detectedName);
      // Auto-clean: remove unnecessary files
      const cleaned = extracted.filter(f => !a.unnecessaryFiles.includes(f.path));
      setCleanedFiles(cleaned);
      setFiles(cleaned);
      const newCfg = { ...DEFAULT_CFG, appName: a.detectedName, appId: a.detectedId };
      setCfg(newCfg);
      const src = `${isApk ? "APK" : "Arquivo"}: ${file.name} (${cleaned.length} arquivos${a.unnecessaryFiles.length ? `, ${a.unnecessaryFiles.length} removidos` : ""})`;
      setSource(src);
      setProjectReady(true);
      setResultBlob(null);
      setImportInfo(`✅ ${cleaned.length} arquivos · análise pronta`);
      const slug1 = a.detectedId.split(".").pop() || a.detectedName.toLowerCase().replace(/\s+/g, "-");
      setPushRepoName(slug1 + "-android");
      setPagesRepoName(slug1 + "-pwa");
      await doSave(newCfg, src, cleaned);
      // Stay on import tab to show the analysis panel
    } catch (e) {
      setImportInfo("❌ " + String(e));
    } finally {
      setImportLoading(false);
    }
  }

  /* ── Apply custom name to project ── */
  function applyCustomName() {
    if (!customName.trim()) return;
    const slug = customName.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const newId = `com.meuapp.${slug}`;
    setCfg(c => ({ ...c, appName: customName.trim(), appId: newId }));
    setPushRepoName(slug + "-android");
    setPagesRepoName(slug + "-pwa");
    setNameApplied(true);
  }

  async function handleImportAssistenteJuridico() {
    setImportLoading(true);
    setImportInfo("Carregando Assistente Jurídico...");
    try {
      const resp = await fetch(`${import.meta.env.BASE_URL}assistente-juridico-pwa.zip`);
      if (!resp.ok) throw new Error("Arquivo não encontrado — tente recarregar a página");
      const blob = await resp.blob();
      const file = new File([blob], "assistente-juridico-pwa.zip", { type: "application/zip" });
      const extracted = await extractArchive(file);
      const newCfg = {
        ...DEFAULT_CFG,
        appName: "Assistente Jurídico",
        appId: "br.com.maikoncaldeira.assistentejuridico",
        themeColor: "#1e40af",
        bgColor: "#0f172a",
      };
      setFiles(extracted);
      setCfg(newCfg);
      const src = `Assistente Jurídico (${extracted.length} arquivos)`;
      setSource(src);
      setProjectReady(true);
      setResultBlob(null);
      setPushRepoName("assistente-juridico-android");
      setPagesRepoName("assistente-juridico-pwa");
      setCiRepoOwner("");
      setCiRepoName("assistente-juridico-android");
      setImportInfo(`✅ ${extracted.length} arquivos carregados`);
      setTab("export");
      await doSave(newCfg, src, extracted);
    } catch (e) {
      setImportInfo("❌ " + String(e));
    } finally {
      setImportLoading(false);
    }
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (f) handleFileImport(f);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files?.[0]; if (f) handleFileImport(f);
  }

  /* ── Restore session ── */
  async function restoreSession() {
    setRestoring(true);
    try {
      const s = await loadSession();
      if (!s) { setStatus("Nenhuma sessão salva encontrada", false); return; }
      setFiles(s.files); setCfg(s.cfg); setSource(s.source);
      setProjectReady(true); setResultBlob(null);
      const slug2 = s.cfg.appId.split(".").pop() || "";
      setPushRepoName(slug2 + "-android");
      setPagesRepoName(slug2 + "-pwa");
      setTab("export");
      setStatus("Sessão restaurada com sucesso!", true);
    } catch (e) {
      setStatus("Erro ao restaurar: " + String(e), false);
    } finally {
      setRestoring(false);
    }
  }

  /* ── GitHub import ── */
  async function handleGhImport(repo: GhRepo | null) {
    const target = repo || ghSelectedRepo;
    if (!target || !ghToken) return;
    setGhLoading(true); setGhMsg("Importando...");
    try {
      const [owner, name] = target.full_name.split("/");
      const imported = await ghImportRepo(ghToken, owner, name, target.default_branch, setGhMsg);
      const newCfg = {
        ...DEFAULT_CFG,
        appName: target.name,
        appId: `com.github.${name.replace(/[^a-z0-9]/gi, "").toLowerCase()}`,
      };
      setFiles(imported); setCfg(newCfg);
      const src = `GitHub: ${target.full_name}@${target.default_branch}`;
      setSource(src); setProjectReady(true); setResultBlob(null);
      setPushRepoName(name + "-android");
      setPagesRepoName(name + "-pwa");
      setGhMsg(`✅ ${imported.length} arquivos importados!`);
      setTab("export");
      await doSave(newCfg, src, imported);
    } catch (e) {
      setGhMsg("❌ " + String(e));
    } finally {
      setGhLoading(false);
    }
  }

  async function handleGhCustomImport() {
    if (!ghToken || !ghCustomRepo.trim()) return;
    setGhLoading(true); setGhMsg("Buscando repositório...");
    try {
      const parts = ghCustomRepo.replace("https://github.com/", "").split("/");
      const [owner, name] = parts.slice(-2);
      const repo = await ghGetRepo(ghToken, owner, name);
      setGhSelectedRepo(repo);
      await handleGhImport(repo);
    } catch (e) {
      setGhMsg("❌ " + String(e));
      setGhLoading(false);
    }
  }

  /* ── Import público sem token ── */
  async function handlePublicRepoImport() {
    if (!ghPublicRepo.trim()) return;
    setGhPublicLoading(true);
    setGhPublicMsg("Acessando repositório público...");
    try {
      const { files: imported, repoName, branch } = await ghImportPublicRepo(ghPublicRepo, setGhPublicMsg);
      const newCfg = {
        ...DEFAULT_CFG,
        appName: repoName,
        appId: `com.github.${repoName.replace(/[^a-z0-9]/gi, "").toLowerCase()}`,
      };
      setFiles(imported); setCfg(newCfg);
      const src = `GitHub (público): ${ghPublicRepo.trim()}@${branch}`;
      setSource(src); setProjectReady(true); setResultBlob(null);
      setPushRepoName(repoName + "-android");
      setPagesRepoName(repoName + "-pwa");
      setGhPublicMsg(`✅ ${imported.length} arquivos importados de ${repoName}!`);
      setTab("export");
      await doSave(newCfg, src, imported);
    } catch (e) {
      setGhPublicMsg("❌ " + String(e));
    } finally {
      setGhPublicLoading(false);
    }
  }

  /* ── URL Import / PWA Analyzer ── */
  async function handleUrlImport() {
    let target = urlInput.trim();
    if (!target) return;
    if (!target.startsWith("http")) target = "https://" + target;

    setUrlLoading(true);
    setUrlMsg("Acessando site...");
    setUrlIssues([]);

    const issues: { type: "ok" | "warn" | "err"; text: string }[] = [];
    const fetched: ArchiveFile[] = [];

    // Tenta 3 proxies CORS em paralelo — usa o primeiro que responder com sucesso
    const proxyUrl = (u: string, p: number) => [
      `https://corsproxy.io/?${encodeURIComponent(u)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
    ][p];

    const fetchViaProxy = async (url: string): Promise<Response> => {
      const attempts = [0, 1, 2].map(p =>
        fetch(proxyUrl(url, p)).then(r => {
          if (r.ok) return r;
          throw new Error(String(r.status));
        })
      );
      const results = await Promise.allSettled(attempts);
      const ok = results.find((r): r is PromiseFulfilledResult<Response> => r.status === "fulfilled");
      if (ok) return ok.value;
      const statuses = results.map(r => r.status === "rejected" ? (r.reason as Error).message : "ok").join(", ");
      throw new Error(`Site bloqueou o acesso via proxy (${statuses}). Tente importar via ZIP ou GitHub.`);
    };

    try {
      // 1. HTML principal
      setUrlMsg("Tentando acessar o site...");
      const htmlResp = await fetchViaProxy(target);
      if (!htmlResp.ok) throw new Error(`Site retornou ${htmlResp.status}`);
      const html = await htmlResp.text();
      fetched.push({ path: "index.html", content: new TextEncoder().encode(html).buffer as ArrayBuffer });
      issues.push({ type: "ok", text: "HTML principal baixado" });

      // 2. Manifest
      const mHref =
        html.match(/<link[^>]+rel=["']manifest["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
        html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']manifest["']/i)?.[1];

      let manifestData: Record<string, unknown> | null = null;
      if (mHref) {
        setUrlMsg("Baixando manifest.json...");
        try {
          const mUrl = new URL(mHref, target).href;
          const mResp = await fetchViaProxy(mUrl);
          const mText = await mResp.text();
          manifestData = JSON.parse(mText) as Record<string, unknown>;
          fetched.push({ path: "manifest.json", content: new TextEncoder().encode(mText).buffer as ArrayBuffer });
          const appLabel = (manifestData.name || manifestData.short_name || "?") as string;
          issues.push({ type: "ok", text: `manifest.json encontrado — App: "${appLabel}"` });
          if (!manifestData.name && !manifestData.short_name) issues.push({ type: "warn", text: "Sem name/short_name no manifest" });
          if (!manifestData.start_url) issues.push({ type: "warn", text: "Sem start_url no manifest" });
          if (!manifestData.display) issues.push({ type: "warn", text: "Sem display: standalone no manifest" });
          else issues.push({ type: "ok", text: `display: ${manifestData.display}` });
          if (!manifestData.theme_color) issues.push({ type: "warn", text: "Sem theme_color" });
          if (!manifestData.background_color) issues.push({ type: "warn", text: "Sem background_color" });
        } catch {
          issues.push({ type: "err", text: "manifest.json não pôde ser baixado ou é inválido JSON" });
        }
      } else {
        issues.push({ type: "err", text: "manifest.json não encontrado — site pode não ser PWA" });
        // Cria manifest mínimo automaticamente
        const domain = new URL(target).hostname.replace(/^www\./, "");
        const auto = { name: domain, short_name: domain.split(".")[0], start_url: "/", display: "standalone", theme_color: "#6366f1", background_color: "#080c18", icons: [{ src: "icons/icon-192.png", sizes: "192x192", type: "image/png" }] };
        fetched.push({ path: "manifest.json", content: new TextEncoder().encode(JSON.stringify(auto, null, 2)).buffer as ArrayBuffer });
        issues.push({ type: "warn", text: "manifest.json básico gerado automaticamente" });
      }

      // 3. Service Worker
      if (/serviceWorker/i.test(html)) issues.push({ type: "ok", text: "Service Worker detectado no HTML" });
      else issues.push({ type: "warn", text: "Service Worker não detectado (PWA pode não funcionar offline)" });

      // 4. Ícones
      const icons = (manifestData?.icons as { src: string; sizes: string }[] | undefined) || [];
      if (icons.length > 0) {
        setUrlMsg("Baixando ícones...");
        let ok = 0;
        for (const icon of icons.slice(0, 8)) {
          try {
            const iconUrl = new URL(icon.src, target).href;
            const iResp = await fetchViaProxy(iconUrl);
            if (!iResp.ok) continue;
            const ibuf = await iResp.arrayBuffer();
            const fname = icon.src.split("/").pop() || `icon-${icon.sizes}.png`;
            fetched.push({ path: `icons/${fname}`, content: ibuf });
            ok++;
          } catch { /* skip */ }
        }
        if (ok > 0) issues.push({ type: "ok", text: `${ok} ícone(s) baixado(s)` });
        else issues.push({ type: "warn", text: "Ícones declarados no manifest mas bloqueados por CORS" });
      } else {
        issues.push({ type: "err", text: "Nenhum ícone no manifest — obrigatório para instalar como app" });
      }

      // 5. Finaliza
      const domain = new URL(target).hostname.replace(/^www\./, "");
      const siteName = ((manifestData?.name || manifestData?.short_name || domain) as string);
      const siteId = "com." + domain.replace(/[^a-z0-9]/gi, ".").toLowerCase().replace(/\.+/g, ".").replace(/^\.|\.$/g, "");
      const newCfg = {
        ...DEFAULT_CFG,
        appName: siteName,
        appId: siteId,
        themeColor: (manifestData?.theme_color as string) || "#6366f1",
        bgColor: (manifestData?.background_color as string) || "#080c18",
      };
      setFiles(fetched);
      setCfg(newCfg);
      const src = `URL: ${target}`;
      setSource(src);
      setProjectReady(true);
      setResultBlob(null);
      const slug3 = siteId.split(".").pop() || "meu-app";
      setPushRepoName(slug3 + "-android");
      setPagesRepoName(slug3 + "-pwa");
      await doSave(newCfg, src, fetched);
      setUrlMsg(`✅ ${fetched.length} arquivos obtidos`);
      setUrlIssues(issues);
      setTab("export");
    } catch (e) {
      setUrlMsg("❌ " + String(e));
      setUrlIssues(issues);
    } finally {
      setUrlLoading(false);
    }
  }

  /* ── EAS (Expo) build: gera projeto Expo → GitHub → compila APK ── */
  async function handleEASDeploy() {
    if (!files.length || !ghToken || !ghUser) return;
    setEasLoading(true); setEasMsg("⚙ Gerando projeto Expo + WebView..."); setEasRunUrl("");
    const hdrs = { Authorization: `token ${ghToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    const slug = (cfg.appName || "meu-app").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const repoName = slug + "-eas";
    const useCloud = !!easToken.trim();

    // Persiste token se fornecido
    if (useCloud) localStorage.setItem("expo_token", easToken.trim());

    try {
      const easFiles = await buildEASFilesForGithub(cfg, files, source, useCloud ? genEASCloudWorkflow : undefined);

      setEasMsg("📦 Criando repositório no GitHub...");
      await ghCreateRepo(ghToken, repoName, cfg.appName, false);

      if (useCloud) {
        setEasMsg("🔐 Configurando EXPO_TOKEN como secret do repositório...");
        await ghSetRepoSecret(ghToken, ghUser.login, repoName, "EXPO_TOKEN", easToken.trim());
        setEasMsg("✅ Secret EXPO_TOKEN configurado!");
        await new Promise(r => setTimeout(r, 1500));
      }

      setEasMsg(`📤 Enviando ${easFiles.length} arquivos (projeto Expo + web)...`);
      await ghPushFiles(ghToken, ghUser.login, repoName, easFiles,
        `chore: projeto Expo EAS${useCloud ? " Cloud" : " Local"} — ${cfg.appName} v${cfg.versionName}`, setEasMsg);

      setEasMsg("🚀 Aguardando GitHub Actions iniciar...");
      await new Promise(r => setTimeout(r, 10000));
      await fetch(`https://api.github.com/repos/${ghUser.login}/${repoName}/actions/workflows/build-apk.yml/dispatches`, {
        method: "POST", headers: { ...hdrs, "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "main" }),
      });
      await new Promise(r => setTimeout(r, 6000));

      // Poll por conclusão (até 30 min para EAS cloud, 20 min local)
      const maxPolls = useCloud ? 60 : 40;
      for (let i = 0; i < maxPolls; i++) {
        const r = await fetch(`https://api.github.com/repos/${ghUser.login}/${repoName}/actions/runs?per_page=1`, { headers: hdrs });
        const d = await r.json() as { workflow_runs?: { id: number; status: string; conclusion: string | null; html_url: string }[] };
        const run = d.workflow_runs?.[0];
        if (run) {
          setEasRunUrl(run.html_url);
          if (run.status === "completed") {
            if (run.conclusion === "success") {
              setEasMsg(`✅ APK pronto! Clique no link → aba "Artifacts" → baixe o APK.`);
            } else {
              setEasMsg(`❌ Build falhou (${run.conclusion}). Veja detalhes no link.`);
            }
            break;
          }
          const modeLabel = useCloud ? "EAS Cloud (conta Expo)" : "Expo Prebuild local";
          setEasMsg(`⏳ ${run.status === "in_progress" ? `Compilando via ${modeLabel}` : "Na fila"}... (~${useCloud ? "10–20" : "10–15"} min)`);
        } else {
          setEasMsg("⏳ Aguardando GitHub Actions iniciar...");
        }
        await new Promise(r => setTimeout(r, 30000));
      }
    } catch (e) {
      setEasMsg("❌ " + String(e));
    } finally {
      setEasLoading(false);
    }
  }

  /* ── Pipeline completo: gera → GitHub → compila APK ── */
  async function handleFullDeploy() {
    if (!files.length || !ghToken || !ghUser) return;
    setPipeLoading(true); setPipeMsg("⚙ Preparando projeto Android..."); setPipeRunUrl("");
    const hdrs = { Authorization: `token ${ghToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    const slug = (cfg.appName || "meu-app").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const repoName = slug + "-android";
    try {
      // 1. Gera arquivos do projeto Android
      const androidFiles = await buildAndroidFilesForGithub(cfg, files, source);

      // 2. Cria repositório no GitHub
      setPipeMsg("📦 Criando repositório no GitHub...");
      await ghCreateRepo(ghToken, repoName, cfg.appName, false);

      // 3. Envia arquivos
      setPipeMsg(`📤 Enviando ${androidFiles.length} arquivos para o GitHub...`);
      await ghPushFiles(ghToken, ghUser.login, repoName, androidFiles,
        `chore: projeto Android — ${cfg.appName} v${cfg.versionName}`, setPipeMsg);

      // 4. Aguarda GitHub Actions ser ativado e dispara manualmente
      setPipeMsg("🚀 Aguardando GitHub Actions iniciar...");
      await new Promise(r => setTimeout(r, 10000));
      await fetch(`https://api.github.com/repos/${ghUser.login}/${repoName}/actions/workflows/build-apk.yml/dispatches`, {
        method: "POST", headers: { ...hdrs, "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "main" }),
      });
      await new Promise(r => setTimeout(r, 6000));

      // 5. Poll por conclusão (até 25 min)
      for (let i = 0; i < 50; i++) {
        const r = await fetch(`https://api.github.com/repos/${ghUser.login}/${repoName}/actions/runs?per_page=1`, { headers: hdrs });
        const d = await r.json() as { workflow_runs?: { id: number; status: string; conclusion: string | null; html_url: string }[] };
        const run = d.workflow_runs?.[0];
        if (run) {
          setPipeRunUrl(run.html_url);
          if (run.status === "completed") {
            if (run.conclusion === "success") {
              setPipeMsg(`✅ APK compilado com sucesso! Abra o link abaixo → aba "Artifacts" → baixe o APK.`);
            } else {
              setPipeMsg(`❌ Build falhou (${run.conclusion}). Veja detalhes no link.`);
            }
            break;
          }
          setPipeMsg(`⏳ ${run.status === "in_progress" ? "Compilando APK" : "Na fila"}... aguarde ~10 min`);
        } else {
          setPipeMsg("⏳ Aguardando GitHub Actions iniciar...");
        }
        await new Promise(r => setTimeout(r, 30000));
      }
    } catch (e) {
      setPipeMsg("❌ " + String(e));
    } finally {
      setPipeLoading(false);
    }
  }

  /* ── GitHub Actions cloud build ── */
  async function handleCiBuild() {
    if (!ghToken || !ciRepoOwner || !ciRepoName) return;
    setCiLoading(true); setCiMsg("Disparando build na nuvem..."); setCiRunUrl("");
    const hdrs = { Authorization: `token ${ghToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    try {
      // Tenta disparar via workflow_dispatch
      await fetch(`https://api.github.com/repos/${ciRepoOwner}/${ciRepoName}/actions/workflows/build-apk.yml/dispatches`, {
        method: "POST", headers: { ...hdrs, "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "main" }),
      });

      setCiMsg("⏳ Build iniciado — aguardando GitHub Actions...");
      await new Promise(r => setTimeout(r, 8000));

      // Poll por até 25 min
      for (let i = 0; i < 50; i++) {
        const r = await fetch(`https://api.github.com/repos/${ciRepoOwner}/${ciRepoName}/actions/runs?per_page=1`, { headers: hdrs });
        const data = await r.json() as { workflow_runs?: { id: number; status: string; conclusion: string | null; html_url: string }[] };
        const run = data.workflow_runs?.[0];
        if (run) {
          setCiRunUrl(run.html_url);
          if (run.status === "completed") {
            if (run.conclusion === "success") {
              setCiMsg(`✅ APK compilado! Baixe em: ${run.html_url}`);
            } else {
              setCiMsg(`❌ Build falhou (${run.conclusion}). Veja detalhes: ${run.html_url}`);
            }
            break;
          } else {
            setCiMsg(`⏳ ${run.status === "in_progress" ? "Compilando" : "Na fila"}... (~5–10 min)`);
          }
        }
        await new Promise(r => setTimeout(r, 30000));
      }
    } catch (e) {
      setCiMsg("❌ " + String(e));
    } finally {
      setCiLoading(false);
    }
  }

  /* ── Generate Android ZIP ── */
  async function handleGenerate() {
    if (!cfg.appName || !cfg.appId || !files.length) return;
    setGenerating(true); setProgress(0);
    try {
      for (const p of [10, 30, 60, 85]) {
        await new Promise(r => setTimeout(r, 200));
        setProgress(p);
      }
      const blob = await buildAndroidZip(cfg, files, source);
      setProgress(100);
      const safeName = cfg.appName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
      const name = `${safeName}-android-v${cfg.versionName}.zip`;
      setResultBlob(blob); setResultName(name);
      await doSave(cfg, source, files);
    } catch (e) {
      setStatus("Erro ao gerar: " + String(e), false);
    } finally {
      setGenerating(false);
    }
  }

  /* ── Drive upload ── */
  async function handleDriveUpload() {
    if (!resultBlob || !driveToken) return;
    setDriveLoading(true); setDriveMsg("Enviando para o Drive...");
    try {
      const link = await uploadToDrive(driveToken, resultBlob, resultName);
      setDriveMsg(`✅ Enviado! ${link}`);
    } catch (e) {
      setDriveMsg("❌ " + String(e));
    } finally {
      setDriveLoading(false);
    }
  }

  /* ── GitHub push ── */
  async function handleGhPush() {
    if (!resultBlob || !ghToken || !pushRepoName.trim()) return;
    setPushLoading(true); setPushMsg("Criando repositório...");
    try {
      if (!ghUser) throw new Error("Faça login com seu token GitHub primeiro");
      const repoInfo = await ghCreateRepo(ghToken, pushRepoName.trim(),
        `Projeto Android — ${cfg.appName}`, pushPrivate);
      setPushMsg("Preparando arquivos...");

      // Convert files: add path prefix for the android project
      const allFiles: ArchiveFile[] = [
        ...files.map(f => ({ path: `dist/${f.path}`, content: f.content })),
      ];

      await ghPushFiles(ghToken, ghUser.login, pushRepoName.trim(), allFiles,
        `chore: initial project — ${cfg.appName} v${cfg.versionName}`, setPushMsg);

      setPushMsg(`✅ Repositório criado: ${repoInfo.html_url}`);
    } catch (e) {
      setPushMsg("❌ " + String(e));
    } finally {
      setPushLoading(false);
    }
  }

  /* ── GitHub Pages publish ── */
  async function handlePublishPages() {
    if (!files.length || !ghToken || !pagesRepoName.trim()) return;
    setPagesLoading(true); setPagesMsg("Iniciando publicação..."); setPagesUrl("");
    try {
      if (!ghUser) throw new Error("Faça login com seu token GitHub (aba GitHub) primeiro");
      const url = await ghPublishPages(ghToken, pagesRepoName.trim(), files, pagesPrivate, setPagesMsg);
      setPagesUrl(url);
      setPagesMsg(`✅ Publicado! Aguarde ~1 min para o GitHub Pages ativar: ${url}`);
    } catch (e) {
      setPagesMsg("❌ " + String(e));
    } finally {
      setPagesLoading(false);
    }
  }

  /* ── AI chat ── */
  const sendChat = useCallback(async (text?: string) => {
    const msg = (text || chatInput).trim();
    if (!msg || !aiKeys.key) return;
    setChatInput("");
    const history: ChatMsg[] = [...chat, { role: "user", text: msg }];
    setChat(history);
    setChatLoading(true);
    try {
      const ctx = projectReady
        ? `Projeto: ${source}. App: ${cfg.appName} (${cfg.appId}). ${files.length} arquivos.`
        : "";
      const reply = await callAI(aiKeys, msg, ctx);
      setChat(c => [...c, { role: "assistant", text: reply }]);
    } catch (e) {
      setChat(c => [...c, { role: "assistant", text: "❌ " + String(e) }]);
    } finally {
      setChatLoading(false);
    }
  }, [chat, chatInput, aiKeys, projectReady, source, cfg, files.length]);

  const toggleVoice = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { alert("Navegador sem suporte a voz."); return; }
    if (listening) { recognRef.current?.stop(); setListening(false); return; }
    const r = new SR();
    r.lang = "pt-BR"; r.continuous = false; r.interimResults = false;
    r.onresult = (e: any) => sendChat(e.results[0][0].transcript);
    r.onend = () => setListening(false);
    recognRef.current = r; r.start(); setListening(true);
  }, [listening, sendChat]);

  /* ── Status helper ── */
  function setStatus(text: string, ok: boolean) {
    setStatusMsg({ text, ok });
    setTimeout(() => setStatusMsg(null), 4000);
  }

  /* ── Save helper com feedback visível ── */
  async function doSave(cfg: AppConfig, src: string, files: ArchiveFile[]) {
    try {
      const result: SaveResult = await saveSession(cfg, src, files);
      if (result === "quota-exceeded") {
        setStatus("⚠️ Projeto carregado, mas não foi possível salvar os arquivos (armazenamento cheio). Recarregue a página para usar novamente.", false);
      } else if (result === "meta-only") {
        setStatus("⚠️ Projeto grande demais para salvar localmente (>5000 arquivos). Metadados salvos.", false);
      }
      setSavedMeta(await getSavedMeta());
    } catch (e) {
      setStatus("⚠️ Erro ao salvar sessão: " + String(e), false);
    }
  }

  /* ── Cérebro / Brain ── */
  function generateBrain() {
    return {
      version: 1,
      gerado_em: new Date().toLocaleString("pt-BR"),
      projeto: projectReady ? {
        nome: cfg.appName, package_id: cfg.appId, versao: cfg.versionName,
        arquivos: files.length, arvore: files.slice(0, 150).map(f => f.path), origem: source,
      } : null,
      conversa: chat.map((m, i) => ({ n: i + 1, papel: m.role === "user" ? "Você" : "IA", texto: m.text.slice(0, 2000) })),
      config: cfg,
    };
  }

  function exportBrain() {
    const b = generateBrain();
    const nome = (cfg.appName || "projeto").replace(/[^a-z0-9]/gi, "-").toLowerCase();
    downloadBlob(new Blob([JSON.stringify(b, null, 2)], { type: "application/json" }), `cerebro-${nome}.json`);
  }

  function exportChatJson() {
    if (!chat.length) { alert("Nenhuma mensagem para exportar."); return; }
    downloadBlob(
      new Blob([JSON.stringify({ gerado: new Date().toISOString(), mensagens: chat }, null, 2)], { type: "application/json" }),
      "conversa-ia.json"
    );
  }

  function activateBrain() {
    const b = generateBrain();
    const proj = b.projeto
      ? `📦 Projeto: ${b.projeto.nome} (${b.projeto.package_id}) · ${b.projeto.arquivos} arquivos\nOrigem: ${b.projeto.origem}\nArquivos principais: ${b.projeto.arvore.slice(0, 30).join(", ")}`
      : "Nenhum projeto carregado ainda.";
    const hist = b.conversa.length > 0
      ? `\n💬 Histórico: ${b.conversa.length} mensagens`
      : "\nSem histórico de conversa.";
    const msg = `[🧠 ATIVAR CÉREBRO — Contexto completo do projeto]\nGerado: ${b.gerado_em}\n${proj}${hist}\nConfig: ${JSON.stringify(b.config)}\n\nCom base neste contexto, resuma o que você sabe sobre meu projeto e como pode me ajudar agora.`;
    sendChat(msg);
  }

  /* ── Open Code Editor ── */
  const BASE = import.meta.env.BASE_URL;
  const codeEditorUrl = BASE.replace("/apk-builder/", "/sk-code-editor/");

  /* ─────────────────────────────────────────────────────────
     UI helpers
  ──────────────────────────────────────────────────────────── */
  const tabCls = (t: Tab) =>
    `px-3 py-2 text-xs font-bold rounded-lg transition-all ${tab === t
      ? "bg-violet-600 text-white"
      : "text-slate-400 hover:text-white hover:bg-slate-700"}`;

  const field = (
    label: string, val: string,
    onChange: (v: string) => void,
    extra?: React.InputHTMLAttributes<HTMLInputElement>
  ) => (
    <div>
      <label className="text-xs text-slate-400 block mb-1">{label}</label>
      <input
        className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm focus:border-violet-500 outline-none placeholder-slate-500"
        value={val} onChange={e => onChange(e.target.value)} {...extra}
      />
    </div>
  );

  const colorField = (label: string, val: string, onChange: (v: string) => void) => (
    <div>
      <label className="text-xs text-slate-400 block mb-1">{label}</label>
      <div className="flex gap-2">
        <input type="color" className="w-10 h-10 rounded border-0 bg-transparent cursor-pointer shrink-0"
          value={val} onChange={e => onChange(e.target.value)} />
        <input className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm font-mono focus:border-violet-500 outline-none"
          value={val} onChange={e => onChange(e.target.value)} />
      </div>
    </div>
  );

  const filteredRepos = ghRepos.filter(r =>
    !ghRepoFilter || r.name.toLowerCase().includes(ghRepoFilter.toLowerCase())
  );

  /* ══════════════════════════════════════════════════════════
     RENDER
  ══════════════════════════════════════════════════════════════ */
  return (
    <div className="min-h-screen bg-[#080c18] text-white flex flex-col">

      {/* ── Header ── */}
      <header className="border-b border-slate-800 bg-[#0a0f1e]/95 backdrop-blur sticky top-0 z-30 px-4 py-2.5">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <div className="w-9 h-9 bg-violet-600 rounded-xl flex items-center justify-center text-xl shrink-0">📦</div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 leading-none">
              <h1 className="font-bold text-sm">ConstruAPK Pro</h1>
              <span className="text-[10px] font-mono bg-violet-900/60 text-violet-300 border border-violet-700/50 px-1.5 py-0.5 rounded-full shrink-0">{APP_VERSION}</span>
            </div>
            <p className="text-xs text-slate-500 truncate">
              {projectReady ? `📱 ${cfg.appName || "Sem nome"} · ${files.length} arquivos` : "PWA → Android APK nativo"}
            </p>
          </div>
          <nav className="ml-auto flex gap-1 flex-wrap justify-end items-center">
            <button className={`${tabCls("downloads")} bg-green-700 text-white hover:bg-green-600`} onClick={() => setTab("downloads")}>⬇ APKs</button>
            <button className={tabCls("import")} onClick={() => setTab("import")}>📂 Importar</button>
            <button className={tabCls("github")} onClick={() => setTab("github")}>🐙 GitHub</button>
            <button className={tabCls("export")} onClick={() => setTab("export")}>📤 Exportar</button>
            <button className={tabCls("ai")} onClick={() => setTab("ai")}>🤖 IA</button>
            <button className={tabCls("terminal")} onClick={() => setTab("terminal")}>⌨ Terminal</button>
            <button className={tabCls("analisar")} onClick={() => setTab("analisar")}>🔍 Analisar</button>
            <button
              className={`${tabCls("guide")} flex items-center gap-1`}
              onClick={() => setTab("guide")}
              title={sysInfo.proxyOk === true ? "Sistema OK" : sysInfo.proxyOk === false ? "Proxy offline" : "Verificando..."}>
              📖 <span className={`w-2 h-2 rounded-full inline-block ${sysInfo.proxyOk === true ? "bg-green-400" : sysInfo.proxyOk === false ? "bg-red-400" : "bg-yellow-400 animate-pulse"}`}></span>
            </button>
          </nav>
        </div>
      </header>

      {/* ── Status toast ── */}
      {statusMsg && (
        <div className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl text-sm font-semibold shadow-xl transition-all ${statusMsg.ok ? "bg-green-700" : "bg-red-700"}`}>
          {statusMsg.text}
        </div>
      )}

      <main className="max-w-3xl mx-auto w-full px-4 py-5 flex-1 space-y-4">

        {/* ══ TAB: IMPORTAR ══════════════════════════════════════ */}
        {tab === "import" && (
          <>
            {/* Saved session banner */}
            {savedMeta && !projectReady && (
              <div className="bg-violet-900/20 border border-violet-700/40 rounded-xl p-4 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-violet-300">💾 Sessão salva encontrada</p>
                  <p className="text-xs text-slate-400">
                    {savedMeta.cfg.appName} · {savedMeta.fileCount} arquivos ·{" "}
                    {new Date(savedMeta.savedAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button onClick={restoreSession} disabled={restoring}
                    className="px-3 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded-lg text-xs font-bold">
                    {restoring ? "..." : "↩ Restaurar"}
                  </button>
                  <button onClick={async () => { await clearSession(); setSavedMeta(null); }}
                    className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs font-bold text-slate-400">
                    🗑
                  </button>
                </div>
              </div>
            )}

            {/* Drop zone */}
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
              className={`border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all ${dragOver ? "border-violet-400 bg-violet-900/20" : importLoading ? "border-violet-500 bg-violet-900/10" : projectReady ? "border-green-600 bg-green-900/10" : "border-slate-600 hover:border-violet-500 hover:bg-violet-900/10"}`}
            >
              {importLoading ? (
                <><div className="text-4xl animate-spin mb-3">⚙</div><p className="text-violet-400 font-semibold">{importInfo}</p></>
              ) : projectReady ? (
                <><div className="text-4xl mb-2">✅</div>
                  <p className="font-semibold text-green-400">{source}</p>
                  <p className="text-xs text-slate-400 mt-1">{files.length} arquivos carregados · Clique para reimportar</p></>
              ) : (
                <><div className="text-5xl mb-3">📦</div>
                  <p className="font-bold text-lg">Arraste ou clique para importar</p>
                  <p className="text-sm text-slate-400 mt-1">
                    <span className="text-violet-300 font-mono">.apk</span> · <span className="text-violet-300 font-mono">.zip</span> · <span className="text-violet-300 font-mono">.tar</span> · <span className="text-violet-300 font-mono">.tar.gz</span>
                  </p>
                  <p className="text-xs text-slate-500 mt-2">Importe um <strong className="text-violet-300">APK existente</strong> para editar e regerar, ou um ZIP do seu PWA</p></>
              )}
              <input ref={fileRef} type="file" accept=".zip,.tar,.tar.gz,.tgz,.apk" className="hidden" onChange={onFileInput} />
            </div>

            {/* ══ PAINEL DE ANÁLISE AUTOMÁTICA ══════════════════════ */}
            {analysis && (
              <div className="space-y-3">

                {/* ── Nome do app ── */}
                <div className="bg-slate-900/80 border border-violet-700/50 rounded-2xl p-4 space-y-3">
                  <p className="text-xs font-semibold text-violet-300 tracking-widest">✏️ NOME DO APLICATIVO</p>
                  <div className="flex gap-2">
                    <input
                      value={customName}
                      onChange={e => { setCustomName(e.target.value); setNameApplied(false); }}
                      placeholder="Nome do seu app..."
                      className="flex-1 rounded-xl bg-slate-800 border border-slate-600 px-3 py-2 text-sm focus:outline-none focus:border-violet-500"
                    />
                    <button
                      onClick={applyCustomName}
                      className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${nameApplied ? "bg-green-600 text-white" : "bg-violet-600 hover:bg-violet-500 text-white"}`}
                    >
                      {nameApplied ? "✅ Aplicado" : "Aplicar"}
                    </button>
                  </div>
                  {/* Sugestões de nomes */}
                  <div className="flex flex-wrap gap-1.5">
                    <p className="text-[10px] text-slate-500 w-full">Sugestões:</p>
                    {[
                      analysis.detectedName,
                      analysis.detectedName + " App",
                      analysis.detectedName + " Pro",
                      "Meu " + analysis.detectedName,
                    ].filter((v, i, a) => a.indexOf(v) === i).map(n => (
                      <button key={n}
                        onClick={() => { setCustomName(n); setNameApplied(false); }}
                        className={`text-[11px] px-2.5 py-1 rounded-full border transition-all ${customName === n ? "border-violet-500 text-violet-300 bg-violet-900/30" : "border-slate-600 text-slate-400 hover:border-violet-500"}`}>
                        {n}
                      </button>
                    ))}
                  </div>
                </div>

                {/* ── Contagem de arquivos ── */}
                <div className="bg-slate-900/80 border border-slate-700 rounded-2xl p-4">
                  <p className="text-xs font-semibold text-slate-400 tracking-widest mb-3">📊 ARQUIVOS DETECTADOS</p>
                  <div className="grid grid-cols-5 gap-2 text-center">
                    {[
                      ["HTML", analysis.fileCounts.html, "#60a5fa"],
                      ["JS", analysis.fileCounts.js, "#fbbf24"],
                      ["CSS", analysis.fileCounts.css, "#a78bfa"],
                      ["Img", analysis.fileCounts.img, "#34d399"],
                      ["Outros", analysis.fileCounts.other, "#94a3b8"],
                    ].map(([label, count, color]) => (
                      <div key={label as string} className="bg-slate-800/60 rounded-xl py-2.5">
                        <div className="text-lg font-black" style={{ color: color as string }}>{count}</div>
                        <div className="text-[10px] text-slate-500">{label}</div>
                      </div>
                    ))}
                  </div>
                  {analysis.unnecessaryFiles.length > 0 && (
                    <div className="mt-3 flex items-center gap-2 bg-green-900/20 border border-green-700/40 rounded-xl px-3 py-2">
                      <span className="text-green-400">🗑</span>
                      <span className="text-xs text-green-300 font-semibold">
                        {analysis.unnecessaryFiles.length} arquivo(s) desnecessário(s) removidos automaticamente
                      </span>
                      <span className="text-[10px] text-slate-500">(source maps, testes, docs)</span>
                    </div>
                  )}
                  {analysis.techStack.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {analysis.techStack.map(t => (
                        <span key={t} className="text-[10px] px-2 py-0.5 rounded-full bg-violet-900/30 text-violet-300 border border-violet-700/40">{t}</span>
                      ))}
                    </div>
                  )}
                </div>

                {/* ── Sugestões de configuração ── */}
                {analysis.suggestions.length > 0 && (
                  <div className="bg-slate-900/80 border border-slate-700 rounded-2xl p-4 space-y-2">
                    <p className="text-xs font-semibold text-slate-400 tracking-widest mb-1">💡 SOLUÇÕES SUGERIDAS</p>
                    {analysis.suggestions.map((s, i) => (
                      <div key={i} className={`flex items-start gap-3 rounded-xl px-3 py-2.5 ${
                        s.action === "remove" ? "bg-green-900/15 border border-green-700/30" :
                        s.action === "keep"   ? "bg-blue-900/15 border border-blue-700/30" :
                        "bg-amber-900/15 border border-amber-700/30"
                      }`}>
                        <div className="flex-1">
                          <p className="text-xs font-semibold">{s.label}</p>
                          <p className="text-[11px] text-slate-400 mt-0.5">{s.detail}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* ── Ação: ir para exportar ── */}
                <button
                  onClick={() => setTab("export")}
                  className="w-full py-3 rounded-2xl text-sm font-bold text-white bg-violet-600 hover:bg-violet-500 transition-all"
                >
                  ⚙️ Configurar e gerar APK →
                </button>
              </div>
            )}

            {/* ── 1-clique: Assistente Jurídico ── */}
            <div className="bg-blue-900/20 border border-blue-700/60 rounded-2xl p-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-bold text-blue-300">⚖️ Assistente Jurídico</p>
                <p className="text-xs text-slate-400 mt-0.5">Importar direto — 1 clique, sem ZIP</p>
              </div>
              <button
                onClick={handleImportAssistenteJuridico}
                disabled={importLoading}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-xl text-sm font-bold whitespace-nowrap transition-all text-white shrink-0">
                {importLoading ? "⏳ Carregando..." : "⚡ Importar"}
              </button>
            </div>

            {/* File list preview */}
            {files.length > 0 && (
              <div className="bg-slate-900/60 border border-slate-700 rounded-xl p-4">
                <p className="text-xs text-slate-400 font-semibold mb-2">Arquivos no projeto:</p>
                <div className="max-h-36 overflow-y-auto space-y-0.5">
                  {files.slice(0, 200).map(f => (
                    <p key={f.path} className="text-xs font-mono text-slate-300 truncate">
                      <span className="text-slate-500 mr-1">
                        {/\.(html)$/i.test(f.path) ? "🌐" : /\.(css)$/i.test(f.path) ? "🎨" : /\.(js|ts|jsx|tsx)$/i.test(f.path) ? "⚡" : /\.(png|jpg|svg|gif|webp|ico)$/i.test(f.path) ? "🖼" : "📄"}
                      </span>
                      {f.path}
                    </p>
                  ))}
                  {files.length > 200 && <p className="text-xs text-slate-500 pt-1">...e mais {files.length - 200} arquivos</p>}
                </div>
                <button onClick={() => setTab("export")}
                  className="mt-3 w-full py-2 bg-violet-600 hover:bg-violet-500 rounded-xl text-sm font-bold transition-all">
                  ⚙ Configurar e gerar APK →
                </button>
              </div>
            )}

            {/* URL Import / PWA Analyzer */}
            <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-4 space-y-3">
              <h2 className="font-bold text-sm text-violet-400">🌐 Importar por URL do site</h2>
              <p className="text-xs text-slate-400">Cole o endereço do site — o sistema baixa HTML, manifest.json e ícones automaticamente e analisa o PWA</p>
              <div className="flex gap-2">
                <input
                  className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm font-mono focus:border-violet-500 outline-none placeholder-slate-500"
                  value={urlInput} onChange={e => setUrlInput(e.target.value)}
                  placeholder="https://meusite.com.br"
                  onKeyDown={e => e.key === "Enter" && handleUrlImport()}
                  disabled={urlLoading}
                />
                <button onClick={handleUrlImport} disabled={urlLoading || !urlInput.trim()}
                  className="px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-lg text-sm font-bold whitespace-nowrap transition-all">
                  {urlLoading ? "⏳ ..." : "🔍 Analisar"}
                </button>
              </div>

              {/* Example sites */}
              <div>
                <p className="text-xs text-slate-500 mb-1.5">💡 Exemplos de PWA para testar:</p>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    { label: "Excalidraw", url: "https://excalidraw.com" },
                    { label: "Squoosh", url: "https://squoosh.app" },
                    { label: "Duolingo", url: "https://www.duolingo.com" },
                    { label: "Pinterest", url: "https://www.pinterest.com" },
                    { label: "Spotify Web", url: "https://open.spotify.com" },
                    { label: "Starbucks", url: "https://app.starbucks.com" },
                  ].map(s => (
                    <button key={s.url}
                      onClick={() => setUrlInput(s.url)}
                      className="text-xs px-2.5 py-1 bg-slate-800 hover:bg-violet-900/50 border border-slate-700 hover:border-violet-600 rounded-lg transition-all text-slate-300 hover:text-violet-300">
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              {urlMsg && (
                <p className={`text-xs rounded px-2 py-1.5 ${urlMsg.startsWith("✅") ? "bg-green-900/20 text-green-400" : urlMsg.startsWith("❌") ? "bg-red-900/20 text-red-400" : "bg-slate-800/60 text-slate-300"}`}>
                  {urlMsg}
                </p>
              )}
              {urlIssues.length > 0 && (
                <div className="space-y-1 border-t border-slate-700 pt-2">
                  <p className="text-xs font-semibold text-slate-400 mb-1">📋 Análise PWA:</p>
                  {urlIssues.map((issue, i) => (
                    <div key={i} className={`text-xs flex gap-2 items-start ${issue.type === "ok" ? "text-green-400" : issue.type === "warn" ? "text-amber-400" : "text-red-400"}`}>
                      <span className="shrink-0 mt-px">{issue.type === "ok" ? "✅" : issue.type === "warn" ? "⚠" : "❌"}</span>
                      <span>{issue.text}</span>
                    </div>
                  ))}
                  {urlIssues.some(i => i.type === "err" || i.type === "warn") && (
                    <div className="mt-2 pt-2 border-t border-slate-700">
                      <p className="text-xs text-slate-400 font-semibold mb-1">🔧 Como corrigir os problemas:</p>
                      {urlIssues.filter(i => i.type !== "ok").map((issue, i) => (
                        <div key={i} className="text-xs text-slate-400 flex gap-1.5 items-start">
                          <span className="shrink-0">→</span>
                          <span>
                            {issue.text.includes("manifest.json") && "Adicione um arquivo manifest.json na raiz do site com name, icons e start_url"}
                            {issue.text.includes("ícone") && "Adicione ícones de 192×192px e 512×512px no manifest.json"}
                            {issue.text.includes("HTTPS") && "O site precisa ser servido por HTTPS para ser instalável como PWA"}
                            {issue.text.includes("display") && 'Defina display: "standalone" ou "fullscreen" no manifest.json'}
                            {issue.text.includes("Service Worker") && 'Registre um Service Worker para funcionamento offline: navigator.serviceWorker.register("/sw.js")'}
                            {!issue.text.includes("manifest") && !issue.text.includes("ícone") && !issue.text.includes("HTTPS") && !issue.text.includes("display") && !issue.text.includes("Service Worker") && "Revise a configuração do manifest.json"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>


            {/* ProCode Studio link */}
            <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">💻 ProCode Studio</p>
                <p className="text-xs text-slate-400">Abra o editor integrado para corrigir o projeto antes de empacotar</p>
              </div>
              <a href={codeEditorUrl} target="_blank" rel="noreferrer"
                className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 rounded-lg text-xs font-bold whitespace-nowrap transition-all">
                Abrir Editor →
              </a>
            </div>
          </>
        )}

        {/* ══ TAB: GITHUB ════════════════════════════════════════ */}
        {tab === "github" && (
          <div className="space-y-4">

            {/* ── Import repo público sem token ── */}
            <div className="bg-slate-900/60 border border-green-800/50 rounded-2xl p-4 space-y-3">
              <h2 className="font-bold text-sm text-green-400">🌐 Importar repositório público (sem token)</h2>
              <p className="text-xs text-slate-400">Cole a URL ou o caminho do repo público. Ex: <code className="text-green-300 font-mono">usuario/repositorio</code> ou <code className="text-green-300 font-mono">https://github.com/usuario/repo</code></p>
              <div className="flex gap-2">
                <input
                  className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm font-mono focus:border-green-500 outline-none placeholder-slate-500"
                  value={ghPublicRepo}
                  onChange={e => setGhPublicRepo(e.target.value)}
                  placeholder="usuario/repositorio  ou  https://github.com/..."
                  onKeyDown={e => e.key === "Enter" && handlePublicRepoImport()}
                  disabled={ghPublicLoading}
                />
                <button
                  onClick={handlePublicRepoImport}
                  disabled={ghPublicLoading || !ghPublicRepo.trim()}
                  className="px-4 py-2 bg-green-700 hover:bg-green-600 disabled:bg-slate-700 disabled:text-slate-500 rounded-lg text-sm font-bold transition-all whitespace-nowrap"
                >
                  {ghPublicLoading ? "⏳ Baixando..." : "⬇ Importar"}
                </button>
              </div>
              {ghPublicMsg && (
                <p className={`text-xs rounded px-2 py-1.5 ${ghPublicMsg.startsWith("✅") ? "bg-green-900/20 text-green-400" : ghPublicMsg.startsWith("❌") ? "bg-red-900/20 text-red-400" : "bg-slate-800 text-slate-300"}`}>
                  {ghPublicMsg}
                </p>
              )}
            </div>

            {/* Token input */}
            <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-4 space-y-3">
              <h2 className="font-bold text-sm text-violet-400">🔑 Token de acesso (PAT) — repos privados</h2>
              <input
                type="password"
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm font-mono focus:border-violet-500 outline-none placeholder-slate-500"
                value={ghToken} onChange={e => setGhToken(e.target.value)}
                placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              />
              <p className="text-xs text-slate-500">
                Crie em: GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → scope: <code className="font-mono text-violet-300">repo</code>
              </p>

              {/* User badge */}
              {ghUser && (
                <div className="flex items-center gap-3 bg-green-900/20 border border-green-700/40 rounded-lg px-3 py-2">
                  <img src={ghUser.avatar_url} className="w-8 h-8 rounded-full" alt="" />
                  <div>
                    <p className="text-sm font-semibold text-green-300">{ghUser.name || ghUser.login}</p>
                    <p className="text-xs text-slate-400">@{ghUser.login} · {ghRepos.length} repositórios</p>
                  </div>
                </div>
              )}
              {ghMsg && !ghUser && (
                <p className={`text-xs rounded px-2 py-1.5 ${ghMsg.startsWith("✅") ? "bg-green-900/20 text-green-400" : "bg-red-900/20 text-red-400"}`}>{ghMsg}</p>
              )}
            </div>

            {/* Custom repo URL */}
            <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-4 space-y-3">
              <h2 className="font-bold text-sm text-violet-400">🔗 Clonar repositório específico</h2>
              <div className="flex gap-2">
                <input
                  className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm font-mono focus:border-violet-500 outline-none placeholder-slate-500"
                  value={ghCustomRepo} onChange={e => setGhCustomRepo(e.target.value)}
                  placeholder="usuario/repositorio  ou  https://github.com/..."
                  onKeyDown={e => e.key === "Enter" && handleGhCustomImport()}
                />
                <button onClick={handleGhCustomImport}
                  disabled={ghLoading || !ghToken || !ghCustomRepo.trim()}
                  className="px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-lg text-sm font-bold transition-all">
                  {ghLoading ? "..." : "⬇ Importar"}
                </button>
              </div>
              {ghMsg && (
                <p className={`text-xs rounded px-2 py-1.5 ${ghMsg.startsWith("✅") ? "bg-green-900/20 text-green-400" : ghMsg.startsWith("❌") ? "bg-red-900/20 text-red-400" : "bg-slate-800 text-slate-300"}`}>{ghMsg}</p>
              )}
            </div>

            {/* Repo list */}
            {ghRepos.length > 0 && (
              <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-4 space-y-3">
                <h2 className="font-bold text-sm text-violet-400">📋 Meus repositórios</h2>
                <input
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm focus:border-violet-500 outline-none placeholder-slate-500"
                  value={ghRepoFilter} onChange={e => setGhRepoFilter(e.target.value)}
                  placeholder="Filtrar por nome..."
                />
                <div className="max-h-64 overflow-y-auto space-y-1.5">
                  {filteredRepos.slice(0, 50).map(r => (
                    <button key={r.full_name}
                      onClick={() => handleGhImport(r)}
                      disabled={ghLoading}
                      className="w-full text-left px-3 py-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 rounded-lg transition-all border border-slate-700 hover:border-violet-600">
                      <div className="flex items-center gap-2">
                        <span className="text-xs">{r.private ? "🔒" : "🌐"}</span>
                        <span className="text-sm font-semibold truncate">{r.name}</span>
                        <span className="ml-auto text-xs text-slate-500 shrink-0">{r.default_branch}</span>
                      </div>
                      {r.description && <p className="text-xs text-slate-400 mt-0.5 truncate">{r.description}</p>}
                    </button>
                  ))}
                  {filteredRepos.length === 0 && <p className="text-xs text-slate-500 text-center py-4">Nenhum repositório encontrado</p>}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══ TAB: EXPORTAR ══════════════════════════════════════ */}
        {tab === "export" && (
          <div className="space-y-4">
            {!projectReady ? (
              <div className="text-center py-12 text-slate-500">
                <p className="text-4xl mb-3">📦</p>
                <p className="font-semibold text-slate-300">Nenhum projeto carregado</p>
                <p className="text-sm mt-1">Importe um ZIP/TAR ou clone um repositório GitHub</p>
                <div className="flex gap-3 justify-center mt-4 flex-wrap">
                  <button onClick={() => setTab("import")}
                    className="px-6 py-2 bg-violet-600 hover:bg-violet-500 rounded-xl text-sm font-bold text-white">
                    📂 Importar projeto
                  </button>
                  {savedMeta && (
                    <button onClick={restoreSession} disabled={restoring}
                      className="px-6 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded-xl text-sm font-bold text-slate-200">
                      {restoring ? "Restaurando..." : `↩ Restaurar "${savedMeta.cfg.appName || "sessão anterior"}" (${savedMeta.fileCount} arq.)`}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                {/* Config */}
                <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-4 space-y-3">
                  <h2 className="font-bold text-sm text-violet-400">⚙ Configuração do APK</h2>
                  <div className="grid sm:grid-cols-2 gap-3">
                    {field("Nome do App *", cfg.appName, v => setCfg(c => ({ ...c, appName: v })), { placeholder: "Meu App" })}
                    {field("Package ID *", cfg.appId, v => setCfg(c => ({ ...c, appId: v })), { placeholder: "com.meuapp.app", className: "w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm font-mono focus:border-violet-500 outline-none placeholder-slate-500" })}
                    {field("Versão", cfg.versionName, v => setCfg(c => ({ ...c, versionName: v })))}
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Código de versão</label>
                      <input type="number" min={1}
                        className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm focus:border-violet-500 outline-none"
                        value={cfg.versionCode} onChange={e => setCfg(c => ({ ...c, versionCode: Number(e.target.value) }))} />
                    </div>
                    {colorField("Cor do tema", cfg.themeColor, v => setCfg(c => ({ ...c, themeColor: v })))}
                    {colorField("Cor de fundo (splash)", cfg.bgColor, v => setCfg(c => ({ ...c, bgColor: v })))}
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Orientação</label>
                      <select className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm focus:border-violet-500 outline-none"
                        value={cfg.orientation} onChange={e => setCfg(c => ({ ...c, orientation: e.target.value as AppConfig["orientation"] }))}>
                        <option value="portrait">Retrato</option>
                        <option value="landscape">Paisagem</option>
                        <option value="any">Ambas</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Android mínimo</label>
                      <select className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm focus:border-violet-500 outline-none"
                        value={cfg.minSdk} onChange={e => setCfg(c => ({ ...c, minSdk: Number(e.target.value) }))}>
                        <option value={21}>Android 5.0+ (API 21)</option>
                        <option value={22}>Android 5.1+ (API 22)</option>
                        <option value={24}>Android 7.0+ (API 24)</option>
                        <option value={26}>Android 8.0+ (API 26)</option>
                        <option value={28}>Android 9.0+ (API 28)</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* ══ BOTÕES DE BUILD NA NUVEM ══ */}
                {ghToken && ghUser ? (
                  <div className="space-y-3">

                    {/* EAS (Expo) — RECOMENDADO */}
                    <div className="bg-blue-900/25 border-2 border-blue-500/70 rounded-2xl p-4 space-y-3">
                      <div className="flex items-center gap-2">
                        <span className="text-2xl">📱</span>
                        <div>
                          <p className="font-bold text-blue-300 text-sm">EAS — EXPO BUILD (RECOMENDADO)</p>
                          <p className="text-xs text-slate-400">Gera APK nativo via WebView. Com EXPO_TOKEN usa a nuvem Expo; sem token usa build local gratuito.</p>
                        </div>
                      </div>

                      {/* EXPO_TOKEN */}
                      <div>
                        <label className="text-xs text-slate-400 block mb-1">
                          🔑 EXPO_TOKEN <span className="text-slate-600">(opcional — para build na nuvem Expo)</span>
                        </label>
                        <input
                          type="password"
                          className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm font-mono focus:border-blue-500 outline-none placeholder-slate-600"
                          placeholder="Cole aqui seu token EAS (expo.dev → Access Tokens)"
                          value={easToken}
                          onChange={e => { setEasToken(e.target.value); localStorage.setItem("expo_token", e.target.value); }}
                        />
                        {easToken.trim() && (
                          <p className="text-xs text-blue-400 mt-1">✅ EAS Cloud ativo — usará conta <strong>maikons-individual-orga</strong></p>
                        )}
                        {!easToken.trim() && (
                          <p className="text-xs text-slate-500 mt-1">Sem token → build local gratuito (sem conta Expo necessária)</p>
                        )}
                      </div>

                      <button onClick={handleEASDeploy}
                        disabled={easLoading || pipeLoading || !files.length || !cfg.appName || !cfg.appId || !ghToken || !ghUser}
                        className="w-full py-3.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-xl font-bold text-base transition-all text-white">
                        {easLoading ? "⏳ Compilando via EAS..." : easToken.trim() ? "🚀 ENVIAR PARA EAS CLOUD" : "🚀 ENVIAR PARA EAS (LOCAL)"}
                      </button>
                      {!ghToken && <p className="text-xs text-amber-400 text-center">⚠ Configure o token GitHub na aba GitHub primeiro</p>}
                      {easMsg && (
                        <p className={`text-xs break-all font-medium ${easMsg.startsWith("✅") ? "text-green-400" : easMsg.startsWith("❌") ? "text-red-400" : "text-yellow-300"}`}>{easMsg}</p>
                      )}
                      {easRunUrl && (
                        <a href={easRunUrl} target="_blank" rel="noreferrer"
                          className="flex items-center gap-1.5 text-xs text-blue-300 hover:text-blue-200 underline break-all font-semibold">
                          🔗 Abrir GitHub Actions → aba "Artifacts" → baixar APK
                        </a>
                      )}
                    </div>

                    {/* Capacitor (build clássico) */}
                    <div className="bg-green-900/20 border border-green-700/50 rounded-2xl p-4 space-y-3">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">⚡</span>
                        <div>
                          <p className="font-bold text-green-300 text-sm">Capacitor (build clássico)</p>
                          <p className="text-xs text-slate-400">Gradle direto — mais rápido mas requer Android SDK no runner</p>
                        </div>
                      </div>
                      <button onClick={handleFullDeploy}
                        disabled={pipeLoading || easLoading || !files.length || !cfg.appName || !cfg.appId}
                        className="w-full py-2.5 bg-green-700 hover:bg-green-600 disabled:bg-slate-700 disabled:text-slate-500 rounded-xl font-bold text-sm transition-all text-white">
                        {pipeLoading ? "⏳ Compilando..." : "⚡ ENVIAR VIA CAPACITOR"}
                      </button>
                      {pipeMsg && (
                        <p className={`text-xs break-all font-medium ${pipeMsg.startsWith("✅") ? "text-green-400" : pipeMsg.startsWith("❌") ? "text-red-400" : "text-yellow-300"}`}>{pipeMsg}</p>
                      )}
                      {pipeRunUrl && (
                        <a href={pipeRunUrl} target="_blank" rel="noreferrer"
                          className="flex items-center gap-1.5 text-xs text-green-300 hover:text-green-200 underline break-all font-semibold">
                          🔗 Abrir GitHub Actions → baixar APK
                        </a>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="bg-amber-900/20 border border-amber-700/50 rounded-xl p-3 text-xs text-amber-300">
                    ⚠ Configure o token GitHub na aba <strong>GitHub</strong> para usar o build automático na nuvem
                  </div>
                )}

                {/* Generate button */}
                <button onClick={handleGenerate}
                  disabled={generating || !cfg.appName || !cfg.appId || !files.length}
                  className="w-full py-3.5 bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-2xl font-bold transition-all text-base">
                  {generating ? `⚙ Gerando projeto Android... ${progress}%` : "⚡ Gerar Projeto Android (.zip)"}
                </button>
                {!files.length && (
                  <p className="text-xs text-amber-400 text-center -mt-2">⚠ Importe um projeto primeiro (aba Importar ou GitHub)</p>
                )}
                {files.length > 0 && (!cfg.appName || !cfg.appId) && (
                  <p className="text-xs text-amber-400 text-center -mt-2">⚠ Preencha Nome do App e Package ID acima para gerar</p>
                )}
                {generating && (
                  <div className="bg-slate-700 rounded-full h-2 overflow-hidden -mt-2">
                    <div className="h-full bg-violet-500 transition-all duration-300" style={{ width: `${progress}%` }} />
                  </div>
                )}

                {/* Result actions */}
                {resultBlob && (
                  <div className="bg-green-900/15 border border-green-700/40 rounded-2xl p-4 space-y-4">
                    <div className="flex items-center gap-2">
                      <span className="text-2xl">✅</span>
                      <div>
                        <p className="font-bold text-green-300 text-sm">Projeto gerado com sucesso!</p>
                        <p className="text-xs text-slate-400 font-mono">{resultName}</p>
                      </div>
                    </div>

                    {/* Download */}
                    <button onClick={() => downloadBlob(resultBlob!, resultName)}
                      className="w-full py-2.5 bg-green-600 hover:bg-green-500 rounded-xl font-bold text-sm transition-all">
                      ⬇ Baixar ZIP do Projeto Android
                    </button>

                    {/* Google Drive */}
                    <div className="border border-slate-700 rounded-xl p-3 space-y-2">
                      <p className="text-xs font-semibold text-slate-300">☁ Enviar para Google Drive</p>
                      <div className="flex gap-2">
                        <input type="password"
                          className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-xs font-mono focus:border-violet-500 outline-none placeholder-slate-500"
                          value={driveToken} onChange={e => setDriveToken(e.target.value)}
                          placeholder="Token OAuth ya29.xxx (não API key)" />
                        <button onClick={handleDriveUpload} disabled={driveLoading || !driveToken}
                          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-lg text-xs font-bold whitespace-nowrap transition-all">
                          {driveLoading ? "..." : "☁ Enviar"}
                        </button>
                      </div>
                      {driveMsg && (
                        <p className={`text-xs break-all ${driveMsg.startsWith("✅") ? "text-green-400" : "text-red-400"}`}>{driveMsg}</p>
                      )}
                    </div>

                    {/* GitHub push */}
                    <div className="border border-slate-700 rounded-xl p-3 space-y-2">
                      <p className="text-xs font-semibold text-slate-300">🐙 Exportar para GitHub</p>
                      {!ghToken ? (
                        <p className="text-xs text-amber-400">⚠ Configure o token GitHub na aba GitHub primeiro</p>
                      ) : (
                        <>
                          <div className="flex gap-2">
                            <input
                              className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm font-mono focus:border-violet-500 outline-none placeholder-slate-500"
                              value={pushRepoName} onChange={e => setPushRepoName(e.target.value)}
                              placeholder="nome-do-repositorio"
                            />
                            <label className="flex items-center gap-1.5 text-xs text-slate-400 shrink-0 cursor-pointer">
                              <input type="checkbox" checked={pushPrivate} onChange={e => setPushPrivate(e.target.checked)} className="accent-violet-500" />
                              Privado
                            </label>
                          </div>
                          <button onClick={handleGhPush} disabled={pushLoading || !pushRepoName.trim()}
                            className="w-full py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded-lg text-xs font-bold transition-all">
                            {pushLoading ? "⬆ Enviando..." : "⬆ Criar repositório e enviar"}
                          </button>
                          {pushMsg && (
                            <p className={`text-xs break-all ${pushMsg.startsWith("✅") ? "text-green-400" : pushMsg.startsWith("❌") ? "text-red-400" : "text-slate-300"}`}>{pushMsg}</p>
                          )}
                        </>
                      )}
                    </div>

                    {/* ☁ Compilar APK na nuvem via GitHub Actions */}
                    <div className="border border-orange-700/60 bg-orange-900/10 rounded-xl p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-base">🤖</span>
                        <p className="text-xs font-semibold text-orange-300">Compilar APK na nuvem (GitHub Actions)</p>
                      </div>
                      <p className="text-xs text-slate-400">Informa o repositório GitHub já criado — o build roda automaticamente e você baixa o APK direto pelo link. Leva ~5–10 min.</p>
                      {!ghToken ? (
                        <p className="text-xs text-amber-400">⚠ Configure o token GitHub na aba GitHub primeiro</p>
                      ) : (
                        <>
                          <div className="flex gap-2">
                            <input
                              className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-xs font-mono focus:border-orange-500 outline-none placeholder-slate-500"
                              value={ciRepoOwner} onChange={e => setCiRepoOwner(e.target.value)}
                              placeholder="seu-usuario-github"
                            />
                            <span className="text-slate-500 self-center">/</span>
                            <input
                              className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-xs font-mono focus:border-orange-500 outline-none placeholder-slate-500"
                              value={ciRepoName} onChange={e => setCiRepoName(e.target.value)}
                              placeholder="nome-do-repositorio"
                            />
                          </div>
                          <button onClick={handleCiBuild} disabled={ciLoading || !ciRepoOwner.trim() || !ciRepoName.trim()}
                            className="w-full py-2 bg-orange-700 hover:bg-orange-600 disabled:bg-slate-700 disabled:text-slate-500 rounded-lg text-xs font-bold transition-all text-white">
                            {ciLoading ? "⏳ Aguardando build..." : "🚀 Iniciar compilação APK"}
                          </button>
                          {ciMsg && (
                            <p className={`text-xs break-all ${ciMsg.startsWith("✅") ? "text-green-400" : ciMsg.startsWith("❌") ? "text-red-400" : "text-orange-300"}`}>{ciMsg}</p>
                          )}
                          {ciRunUrl && (
                            <a href={ciRunUrl} target="_blank" rel="noreferrer"
                              className="flex items-center gap-1 text-xs text-orange-300 hover:text-orange-200 underline break-all">
                              🔗 Ver build no GitHub Actions →
                            </a>
                          )}
                        </>
                      )}
                    </div>

                    {/* GitHub Pages publish */}
                    <div className="border border-emerald-800/60 bg-emerald-900/10 rounded-xl p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-base">🌍</span>
                        <p className="text-xs font-semibold text-emerald-300">Publicar como PWA (GitHub Pages)</p>
                      </div>
                      <p className="text-xs text-slate-400">Sobe os arquivos do site direto no GitHub Pages e gera um link público para testar a instalação no celular</p>
                      {!ghToken ? (
                        <p className="text-xs text-amber-400">⚠ Configure o token GitHub na aba GitHub primeiro</p>
                      ) : (
                        <>
                          <div className="flex gap-2">
                            <input
                              className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm font-mono focus:border-emerald-500 outline-none placeholder-slate-500"
                              value={pagesRepoName} onChange={e => setPagesRepoName(e.target.value)}
                              placeholder="meu-app-pwa"
                            />
                            <label className="flex items-center gap-1.5 text-xs text-slate-400 shrink-0 cursor-pointer">
                              <input type="checkbox" checked={pagesPrivate} onChange={e => setPagesPrivate(e.target.checked)} className="accent-emerald-500" />
                              Privado
                            </label>
                          </div>
                          <button onClick={handlePublishPages} disabled={pagesLoading || !pagesRepoName.trim()}
                            className="w-full py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded-lg text-xs font-bold transition-all text-white">
                            {pagesLoading ? "⏳ Publicando..." : "🚀 Publicar no GitHub Pages"}
                          </button>
                          {pagesUrl && (
                            <a href={pagesUrl} target="_blank" rel="noreferrer"
                              className="flex items-center gap-2 text-xs text-emerald-300 hover:text-emerald-200 underline break-all">
                              🔗 {pagesUrl}
                            </a>
                          )}
                          {pagesMsg && (
                            <p className={`text-xs break-all ${pagesMsg.startsWith("✅") ? "text-green-400" : pagesMsg.startsWith("❌") ? "text-red-400" : "text-slate-300"}`}>{pagesMsg}</p>
                          )}
                        </>
                      )}
                    </div>

                    {/* Code Editor integration */}
                    <div className="border border-slate-700 rounded-xl p-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold text-slate-300">💻 Corrigir no Code Editor</p>
                        <p className="text-xs text-slate-500">Abra o ProCode Studio para editar e volte para gerar novamente</p>
                      </div>
                      <a href={codeEditorUrl} target="_blank" rel="noreferrer"
                        className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded-lg text-xs font-bold whitespace-nowrap transition-all">
                        Abrir →
                      </a>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ══ TAB: IA ════════════════════════════════════════════ */}
        {tab === "ai" && (
          <div className="bg-slate-900/60 border border-slate-700 rounded-2xl flex flex-col" style={{ height: "calc(100vh - 160px)", minHeight: 480, maxHeight: 800 }}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-700">
              <span className="text-lg">🤖</span>
              <span className="font-bold text-sm">IA Assistente — Android & PWA</span>
              <div className="ml-auto flex gap-1.5 items-center flex-wrap">
                <button onClick={activateBrain} title="Envia contexto completo do projeto para a IA"
                  disabled={!aiKeys.key}
                  className="text-xs px-2 py-1 rounded bg-amber-900/50 hover:bg-amber-800/70 text-amber-300 disabled:opacity-40 transition-all">
                  🧠 Cérebro
                </button>
                <button onClick={exportBrain}
                  className="text-xs px-2 py-1 rounded bg-slate-700/50 hover:bg-slate-700 text-slate-400 transition-all"
                  title="Baixar cérebro.json com contexto completo">
                  💾 Salvar
                </button>
                {chat.length > 0 && (
                  <button onClick={exportChatJson}
                    className="text-xs px-2 py-1 rounded bg-slate-700/50 hover:bg-slate-700 text-slate-400 transition-all"
                    title="Exportar conversa como JSON">
                    📥 JSON
                  </button>
                )}
                <button onClick={() => setShowAiKeys(v => !v)}
                  className="text-xs text-slate-400 hover:text-white px-2 py-1 rounded bg-slate-700/50 hover:bg-slate-700">
                  🔑 Chaves
                </button>
              </div>
            </div>

            {showAiKeys && (
              <div className="px-4 py-3 border-b border-slate-700 space-y-2 bg-slate-950/40">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Chave API — cole aqui (auto-detecta o provedor)</label>
                  <input type="password"
                    className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm font-mono focus:border-violet-500 outline-none placeholder-slate-500"
                    value={aiKeys.key}
                    onChange={e => {
                      const newKey = e.target.value;
                      const det = detectAIProvider(newKey);
                      const next = { key: newKey, url: det ? det.url : aiKeys.url, model: det ? det.model : aiKeys.model };
                      setAiKeys(next);
                      localStorage.setItem("custom_api_key", newKey);
                      if (det) { localStorage.setItem("custom_api_url", det.url); localStorage.setItem("custom_api_model", det.model); }
                    }}
                    placeholder="sk-...  /  pplx-...  /  sk-ant-...  /  gsk_...  /  AIza..." />
                  {aiKeys.key.length > 8 && detectAIProvider(aiKeys.key) && (
                    <p className="text-xs text-green-400 mt-1">✅ {detectAIProvider(aiKeys.key)!.url.replace("https://","").split("/")[0]} detectado automaticamente</p>
                  )}
                  {aiKeys.key.length > 8 && !detectAIProvider(aiKeys.key) && (
                    <p className="text-xs text-yellow-400 mt-1">⚠️ Formato não reconhecido — configure URL/modelo abaixo</p>
                  )}
                </div>
                <div className="grid sm:grid-cols-2 gap-2">
                  {field("URL da API", aiKeys.url, v => { setAiKeys(k => ({ ...k, url: v })); localStorage.setItem("custom_api_url", v); }, { placeholder: "https://api.openai.com/v1" })}
                  {field("Modelo", aiKeys.model, v => { setAiKeys(k => ({ ...k, model: v })); localStorage.setItem("custom_api_model", v); }, { placeholder: "gpt-4o-mini" })}
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
              {chat.length === 0 && (
                <div className="text-center text-slate-500 text-sm py-10 space-y-2">
                  <p className="text-3xl">🤖</p>
                  <p>Especialista em Android, PWA e Capacitor</p>
                  {projectReady && <p className="text-xs text-violet-400">Projeto carregado: {cfg.appName}</p>}
                </div>
              )}
              {chat.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[88%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed ${m.role === "user" ? "bg-violet-600 text-white rounded-br-none" : "bg-slate-800 text-slate-100 rounded-bl-none"}`}>
                    {m.text}
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div className="flex justify-start">
                  <div className="bg-slate-800 rounded-2xl rounded-bl-none px-4 py-2.5 text-slate-400 text-sm">
                    <span className="animate-pulse">● ● ●</span>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {chat.length === 0 && (
              <div className="px-4 pb-2 flex flex-wrap gap-2">
                {["Como assinar o APK?", "Adicionar ícone personalizado", "Como publicar na Play Store?", "Erro no Gradle sync", "Permissões Android"].map(s => (
                  <button key={s} onClick={() => sendChat(s)}
                    className="text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-full px-3 py-1.5 text-slate-300 transition-all">
                    {s}
                  </button>
                ))}
              </div>
            )}

            <div className="p-3 border-t border-slate-700">
              {!aiKeys.key && (
                <p className="text-xs text-amber-400 text-center mb-2">⚠ Configure a chave de API acima para usar a IA</p>
              )}
              <div className="flex gap-2">
                <input
                  className="flex-1 bg-slate-800 border border-slate-600 rounded-xl px-4 py-2.5 text-sm focus:border-violet-500 outline-none placeholder-slate-500"
                  placeholder="Pergunte sobre Android, Gradle, Capacitor..."
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendChat()}
                  disabled={!aiKeys.key}
                />
                <button onClick={toggleVoice}
                  className={`px-3 rounded-xl text-xl transition-all ${listening ? "bg-red-600 animate-pulse" : "bg-slate-700 hover:bg-slate-600"}`}
                  title="Entrada por voz">🎤</button>
                <button onClick={() => sendChat()}
                  disabled={!chatInput.trim() || !aiKeys.key || chatLoading}
                  className="px-4 py-2.5 bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-xl text-sm font-bold transition-all">➤</button>
              </div>
            </div>
          </div>
        )}

        {/* ══ TAB: TERMINAL ══════════════════════════════════════ */}
        {tab === "terminal" && (
          <div className="bg-slate-900/80 border border-slate-700 rounded-2xl overflow-hidden" style={{ height: "70vh" }}>
            <TerminalTab
              projectReady={projectReady}
              cfg={cfg}
              files={files}
              source={source}
              ghToken={ghToken}
              ghUser={ghUser}
              onImportUrl={async (url) => {
                setImportLoading(true);
                setImportInfo(`Importando ${url}...`);
                try {
                  const { files: extracted } = await ghImportPublicRepo(url);
                  const a = analyzeProject(extracted, url);
                  const cleaned = extracted.filter(f => !a.unnecessaryFiles.includes(f.path));
                  const { name, id } = guessConfig(cleaned, url);
                  const newCfg = { ...DEFAULT_CFG, appName: name, appId: id };
                  setFiles(cleaned);
                  setAnalysis(a);
                  setCustomName(name);
                  setCfg(newCfg);
                  const src = `URL: ${url} (${cleaned.length} arquivos)`;
                  setSource(src);
                  setProjectReady(true);
                  setImportInfo(`✅ ${cleaned.length} arquivos carregados`);
                  setTab("export");
                  await doSave(newCfg, src, cleaned);
                } catch (e) {
                  setImportInfo("❌ " + String(e));
                  throw e;
                } finally {
                  setImportLoading(false);
                }
              }}
              onExport={handleGenerate}
              onPagesPublish={async (repoName) => {
                setPagesRepoName(repoName);
                await handlePublishPages();
              }}
              onPushGitHub={async (repoName) => {
                setPushRepoName(repoName);
                await handleGhPush();
              }}
            />
          </div>
        )}

        {/* ══ TAB: ANALISAR APK ══════════════════════════════════ */}
        {tab === "analisar" && (
          <div>
            <ApkAnalyzer />
          </div>
        )}

        {/* ══ TAB: GUIA ══════════════════════════════════════════ */}
        {tab === "guide" && (
          <div className="space-y-3">

            {/* ══ DIAGNÓSTICO COMPLETO DO SISTEMA ══ */}
            <div className="bg-slate-900 border border-cyan-700/50 rounded-2xl p-4 space-y-4">

              {/* Header */}
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-bold text-cyan-300 text-sm">🖥️ Diagnóstico Completo do Sistema</h2>
                  <p className="text-[10px] text-slate-500 mt-0.5">
                    {sysChecking ? "⏳ Coletando dados..." : `Última verificação: ${sysInfo.checkedAt || "—"} · Auto: 30s`}
                  </p>
                </div>
                <button onClick={checkSystem} disabled={sysChecking}
                  className="text-[10px] bg-cyan-900/40 border border-cyan-700/40 text-cyan-300 px-3 py-1.5 rounded-lg hover:bg-cyan-800/40 disabled:opacity-50 transition font-semibold">
                  {sysChecking ? "⏳ Verificando..." : "🔄 Atualizar"}
                </button>
              </div>

              {/* ─ Versão & Status Geral ─ */}
              <div className={`rounded-xl p-3 border flex items-center gap-3 ${sysInfo.proxyOk === true ? "bg-green-900/20 border-green-700/40" : sysInfo.proxyOk === false ? "bg-red-900/20 border-red-700/40" : "bg-slate-800/60 border-slate-700"}`}>
                <span className="text-2xl">📱</span>
                <div className="flex-1">
                  <p className="font-bold text-sm text-violet-300">ConstruAPK Pro {APP_VERSION} — Build {BUILD_DATE}</p>
                  <p className={`text-xs font-bold mt-0.5 ${sysInfo.proxyOk === true ? "text-green-400" : sysInfo.proxyOk === false ? "text-red-400" : "text-slate-400"}`}>
                    {sysInfo.proxyOk === true ? "✅ SISTEMA OPERACIONAL — TUDO PRONTO" : sysInfo.proxyOk === false ? "⚠️ PROXY OFFLINE — Verifique o servidor" : "⏳ Verificando..."}
                  </p>
                </div>
              </div>

              {/* ─ REDE & CONECTIVIDADE ─ */}
              <div>
                <p className="text-[10px] text-slate-500 font-semibold tracking-widest mb-2">🌐 REDE &amp; CONECTIVIDADE</p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-slate-800/60 rounded-xl p-3">
                    <p className="text-[10px] text-slate-500 mb-1">INTERNET</p>
                    <p className={`text-sm font-bold ${sysInfo.online ? "text-green-400" : "text-red-400"}`}>{sysInfo.online === null ? "—" : sysInfo.online ? "✅ Online" : "❌ Offline"}</p>
                  </div>
                  <div className="bg-slate-800/60 rounded-xl p-3">
                    <p className="text-[10px] text-slate-500 mb-1">PROXY IMPORT</p>
                    <p className={`text-sm font-bold ${sysInfo.proxyOk === true ? "text-green-400" : sysInfo.proxyOk === false ? "text-red-400" : "text-slate-400"}`}>
                      {sysInfo.proxyOk === null ? "⏳ —" : sysInfo.proxyOk ? "✅ Online" : "❌ Offline"}
                    </p>
                    <p className="text-[10px] text-slate-500">Sem CORS</p>
                  </div>
                  <div className="bg-slate-800/60 rounded-xl p-3">
                    <p className="text-[10px] text-slate-500 mb-1">TIPO DE CONEXÃO</p>
                    <p className="text-sm font-bold text-cyan-300">{sysInfo.connType ? sysInfo.connType.toUpperCase() : "—"}</p>
                    <p className="text-[10px] text-slate-500">{sysInfo.downlinkMbps != null ? `${sysInfo.downlinkMbps} Mbps down` : "velocidade n/d"}</p>
                  </div>
                  <div className="bg-slate-800/60 rounded-xl p-3">
                    <p className="text-[10px] text-slate-500 mb-1">LATÊNCIA (RTT)</p>
                    <p className={`text-sm font-bold ${sysInfo.rttMs != null && sysInfo.rttMs < 100 ? "text-green-400" : sysInfo.rttMs != null && sysInfo.rttMs < 300 ? "text-yellow-400" : "text-slate-400"}`}>
                      {sysInfo.rttMs != null ? `${sysInfo.rttMs} ms` : "—"}
                    </p>
                    <p className="text-[10px] text-slate-500">{sysInfo.rttMs != null ? (sysInfo.rttMs < 100 ? "Excelente" : sysInfo.rttMs < 300 ? "Boa" : "Alta") : "n/d"}</p>
                  </div>
                </div>
              </div>

              {/* ─ MEMÓRIA ─ */}
              <div>
                <p className="text-[10px] text-slate-500 font-semibold tracking-widest mb-2">🧠 MEMÓRIA</p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-slate-800/60 rounded-xl p-3">
                    <p className="text-[10px] text-slate-500 mb-1">HEAP JS USADO</p>
                    {sysInfo.memUsedMB != null
                      ? <><p className="text-sm font-bold text-orange-300">{sysInfo.memUsedMB} MB</p><p className="text-[10px] text-slate-500">heap total: {sysInfo.memTotalMB} MB</p></>
                      : <><p className="text-sm font-bold text-slate-400">—</p><p className="text-[10px] text-slate-500">use Chrome</p></>}
                  </div>
                  <div className="bg-slate-800/60 rounded-xl p-3">
                    <p className="text-[10px] text-slate-500 mb-1">LIMITE HEAP JS</p>
                    {sysInfo.memLimitMB != null
                      ? <><p className="text-sm font-bold text-orange-300">{sysInfo.memLimitMB} MB</p><p className="text-[10px] text-slate-500">máximo alocável</p></>
                      : <p className="text-sm font-bold text-slate-400">—</p>}
                  </div>
                  <div className="bg-slate-800/60 rounded-xl p-3">
                    <p className="text-[10px] text-slate-500 mb-1">RAM DO DISPOSITIVO</p>
                    {sysInfo.deviceMemGB != null
                      ? <><p className="text-sm font-bold text-yellow-300">{sysInfo.deviceMemGB} GB</p><p className="text-[10px] text-slate-500">memória física</p></>
                      : <p className="text-sm font-bold text-slate-400">—</p>}
                  </div>
                  <div className="bg-slate-800/60 rounded-xl p-3">
                    <p className="text-[10px] text-slate-500 mb-1">ARQUIVOS EM RAM</p>
                    <p className="text-sm font-bold text-yellow-300">{files.length.toLocaleString("pt-BR")}</p>
                    <p className="text-[10px] text-slate-500">Limite: ∞ sem limite</p>
                  </div>
                </div>
                {sysInfo.memUsedMB != null && sysInfo.memLimitMB != null && (
                  <div className="mt-2 bg-slate-800/60 rounded-xl p-3">
                    <div className="flex justify-between text-[10px] text-slate-500 mb-1">
                      <span>Uso do heap</span>
                      <span>{Math.round((sysInfo.memUsedMB / sysInfo.memLimitMB) * 100)}%</span>
                    </div>
                    <div className="w-full bg-slate-700 rounded-full h-2">
                      <div className="h-2 rounded-full bg-gradient-to-r from-orange-500 to-yellow-400 transition-all"
                        style={{ width: `${Math.min(100, Math.round((sysInfo.memUsedMB / sysInfo.memLimitMB) * 100))}%` }} />
                    </div>
                  </div>
                )}
              </div>

              {/* ─ ARMAZENAMENTO ─ */}
              <div>
                <p className="text-[10px] text-slate-500 font-semibold tracking-widest mb-2">💾 ARMAZENAMENTO LOCAL (IndexedDB + Cache)</p>
                <div className="bg-slate-800/60 rounded-xl p-3">
                  {sysInfo.storageQuotaMB != null
                    ? <>
                        <div className="flex justify-between text-xs mb-2">
                          <span className="text-blue-300 font-bold">{sysInfo.storageUsedMB} MB usados</span>
                          <span className="text-slate-400">de {sysInfo.storageQuotaMB} MB disponíveis ({sysInfo.storagePct}%)</span>
                        </div>
                        <div className="w-full bg-slate-700 rounded-full h-2.5 mb-2">
                          <div className={`h-2.5 rounded-full transition-all ${(sysInfo.storagePct ?? 0) > 80 ? "bg-red-500" : (sysInfo.storagePct ?? 0) > 50 ? "bg-yellow-400" : "bg-blue-500"}`}
                            style={{ width: `${Math.min(100, sysInfo.storagePct ?? 0)}%` }} />
                        </div>
                        <p className="text-[10px] text-slate-500">{sysInfo.storageQuotaMB - (sysInfo.storageUsedMB ?? 0)} MB livres · sessão salva em IndexedDB</p>
                      </>
                    : <p className="text-sm text-slate-400">Não disponível neste browser</p>}
                </div>
              </div>

              {/* ─ DISPOSITIVO & BROWSER ─ */}
              <div>
                <p className="text-[10px] text-slate-500 font-semibold tracking-widest mb-2">⚙️ DISPOSITIVO &amp; BROWSER</p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-slate-800/60 rounded-xl p-3">
                    <p className="text-[10px] text-slate-500 mb-1">BROWSER</p>
                    <p className="text-sm font-bold text-slate-200">{sysInfo.browserInfo || "—"}</p>
                  </div>
                  <div className="bg-slate-800/60 rounded-xl p-3">
                    <p className="text-[10px] text-slate-500 mb-1">NÚCLEOS CPU</p>
                    <p className="text-sm font-bold text-slate-200">{sysInfo.cores != null ? `${sysInfo.cores} cores` : "—"}</p>
                    <p className="text-[10px] text-slate-500">concorrência JS</p>
                  </div>
                  <div className="bg-slate-800/60 rounded-xl p-3 col-span-2">
                    <p className="text-[10px] text-slate-500 mb-1">PLATAFORMA</p>
                    <p className="text-sm font-bold text-slate-200">{sysInfo.platform || "—"}</p>
                  </div>
                </div>
              </div>

              {/* ─ GITHUB RATE LIMIT ─ */}
              {ghToken && (
                <div>
                  <p className="text-[10px] text-slate-500 font-semibold tracking-widest mb-2">🐙 GITHUB API — RATE LIMIT</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-slate-800/60 rounded-xl p-3">
                      <p className="text-[10px] text-slate-500 mb-1">REQUESTS RESTANTES</p>
                      <p className={`text-sm font-bold ${sysInfo.ghRateLimit != null && sysInfo.ghRateLimit > 500 ? "text-green-400" : sysInfo.ghRateLimit != null && sysInfo.ghRateLimit > 100 ? "text-yellow-400" : "text-red-400"}`}>
                        {sysInfo.ghRateLimit != null ? `${sysInfo.ghRateLimit.toLocaleString("pt-BR")} / 5.000` : "—"}
                      </p>
                    </div>
                    <div className="bg-slate-800/60 rounded-xl p-3">
                      <p className="text-[10px] text-slate-500 mb-1">RESET EM</p>
                      <p className="text-sm font-bold text-slate-200">{sysInfo.ghRateLimitReset || "—"}</p>
                    </div>
                  </div>
                  {sysInfo.ghRateLimit != null && (
                    <div className="mt-2 bg-slate-800/60 rounded-xl p-3">
                      <div className="w-full bg-slate-700 rounded-full h-2">
                        <div className={`h-2 rounded-full transition-all ${sysInfo.ghRateLimit > 500 ? "bg-green-500" : sysInfo.ghRateLimit > 100 ? "bg-yellow-400" : "bg-red-500"}`}
                          style={{ width: `${Math.min(100, Math.round((sysInfo.ghRateLimit / 5000) * 100))}%` }} />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ─ LIMITES DE TOKEN IA ─ */}
              <div>
                <p className="text-[10px] text-slate-500 font-semibold tracking-widest mb-2">🤖 LIMITES DE TOKENS POR MODELO DE IA</p>
                <div className="bg-slate-800/60 rounded-xl overflow-hidden">
                  <div className="grid grid-cols-4 text-[9px] text-slate-500 font-semibold px-3 py-1.5 border-b border-slate-700">
                    <span>PROVEDOR</span><span>MODELO</span><span className="text-center">CONTEXTO</span><span className="text-center">MAX OUT</span>
                  </div>
                  {AI_TOKEN_LIMITS.map((row, i) => (
                    <div key={i} className={`grid grid-cols-4 text-[10px] px-3 py-1.5 items-center ${i % 2 === 0 ? "bg-slate-800/40" : ""}`}>
                      <span className="font-semibold" style={{ color: row.color }}>{row.provider}</span>
                      <span className="text-slate-300 font-mono text-[9px]">{row.model}</span>
                      <span className="text-center font-bold text-cyan-300">{row.ctx}</span>
                      <span className="text-center text-slate-400">{row.out}</span>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-slate-600 mt-1 px-1">ctx = contexto total da conversa · out = máximo por resposta</p>
              </div>

              {/* ─ LIMITES DO APP ─ */}
              <div>
                <p className="text-[10px] text-slate-500 font-semibold tracking-widest mb-2">📦 LIMITES DO APK BUILDER</p>
                <div className="grid grid-cols-2 gap-2 text-[10px]">
                  {[
                    { label: "Arquivos por import", val: "∞ Sem limite", ok: true },
                    { label: "Tamanho ZIP import", val: "Sem limite (stream)", ok: true },
                    { label: "Repos GitHub", val: "Qualquer tamanho", ok: true },
                    { label: "Export ZIP Android", val: "Até RAM disponível", ok: true },
                    { label: "Sessão salva", val: "IndexedDB (GBs)", ok: true },
                    { label: "Push GitHub", val: "Até 100 MB por arquivo", ok: true },
                  ].map((item, i) => (
                    <div key={i} className="bg-slate-800/60 rounded-xl p-3">
                      <p className="text-slate-500 mb-0.5">{item.label}</p>
                      <p className={`font-bold ${item.ok ? "text-green-400" : "text-yellow-400"}`}>{item.val}</p>
                    </div>
                  ))}
                </div>
              </div>

            </div>

            <div className="bg-violet-900/20 border border-violet-700/40 rounded-2xl p-4">
              <h2 className="font-bold text-violet-300 mb-1">📖 Do PWA ao APK instalado</h2>
              <p className="text-xs text-slate-400">Passo a passo completo — do projeto web ao app no celular.</p>
            </div>
            {[
              { icon: "1️⃣", t: "Gere o build do seu PWA", b: "No terminal do projeto: `pnpm build` ou `npm run build`. Isso cria a pasta `dist/`. Compacte como ZIP ou use o GitHub." },
              { icon: "2️⃣", t: "Importe aqui", b: "Aba Importar → arraste o ZIP. Ou aba GitHub → cole o token → selecione o repositório. Detecção automática de nome e ID." },
              { icon: "3️⃣", t: "Configure o APK", b: "Na aba Exportar: defina nome, package ID único (ex: com.seunome.meuapp), versão e cores. O ID não pode mudar depois que o app for instalado." },
              { icon: "4️⃣", t: "Gere e baixe", b: "Clique em 'Gerar Projeto Android'. Baixa um ZIP com o projeto Android Studio completo + seus arquivos já embutidos na pasta dist/." },
              { icon: "5️⃣", t: "Abra no Android Studio", b: "Extraia o ZIP. Android Studio → File → Open → pasta android/ dentro do ZIP. Aguarde Gradle sync (5-10 min na primeira vez)." },
              { icon: "6️⃣", t: "Compile o APK", b: "Build → Build Bundle(s)/APK(s) → Build APK(s). APK em: android/app/build/outputs/apk/debug/app-debug.apk" },
              { icon: "7️⃣", t: "Instale no celular", b: "Configurações → Segurança → Instalar de fontes desconhecidas ✓. Transfira o .apk via USB, WhatsApp ou Drive e instale." },
              { icon: "8️⃣", t: "Para corrigir algo", b: "Use o ProCode Studio (botão na aba Exportar), edite os arquivos, exporte novamente como ZIP e reimporte aqui. A sessão fica salva." },
            ].map((s, i) => (
              <div key={i} className="bg-slate-900/60 border border-slate-700 rounded-xl p-4 flex gap-3">
                <span className="text-xl mt-0.5 shrink-0">{s.icon}</span>
                <div>
                  <p className="font-semibold text-sm mb-0.5">{s.t}</p>
                  <p className="text-xs text-slate-400 leading-relaxed">{s.b}</p>
                </div>
              </div>
            ))}
            <div className="bg-slate-900/60 border border-slate-700 rounded-xl p-4">
              <p className="font-semibold text-sm text-blue-300 mb-1">💡 Assinar para a Google Play Store</p>
              <p className="text-xs text-slate-400">No Android Studio: Build → Generate Signed Bundle/APK → crie um keystore (.jks). Guarde o keystore com segurança — sem ele não é possível atualizar o app na loja.</p>
            </div>
          </div>
        )}

        {/* ══ TAB: DOWNLOADS ══════════════════════════════════════ */}
        {tab === "downloads" && (
          <div className="space-y-4">
            <div className="bg-green-900/20 border border-green-700/50 rounded-2xl p-4">
              <h2 className="font-bold text-green-300 text-base mb-1">⬇ APKs Prontos para Instalar</h2>
              <p className="text-xs text-slate-400">Arquivos assinados com v1 + v2 APK Signature Scheme. Instale direto no Android — sem precisar compilar nada.</p>
            </div>

            {[
              { name: "ConstruAPK Pro", ver: "v2.0", pkg: "br.construapk.pro.main", size: "61 MB", icon: "📦", color: "violet", desc: "Construtor de APKs Android direto do navegador", file: "ConstruAPK-Pro-v2.0.apk" },
              { name: "ProCode Studio", ver: "v3.0", pkg: "br.procode.studio.main", size: "8.5 MB", icon: "💻", color: "blue", desc: "Editor de código com IA — assistente Raquel", file: "ProCode-Studio-v3.0.apk" },
              { name: "JurisPro", ver: "v2.0", pkg: "br.jurispro.legal.main", size: "8.8 MB", icon: "⚖️", color: "green", desc: "Assistente jurídico com IA — Iara", file: "JurisPro-v2.0.apk" },
            ].map(app => (
              <div key={app.pkg} className="bg-slate-900/60 border border-slate-700 rounded-2xl p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <span className="text-3xl">{app.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-bold text-white">{app.name}</h3>
                      <span className="text-[10px] font-mono bg-slate-800 text-slate-400 border border-slate-600 px-1.5 py-0.5 rounded-full">{app.ver}</span>
                      <span className="text-[10px] text-slate-500">{app.size}</span>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">{app.desc}</p>
                    <p className="text-[10px] font-mono text-slate-600 mt-0.5">{app.pkg}</p>
                  </div>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <a
                    href={`${import.meta.env.BASE_URL}apks/${app.file}`}
                    download={app.file}
                    className="flex-1 min-w-[140px] py-2.5 bg-green-700 hover:bg-green-600 rounded-xl font-bold text-sm text-white text-center transition-all"
                  >
                    ⬇ Baixar APK
                  </a>
                </div>
                <div className="bg-slate-800/60 rounded-xl p-3 text-xs text-slate-400 space-y-1">
                  <p className="font-semibold text-slate-300">📲 Como instalar:</p>
                  <p>1. Baixe o APK acima</p>
                  <p>2. Configurações → Segurança → Fontes desconhecidas ✓</p>
                  <p>3. Abra o arquivo APK no celular → Instalar</p>
                </div>
              </div>
            ))}

            <div className="bg-amber-900/20 border border-amber-700/40 rounded-xl p-3 text-xs text-amber-300 space-y-1">
              <p className="font-semibold">✅ Assinatura verificada:</p>
              <p>Todos os APKs têm assinatura v1 + v2 válida. Android 5.0+ (API 21) ou superior.</p>
              <p className="text-slate-500 mt-1">Certificado: CN=Maikon Caldeira · OAB/MG 183712 · O=SK Juridico</p>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}
