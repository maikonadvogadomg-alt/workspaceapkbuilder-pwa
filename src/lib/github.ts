import type { ArchiveFile } from "./archive";
import sodium from "libsodium-wrappers";

const GH = "https://api.github.com";

function headers(token: string): Record<string, string> {
  const base: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) base["Authorization"] = `token ${token}`;
  return base;
}

/* ── Proxy do servidor (evita CORS do browser) ─────────────── */
function proxyZipUrl(owner: string, repo: string, branch: string, token?: string): string {
  const params = new URLSearchParams({ owner, repo, branch });
  if (token) params.set("token", token);
  return `/api/gh-proxy/zipball?${params}`;
}

function proxyRepoUrl(owner: string, repo: string, token?: string): string {
  const params = new URLSearchParams({ owner, repo });
  if (token) params.set("token", token);
  return `/api/gh-proxy/repo?${params}`;
}

/* ── Auth ─────────────────────────────────────────────────── */
export interface GhUser {
  login: string;
  name: string;
  avatar_url: string;
}

export async function ghGetUser(token: string): Promise<GhUser> {
  const r = await fetch(`${GH}/user`, { headers: headers(token) });
  if (!r.ok) throw new Error(`Token inválido ou sem permissão: ${r.status}`);
  return r.json();
}

/* ── Repos ───────────────────────────────────────────────── */
export interface GhRepo {
  full_name: string;
  name: string;
  description: string;
  default_branch: string;
  private: boolean;
  html_url: string;
  size?: number;
}

export async function ghListRepos(token: string): Promise<GhRepo[]> {
  const r = await fetch(`${GH}/user/repos?per_page=100&sort=updated`, {
    headers: headers(token),
  });
  if (!r.ok) throw new Error(`Erro ao listar repos: ${r.status}`);
  return r.json();
}

export async function ghGetRepo(token: string, owner: string, repo: string): Promise<GhRepo> {
  const r = await fetch(proxyRepoUrl(owner, repo, token || undefined));
  if (!r.ok) throw new Error(`Repositório não encontrado: ${r.status}`);
  return r.json();
}

/* ── Extrai ZIP — SEM LIMITE, todos os arquivos ─────────── */
async function extractZip(res: Response, onProgress?: (m: string) => void): Promise<ArchiveFile[]> {
  const log = (m: string) => onProgress?.(m);
  log("Lendo ZIP...");
  const buf = await res.arrayBuffer();
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(buf);

  const entries = Object.entries(zip.files);
  const allFiles = entries.filter(([, v]) => !v.dir).map(([k]) => k);
  const tops = [...new Set(allFiles.map(k => k.split("/")[0]))];
  const prefix = tops.length === 1 ? tops[0] + "/" : "";

  const files: ArchiveFile[] = [];
  let processed = 0;
  for (const [path, entry] of entries) {
    if (entry.dir) continue;
    const rel = prefix ? path.slice(prefix.length) : path;
    if (!rel) continue;
    try {
      const content = await entry.async("arraybuffer");
      files.push({ path: rel, content });
    } catch { /* ignora arquivo corrompido */ }
    processed++;
    if (processed % 500 === 0) log(`Extraindo... ${files.length} arquivos processados`);
  }

  if (files.length === 0) throw new Error("ZIP não contém arquivos.");
  log(`✅ ${files.length} arquivos importados`);
  return files;
}

/* ── Import via proxy (privado ou público com token) ─────── */
export async function ghImportRepo(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  onProgress?: (msg: string) => void
): Promise<ArchiveFile[]> {
  const log = (m: string) => onProgress?.(m);

  log("Verificando repositório...");
  let defaultBranch = branch;
  try {
    const info = await fetch(proxyRepoUrl(owner, repo, token || undefined));
    if (info.ok) {
      const j = await info.json() as GhRepo;
      defaultBranch = branch || j.default_branch || "main";
    }
  } catch { /* ignora */ }

  log(`Baixando ${owner}/${repo}...`);
  const zipRes = await fetch(proxyZipUrl(owner, repo, defaultBranch, token || undefined));

  if (!zipRes.ok) {
    const err = await zipRes.json().catch(() => ({})) as Record<string, string>;
    throw new Error(err.error || `Erro ao baixar repositório: ${zipRes.status}`);
  }

  return extractZip(zipRes, onProgress);
}

/* ── Import público (sem token) ──────────────────────────── */
export async function ghImportPublicRepo(
  repoInput: string,
  onProgress?: (msg: string) => void
): Promise<{ files: ArchiveFile[]; repoName: string; branch: string }> {
  const log = (m: string) => onProgress?.(m);

  const clean = repoInput.trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

  const parts = clean.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("Formato inválido. Use: usuario/repositorio ou https://github.com/usuario/repositorio");

  const owner = parts[0];
  const repoName = parts[1];

  log(`Verificando ${owner}/${repoName}...`);
  const infoRes = await fetch(proxyRepoUrl(owner, repoName));
  if (!infoRes.ok) {
    const err = await infoRes.json().catch(() => ({})) as Record<string, string>;
    if (infoRes.status === 404) throw new Error(`Repositório não encontrado: ${owner}/${repoName}. Verifique se é público.`);
    throw new Error(err.error || `Erro ao acessar repo: ${infoRes.status}`);
  }
  const info = await infoRes.json() as GhRepo;
  if (info.private) throw new Error(`Este repositório é privado. Use seu token GitHub para importar.`);

  const branch = info.default_branch || "main";
  log(`Baixando ${owner}/${repoName}...`);
  const zipRes = await fetch(proxyZipUrl(owner, repoName, branch));
  if (!zipRes.ok) {
    const err = await zipRes.json().catch(() => ({})) as Record<string, string>;
    throw new Error(err.error || `Não foi possível baixar o repositório: ${zipRes.status}`);
  }

  const files = await extractZip(zipRes, log);
  return { files, repoName: info.name, branch };
}

/* ── Publish to GitHub Pages ─────────────────────────────── */
export async function ghPublishPages(
  token: string,
  repoName: string,
  files: ArchiveFile[],
  isPrivate: boolean,
  onProgress: (msg: string) => void
): Promise<string> {
  onProgress("Criando repositório...");
  const repoRes = await fetch(`${GH}/user/repos`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ name: repoName, private: isPrivate, auto_init: true, description: "PWA publicado pelo APK Builder" }),
  });
  if (!repoRes.ok) {
    const err = await repoRes.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error((err.message as string) || `Erro ao criar repo: ${repoRes.status}`);
  }
  const repoData = await repoRes.json() as { full_name: string; owner: { login: string } };
  const owner = repoData.owner.login;

  onProgress("Enviando arquivos...");
  await ghPushFiles(token, owner, repoName, files, "chore: publicar PWA via APK Builder", onProgress);

  onProgress("Ativando GitHub Pages...");
  await fetch(`${GH}/repos/${owner}/${repoName}/pages`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json", Accept: "application/vnd.github+json" },
    body: JSON.stringify({ source: { branch: "main", path: "/" } }),
  });

  return `https://${owner}.github.io/${repoName}/`;
}

/* ── Export (create repo + push files) ─────────────────── */
export async function ghCreateRepo(
  token: string,
  name: string,
  description: string,
  isPrivate: boolean
): Promise<{ full_name: string; html_url: string; default_branch: string }> {
  const r = await fetch(`${GH}/user/repos`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, private: isPrivate, auto_init: true }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as Record<string, string>).message || `Erro ao criar repo: ${r.status}`);
  }
  return r.json();
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function ghPushFiles(
  token: string,
  owner: string,
  repo: string,
  files: ArchiveFile[],
  message: string,
  onProgress?: (msg: string) => void
): Promise<void> {
  const refRes = await fetch(`${GH}/repos/${owner}/${repo}/git/refs/heads/main`, {
    headers: headers(token),
  });
  const ref = refRes.ok ? await refRes.json() : null;
  const baseSha = ref?.object?.sha;

  onProgress?.("Criando blobs...");
  const blobs: { path: string; sha: string }[] = [];
  let done = 0;
  for (const f of files) {
    try {
      const b64 = toBase64(f.content);
      const bRes = await fetch(`${GH}/repos/${owner}/${repo}/git/blobs`, {
        method: "POST",
        headers: { ...headers(token), "Content-Type": "application/json" },
        body: JSON.stringify({ content: b64, encoding: "base64" }),
      });
      if (bRes.ok) {
        const bj = await bRes.json();
        blobs.push({ path: f.path, sha: bj.sha });
      }
    } catch { /* skip */ }
    done++;
    if (done % 10 === 0) onProgress?.(`Enviando arquivos... ${done}/${files.length}`);
  }

  onProgress?.("Criando tree...");
  const treeRes = await fetch(`${GH}/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      base_tree: baseSha,
      tree: blobs.map(b => ({ path: b.path, mode: "100644", type: "blob", sha: b.sha })),
    }),
  });
  if (!treeRes.ok) throw new Error(`Erro ao criar tree: ${treeRes.status}`);
  const treeData = await treeRes.json();

  onProgress?.("Criando commit...");
  const commitBody: Record<string, unknown> = {
    message,
    tree: treeData.sha,
    ...(baseSha ? { parents: [baseSha] } : {}),
  };
  const commitRes = await fetch(`${GH}/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify(commitBody),
  });
  if (!commitRes.ok) throw new Error(`Erro ao criar commit: ${commitRes.status}`);
  const commitData = await commitRes.json();

  onProgress?.("Atualizando branch...");
  const updateRes = await fetch(`${GH}/repos/${owner}/${repo}/git/refs/heads/main`, {
    method: "PATCH",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ sha: commitData.sha, force: true }),
  });
  if (!updateRes.ok) {
    await fetch(`${GH}/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "refs/heads/main", sha: commitData.sha }),
    });
  }
  onProgress?.("✅ Push concluído!");
}

/* ── Set GitHub repo secret (criptografa com libsodium) ──── */
export async function ghSetRepoSecret(
  token: string,
  owner: string,
  repo: string,
  secretName: string,
  secretValue: string
): Promise<void> {
  await sodium.ready;

  // 1. Obter chave pública do repositório
  const keyRes = await fetch(`${GH}/repos/${owner}/${repo}/actions/public-key`, {
    headers: headers(token),
  });
  if (!keyRes.ok) throw new Error(`Erro ao obter chave pública do repo: ${keyRes.status}`);
  const { key, key_id } = await keyRes.json() as { key: string; key_id: string };

  // 2. Criptografar o secret com a chave pública (NaCl box seal)
  const binKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
  const binVal = sodium.from_string(secretValue);
  const encrypted = sodium.crypto_box_seal(binVal, binKey);
  const encryptedB64 = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);

  // 3. Salvar o secret criptografado no repositório
  const putRes = await fetch(`${GH}/repos/${owner}/${repo}/actions/secrets/${secretName}`, {
    method: "PUT",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ encrypted_value: encryptedB64, key_id }),
  });
  if (!putRes.ok && putRes.status !== 204) {
    throw new Error(`Erro ao salvar secret ${secretName}: ${putRes.status}`);
  }
}
