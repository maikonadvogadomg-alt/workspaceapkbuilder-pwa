import pako from "pako";

export interface ArchiveFile {
  path: string;
  content: ArrayBuffer;
}

/* ── TAR parser ─────────────────────────────────────────── */
function readString(buf: Uint8Array, offset: number, len: number): string {
  let s = "";
  for (let i = offset; i < offset + len; i++) {
    if (buf[i] === 0) break;
    s += String.fromCharCode(buf[i]);
  }
  return s;
}

export function parseTar(buffer: ArrayBuffer): ArchiveFile[] {
  const bytes = new Uint8Array(buffer);
  const files: ArchiveFile[] = [];
  let offset = 0;

  while (offset + 512 <= bytes.length) {
    const header = bytes.slice(offset, offset + 512);
    const name = readString(header, 0, 100).trim();
    const prefix = readString(header, 345, 155).trim();
    const fullName = prefix ? prefix + "/" + name : name;
    if (!fullName || fullName === "./" || fullName === ".") { offset += 512; continue; }

    const sizeStr = readString(header, 124, 12).trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    const typeFlag = String.fromCharCode(header[156]);
    offset += 512;

    if ((typeFlag === "0" || typeFlag === "\0" || typeFlag === "") && size > 0) {
      const content = buffer.slice(offset, offset + size);
      const cleanPath = fullName.replace(/^\.\//, "").replace(/^[^/]+\//, "");
      if (cleanPath) files.push({ path: cleanPath, content });
    }

    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

/* ── Detect & extract any archive ──────────────────────── */
export async function extractArchive(file: File): Promise<ArchiveFile[]> {
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (e) {
    const code = e instanceof DOMException ? ` (código ${e.code})` : "";
    throw new Error(`Falha ao ler o arquivo${code}. Tente um ZIP menor ou use GitHub.`);
  }
  const name = file.name.toLowerCase();

  // TAR.GZ / TGZ
  if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
    const decompressed = pako.ungzip(new Uint8Array(buffer)).buffer;
    return parseTar(decompressed);
  }

  // TAR.BZ2 — not supported natively, graceful error
  if (name.endsWith(".tar.bz2") || name.endsWith(".tbz2")) {
    throw new Error("Formato .tar.bz2 não suportado. Use .tar.gz ou .zip.");
  }

  // Plain TAR
  if (name.endsWith(".tar")) {
    return parseTar(buffer);
  }

  // ZIP (default)
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.entries(zip.files);

  // Pastas que nunca precisam ir para o APK
  const SKIP = /(?:^|\/)(node_modules|\.git|\.svn|\.hg|__pycache__|\.DS_Store)(?:\/|$)/i;

  const keys = entries.filter(([, v]) => !v.dir).map(([k]) => k);

  // Remove apenas o prefixo raiz único que o GitHub/ZIP adiciona (ex: "repo-main/")
  // Nunca restringe a dist/ ou qualquer subpasta — importa TUDO
  const tops = [...new Set(keys.map(k => k.split("/")[0]))];
  const prefix = tops.length === 1 ? tops[0] + "/" : "";

  const result: ArchiveFile[] = [];
  for (const [path, entry] of entries) {
    if (entry.dir) continue;
    if (SKIP.test(path)) continue;
    const rel = prefix ? path.slice(prefix.length) : path;
    if (!rel) continue;
    result.push({ path: rel, content: await entry.async("arraybuffer") });
  }
  return result;
}

/* ── Extract web files from an existing APK ────────────────── */
export async function extractApk(file: File): Promise<ArchiveFile[]> {
  const buffer = await file.arrayBuffer();
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(buffer);

  // APK assets live in assets/public/ — extract and strip that prefix
  const result: ArchiveFile[] = [];
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (path.startsWith("assets/public/")) {
      const rel = path.slice("assets/public/".length);
      if (!rel) continue;
      result.push({ path: rel, content: await entry.async("arraybuffer") });
    }
  }

  // Fallback: if no assets/public/ found, treat it as a regular ZIP
  if (result.length === 0) {
    const keys = Object.keys(zip.files).filter(k => !zip.files[k].dir);
    const tops = [...new Set(keys.map(k => k.split("/")[0]))];
    const prefix = tops.length === 1 ? tops[0] + "/" : "";
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const rel = prefix ? path.slice(prefix.length) : path;
      if (rel) result.push({ path: rel, content: await entry.async("arraybuffer") });
    }
  }
  return result;
}

/* ── Analyze project and suggest cleanup + config ───────────── */
export interface ProjectAnalysis {
  detectedName: string;
  detectedId: string;
  techStack: string[];
  suggestions: { label: string; detail: string; action: "keep" | "remove" | "rename" | "config" }[];
  fileCounts: { html: number; js: number; css: number; img: number; other: number; total: number };
  unnecessaryFiles: string[];
}

export function analyzeProject(files: ArchiveFile[], fallbackName: string): ProjectAnalysis {
  function decode(f: ArchiveFile) {
    try { return new TextDecoder("utf-8", { fatal: false }).decode(f.content); } catch { return ""; }
  }

  // Detect tech stack
  const techStack: string[] = [];
  const paths = files.map(f => f.path.toLowerCase());

  if (paths.some(p => p === "index.html" || p.endsWith("/index.html"))) techStack.push("HTML");
  if (paths.some(p => p.includes("react") || p.includes("jsx"))) techStack.push("React");
  if (paths.some(p => p.includes("vue"))) techStack.push("Vue");
  if (paths.some(p => p.includes("angular"))) techStack.push("Angular");
  if (paths.some(p => p.includes("svelte"))) techStack.push("Svelte");
  if (paths.some(p => p === "manifest.json" || p === "manifest.webmanifest")) techStack.push("PWA");
  if (paths.some(p => p.includes("sw.js") || p.includes("service-worker"))) techStack.push("ServiceWorker");
  if (paths.some(p => p.includes("capacitor"))) techStack.push("Capacitor");
  if (paths.some(p => p.includes("workbox"))) techStack.push("Workbox");

  // File counts
  let html = 0, js = 0, css = 0, img = 0, other = 0;
  for (const f of files) {
    const ext = f.path.split(".").pop()?.toLowerCase() || "";
    if (ext === "html" || ext === "htm") html++;
    else if (["js", "mjs", "ts", "jsx", "tsx"].includes(ext)) js++;
    else if (["css", "scss", "sass", "less"].includes(ext)) css++;
    else if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) img++;
    else other++;
  }

  // Unnecessary files
  const unnecessaryFiles = files
    .filter(f => {
      const p = f.path.toLowerCase();
      return p.endsWith(".map") ||           // source maps
        p.includes(".test.") ||              // test files
        p.includes(".spec.") ||              // spec files
        p.includes("__tests__") ||           // test folders
        p.includes("node_modules") ||        // dependencies
        p.endsWith(".md") ||                 // markdown docs
        p.endsWith(".txt") ||                // text files
        p.includes(".git/") ||               // git files
        p.endsWith(".log") ||                // logs
        p.includes("coverage/") ||           // test coverage
        p.endsWith(".d.ts");                 // TS declarations
    })
    .map(f => f.path);

  // Suggestions
  const suggestions: ProjectAnalysis["suggestions"] = [];

  if (unnecessaryFiles.length > 0) {
    suggestions.push({
      label: `🗑 Remover ${unnecessaryFiles.length} arquivo(s) desnecessário(s)`,
      detail: `Source maps (.map), arquivos de teste e documentação que aumentam o tamanho sem necessidade`,
      action: "remove",
    });
  }

  if (!techStack.includes("PWA")) {
    suggestions.push({
      label: "⚠️ manifest.json não encontrado",
      detail: "O Builder vai gerar um manifest.json automaticamente baseado no nome e ícone que você configurar",
      action: "config",
    });
  }

  if (!techStack.includes("ServiceWorker")) {
    suggestions.push({
      label: "💡 Sem Service Worker detectado",
      detail: "Sem SW o app não funciona offline. Configure um ícone e o Builder vai otimizar isso",
      action: "config",
    });
  }

  if (js > 20) {
    suggestions.push({
      label: `📦 ${js} arquivos JS — app otimizado`,
      detail: "Múltiplos chunks JS indicam um build otimizado (Vite/Webpack). Ótimo para APK.",
      action: "keep",
    });
  }

  if (techStack.includes("React")) {
    suggestions.push({
      label: "⚛️ React detectado — configuração otimizada",
      detail: "webViewUrl: file:///android_asset/public/index.html — já configurado automaticamente",
      action: "config",
    });
  }

  if (img === 0) {
    suggestions.push({
      label: "🖼 Nenhum ícone encontrado",
      detail: "Configure um ícone na aba Exportar para o APK ter aparência profissional",
      action: "config",
    });
  }

  // Guess name/id from config
  const { name, id } = guessConfig(files, fallbackName);

  return {
    detectedName: name,
    detectedId: id,
    techStack,
    suggestions,
    fileCounts: { html, js, css, img, other, total: files.length },
    unnecessaryFiles,
  };
}

/* ── Guess config (package.json + Android + Capacitor + Expo) ── */
export function guessConfig(files: ArchiveFile[], fallbackName: string) {
  let name = fallbackName.replace(/\.(zip|tar\.gz|tgz|tar)$/i, "").replace(/[_-]/g, " ");
  let id = "com.meuapp." + fallbackName.replace(/\.(zip|tar\.gz|tgz|tar)$/i, "").replace(/[^a-z0-9]/gi, "").toLowerCase();

  function decode(f: ArchiveFile): string {
    try { return new TextDecoder("utf-8", { fatal: false }).decode(f.content); } catch { return ""; }
  }

  // 1. package.json
  const pkgFile = files.find(f => f.path === "package.json" || f.path.endsWith("/package.json"));
  if (pkgFile) {
    try {
      const pkg = JSON.parse(decode(pkgFile));
      if (pkg.name) { name = pkg.name; id = "com.meuapp." + pkg.name.replace(/[^a-z0-9]/gi, "").toLowerCase(); }
    } catch {}
  }

  // 2. capacitor.config.ts/js/json
  const capFile = files.find(f => /capacitor\.config\.(ts|js|json)$/.test(f.path));
  if (capFile) {
    const txt = decode(capFile);
    const idM = txt.match(/appId\s*[:=]\s*['"`]([^'"`]+)['"`]/);
    const nmM = txt.match(/appName\s*[:=]\s*['"`]([^'"`]+)['"`]/);
    if (idM) id = idM[1];
    if (nmM) name = nmM[1];
  }

  // 3. app.json (Expo)
  const appJson = files.find(f => f.path === "app.json" || f.path.endsWith("/app.json"));
  if (appJson) {
    try {
      const j = JSON.parse(decode(appJson));
      const expo = j.expo ?? j;
      if (expo.name) name = expo.name;
      if (expo.android?.package) id = expo.android.package;
    } catch {}
  }

  // 4. AndroidManifest.xml
  const manifest = files.find(f => f.path.endsWith("AndroidManifest.xml"));
  if (manifest) {
    const txt = decode(manifest);
    const m = txt.match(/package\s*=\s*["']([^"']+)["']/);
    if (m) id = m[1];
    const lm = txt.match(/android:label\s*=\s*["']([^"'@]+)["']/);
    if (lm) name = lm[1];
  }

  // 5. app/build.gradle
  const gradle = files.find(f => /app[/\\]build\.gradle(\.kts)?$/.test(f.path));
  if (gradle) {
    const txt = decode(gradle);
    const m = txt.match(/applicationId\s+["']([^"']+)["']/);
    if (m) id = m[1];
  }

  // 6. settings.gradle
  const settings = files.find(f => /settings\.gradle(\.kts)?$/.test(f.path));
  if (settings) {
    const txt = decode(settings);
    const m = txt.match(/rootProject\.name\s*=\s*["']([^"']+)["']/);
    if (m && !name) name = m[1];
  }

  return { name: name || fallbackName, id };
}
