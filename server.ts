// A página da TV fica em index.html, ao lado deste arquivo.
const HTML = await Bun.file(new URL("./index.html", import.meta.url)).text();

const UA_PADRAO = "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0 Safari/537.36";
const BLOQUEADOS = /^(localhost|0\.|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[|metadata\.)|\.internal$|\.local$/i;
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-length, content-range" };

function alvo(s: string | null): URL | null {
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (BLOQUEADOS.test(u.hostname)) return null;
    return u;
  } catch { return null; }
}

// Perfis usados quando a emissora responde 403/401: muitas só aceitam players conhecidos (VLC, Kodi)
// ou o próprio site como origem. O servidor lembra qual perfil funcionou para cada emissora.
const PERFIS: { ua: string; refDoProprio: boolean }[] = [
  { ua: "", refDoProprio: false },
  { ua: "VLC/3.0.21 LibVLC/3.0.21", refDoProprio: false },
  { ua: "Kodi/21.3 (Windows NT 10.0; Win64; x64) App_Bitness/64 Version/21.3", refDoProprio: false },
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", refDoProprio: true },
];
const perfilPorHost = new Map<string, number>();

async function buscar(u: URL, ref: string | null, ua: string | null, range: string | null, ms: number): Promise<Response> {
  // Pluto TV usa chave própria no link; trocar o perfil não muda nada, então vai direto.
  const tentativas = /pluto\.tv$/i.test(u.hostname) ? 1 : PERFIS.length;
  const inicio = perfilPorHost.get(u.host) ?? 0;
  for (let k = 0; k < tentativas; k++) {
    const i = (inicio + k) % PERFIS.length;
    const p = PERFIS[i];
    const r = await fetch(u.href, {
      headers: { ...cabecalhos(ref || (p.refDoProprio ? u.origin + "/" : null), (i === 0 ? ua : null) || p.ua || null, range), ...(/pluto\.tv$|plutotv\.net$|jmp2\.uk$/i.test(u.hostname) ? { "x-forwarded-for": IP_BR } : {}) },
      redirect: "follow", signal: AbortSignal.timeout(ms),
    });
    if (r.status !== 403 && r.status !== 401) {
      if (i !== 0 || perfilPorHost.has(u.host)) perfilPorHost.set(u.host, i);
      return r;
    }
    // A última resposta volta inteira para quem chamou; só as anteriores são descartadas.
    if (k === tentativas - 1) return r;
    r.body?.cancel();
  }
  throw new Error("sem tentativas");
}

function cabecalhos(ref: string | null, ua: string | null, range?: string | null): Record<string, string> {
  // identity: alguns servidores (Pluto, por exemplo) marcam a chave do vídeo como gzip sem ela estar
  // comprimida, e a descompressão automática quebrava no meio da transmissão.
  const h: Record<string, string> = { "user-agent": ua || UA_PADRAO, accept: "*/*", "accept-encoding": "identity" };
  if (ref) {
    h.referer = ref;
    try { h.origin = new URL(ref).origin; } catch {}
  }
  if (range) h.range = range;
  return h;
}

function viaRelay(abs: string, ref: string | null, ua: string | null): string {
  let q = "/p?u=" + encodeURIComponent(abs);
  if (ref) q += "&r=" + encodeURIComponent(ref);
  if (ua) q += "&a=" + encodeURIComponent(ua);
  return q;
}

// Reescreve uma playlist HLS para que cada endereço passe pelo relay.
function reescrever(texto: string, base: string, ref: string | null, ua: string | null): string {
  return texto.split(/\r?\n/).map((linha) => {
    const l = linha.trim();
    if (!l) return linha;
    if (l.startsWith("#")) {
      return linha.replace(/URI="([^"]+)"/g, (_m, uri) => {
        try { return 'URI="' + viaRelay(new URL(uri, base).href, ref, ua) + '"'; } catch { return _m; }
      });
    }
    try { return viaRelay(new URL(l, base).href, ref, ua); } catch { return linha; }
  }).join("\n");
}

function ehPlaylist(url: string, tipo: string): boolean {
  return /mpegurl|m3u/i.test(tipo) || /\.m3u8?(\?|$)/i.test(url);
}

async function relay(req: Request, q: URLSearchParams): Promise<Response> {
  const u = alvo(q.get("u"));
  if (!u) return new Response("Endereço inválido", { status: 400, headers: CORS });
  const ref = q.get("r"), ua = q.get("a");
  let res: Response;
  try {
    res = await buscar(u, ref, ua, req.headers.get("range"), 20000);
  } catch (e) {
    console.log(JSON.stringify({ evt: "relay_erro", host: u.hostname, erro: String(e) }));
    return new Response("Não foi possível alcançar a transmissão", { status: 502, headers: CORS });
  }
  const tipo = res.headers.get("content-type") || "";
  if (res.ok && ehPlaylist(res.url || u.href, tipo)) {
    // Lê como bytes: o Pluto manda a chave do vídeo (16 bytes binários) marcada como playlist.
    // Ler isso como texto estragava a chave e o vídeo não abria.
    const bytes = new Uint8Array(await res.arrayBuffer());
    const comeco = new TextDecoder().decode(bytes.subarray(0, 32)).replace(/^﻿/, "").trimStart();
    if (comeco.startsWith("#EXTM3U")) {
      return new Response(reescrever(new TextDecoder().decode(bytes), res.url || u.href, ref, ua), {
        status: 200,
        headers: { ...CORS, "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-cache" },
      });
    }
    return new Response(bytes, { status: res.status, headers: { ...CORS, "content-type": "application/octet-stream", "content-length": String(bytes.length) } });
  }
  const h: Record<string, string> = { ...CORS };
  for (const k of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"]) {
    const v = res.headers.get(k);
    if (v) h[k] = v;
  }
  return new Response(res.body, { status: res.status, headers: h });
}

async function lista(q: URLSearchParams): Promise<Response> {
  const u = alvo(q.get("u"));
  if (!u) return new Response("Endereço inválido", { status: 400, headers: CORS });
  try {
    const res = await fetch(u.href, { headers: cabecalhos(null, null), redirect: "follow", signal: AbortSignal.timeout(30000) });
    const texto = await res.text();
    return new Response(texto, { status: res.status, headers: { ...CORS, "content-type": "text/plain; charset=utf-8" } });
  } catch {
    return new Response("Não foi possível baixar a lista", { status: 502, headers: CORS });
  }
}

// Free-TV: tenta o arquivo do Brasil; se não existir, filtra a lista geral pelo grupo Brasil.
async function freeTv(): Promise<Response> {
  const base = Bun.env.FREETV_BASE || "https://raw.githubusercontent.com/Free-TV/IPTV/master/";
  const headers = { ...CORS, "content-type": "text/plain; charset=utf-8" };
  for (const nome of ["playlists/playlist_brazil.m3u8", "playlists/playlist_brasil.m3u8"]) {
    try {
      const r = await fetch(base + nome, { signal: AbortSignal.timeout(20000) });
      if (r.ok) { const t = await r.text(); if (t.includes("#EXTINF")) return new Response(t, { headers }); }
    } catch {}
  }
  try {
    const r = await fetch(base + "playlist.m3u8", { signal: AbortSignal.timeout(30000) });
    const linhas = (await r.text()).split(/\r?\n/);
    const out = ["#EXTM3U"];
    for (let i = 0; i < linhas.length; i++) {
      if (linhas[i].startsWith("#EXTINF") && /bra[sz]il/i.test(linhas[i])) {
        let j = i + 1;
        const bloco = [linhas[i]];
        while (j < linhas.length && linhas[j].startsWith("#")) bloco.push(linhas[j++]);
        if (j < linhas.length) { bloco.push(linhas[j]); out.push(...bloco); }
        i = j;
      }
    }
    return new Response(out.join("\n"), { headers });
  } catch {
    return new Response("Não foi possível baixar a lista do Free-TV", { status: 502, headers: CORS });
  }
}

// Diagnóstico de um canal: segue a transmissão como o player faria (lista mestre, variante,
// chave e primeiro pedaço do vídeo) e mostra o que cada etapa respondeu.
async function diagnostico(q: URLSearchParams): Promise<Response> {
  const etapas: Record<string, unknown>[] = [];
  const ref = q.get("r"), ua = q.get("a");
  async function passo(nome: string, url: string, range: string | null) {
    const u = alvo(url);
    if (!u) { etapas.push({ nome, url, erro: "endereço inválido" }); return null; }
    try {
      const r = await buscar(u, ref, ua, range, 15000);
      const tipo = r.headers.get("content-type") || "";
      const texto = ehPlaylist(r.url || u.href, tipo) ? await r.text() : null;
      if (texto === null) r.body?.cancel();
      etapas.push({ nome, url: u.href.slice(0, 160), final: (r.url || "").slice(0, 160), status: r.status, tipo, codificacao: r.headers.get("content-encoding"), tamanho: r.headers.get("content-length"), inicio: texto ? texto.slice(0, 400) : undefined });
      return texto !== null ? { texto, base: r.url || u.href } : null;
    } catch (e) { etapas.push({ nome, url: u.href.slice(0, 160), erro: String(e) }); return null; }
  }
  const primeiraUrl = (t: string) => t.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  const m = await passo("mestre", q.get("u") || "", null);
  let media = m;
  if (m && m.texto.includes("#EXT-X-STREAM-INF")) {
    const v = primeiraUrl(m.texto);
    if (v) media = await passo("variante", new URL(v, m.base).href, null);
  }
  if (media) {
    const chave = media.texto.match(/#EXT-X-KEY:[^\n]*URI="([^"]+)"/);
    if (chave) await passo("chave", new URL(chave[1], media.base).href, null);
    const seg = primeiraUrl(media.texto);
    if (seg) await passo("pedaco", new URL(seg, media.base).href, "bytes=0-1023");
  }
  return new Response(JSON.stringify({ etapas }, null, 1), { headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

async function testar(q: URLSearchParams): Promise<Response> {
  const r = await verificar(q.get("u"), q.get("r"), q.get("a"));
  console.log(JSON.stringify({ evt: "check", host: (alvo(q.get("u"))?.hostname) || "?", ok: r.ok, motivo: r.motivo }));
  return new Response(JSON.stringify(r), { headers: { ...CORS, "content-type": "application/json" } });
}

async function verificar(url: string | null, ref: string | null, ua: string | null): Promise<{ ok: boolean; motivo: string }> {
  const json = (ok: boolean, motivo: string) => ({ ok, motivo });
  const u = alvo(url);
  if (!u) return json(false, "endereço inválido");
  try {
    const res = await buscar(u, ref, ua, "bytes=0-65535", 8000);
    if (!res.ok && res.status !== 206) return json(false, "HTTP " + res.status);
    const tipo = res.headers.get("content-type") || "";
    if (!ehPlaylist(res.url || u.href, tipo)) {
      res.body?.cancel();
      // Página de site (YouTube, portal da emissora) não é vídeo que a TV consegue tocar.
      if (/text\/html|json/i.test(tipo) || /youtube\.com|youtu\.be/i.test(res.url || u.href)) return json(false, "página, não vídeo");
      return json(true, "arquivo");
    }
    const texto = await res.text();
    if (!texto.trimStart().startsWith("#EXTM3U")) return json(false, "não é transmissão");
    // Se for playlist mestre, confere a primeira variante também.
    if (texto.includes("#EXT-X-STREAM-INF")) {
      const linhas = texto.split(/\r?\n/);
      const i = linhas.findIndex((l) => l.startsWith("#EXT-X-STREAM-INF"));
      const prox = linhas.slice(i + 1).find((l) => l.trim() && !l.startsWith("#"));
      if (prox) {
        const v = await buscar(new URL(prox.trim(), res.url || u.href), ref, ua, null, 8000);
        v.body?.cancel();
        if (!v.ok) return json(false, "variante HTTP " + v.status);
      }
    }
    return json(true, "no ar");
  } catch (e) {
    return json(false, String(e).includes("timeout") ? "sem resposta" : "erro de conexão");
  }
}

// ---------- Armazenamento no Railway Bucket ----------
// Guarda a última lista testada. Quando o servidor reinicia, a TV já recebe os canais na hora,
// sem esperar a rodada de testes. Sem bucket configurado (ou se ele falhar), o servidor funciona como antes.
const TEM_S3 = !!(Bun.env.S3_BUCKET && Bun.env.S3_ACCESS_KEY_ID && Bun.env.S3_SECRET_ACCESS_KEY);
// O provedor do bucket aceita assinaturas em formatos diferentes; o servidor testa as combinações
// ao ligar e fica com a primeira que funcionar.
const COMBINACOES = [
  { estilo: "virtual", virtualHostedStyle: true, region: Bun.env.S3_REGION || "auto" },
  { estilo: "virtual", virtualHostedStyle: true, region: "us-east-1" },
  { estilo: "caminho", virtualHostedStyle: false, region: Bun.env.S3_REGION || "auto" },
  { estilo: "caminho", virtualHostedStyle: false, region: "us-east-1" },
];
function clienteS3(i: number) {
  const c = COMBINACOES[i];
  return new Bun.S3Client({
    bucket: Bun.env.S3_BUCKET, accessKeyId: Bun.env.S3_ACCESS_KEY_ID, secretAccessKey: Bun.env.S3_SECRET_ACCESS_KEY,
    endpoint: Bun.env.S3_ENDPOINT, region: c.region, virtualHostedStyle: c.virtualHostedStyle,
  });
}
let S3: ReturnType<typeof clienteS3> | null = null;
async function conectarBucket(): Promise<void> {
  if (!TEM_S3) return;
  const erros: string[] = [];
  for (let i = 0; i < COMBINACOES.length; i++) {
    try {
      const c = clienteS3(i);
      await c.write("teste-conexao.txt", "ok " + new Date().toISOString(), { type: "text/plain" });
      S3 = c;
      console.log(JSON.stringify({ evt: "bucket_ok", estilo: COMBINACOES[i].estilo, regiao: COMBINACOES[i].region }));
      return;
    } catch (e) {
      erros.push(COMBINACOES[i].estilo + "/" + COMBINACOES[i].region + ": " + String(e));
    }
  }
  console.log(JSON.stringify({ evt: "bucket_erro", acao: "conectar", tentativas: erros }));
}
const PASTA_LOCAL = Bun.env.TL_STORE_DIR || ""; // só para testes no computador

async function guardar(nome: string, conteudo: string, tipo: string): Promise<void> {
  try {
    if (S3) await S3.write(nome, conteudo, { type: tipo });
    else if (PASTA_LOCAL) await Bun.write(PASTA_LOCAL + "/" + nome, conteudo);
  } catch (e) {
    console.log(JSON.stringify({ evt: "bucket_erro", acao: "guardar", nome, erro: String(e) }));
  }
}
async function ler(nome: string): Promise<string | null> {
  try {
    if (S3) { const f = S3.file(nome); if (await f.exists()) return await f.text(); }
    else if (PASTA_LOCAL) { const f = Bun.file(PASTA_LOCAL + "/" + nome); if (await f.exists()) return await f.text(); }
  } catch (e) {
    console.log(JSON.stringify({ evt: "bucket_erro", acao: "ler", nome, erro: String(e) }));
  }
  return null;
}
async function salvarLista(): Promise<void> {
  await guardar("canais.json", JSON.stringify({ atualizado: estado.atualizado, canais: estado.canais }), "application/json");
  await guardar("lista.m3u", textoM3U(), "audio/x-mpegurl");
}

// ---------- Lista automática: baixa, testa e guarda só o que funciona ----------
const FONTE_IPTV = Bun.env.FONTE_IPTV || "https://iptv-org.github.io/iptv/countries/br.m3u";
// Pluto TV Brasil (repositório OwnerPlugins/pluto-tv-m3u, refeito a cada 6 horas com os links do dia).
const FONTE_PLUTO = Bun.env.FONTE_PLUTO || "https://raw.githubusercontent.com/OwnerPlugins/pluto-tv-m3u/main/pluto-live-BR.m3u";
const SEIS_HORAS = 6 * 60 * 60 * 1000;

// ---------- Gerador próprio de links do Pluto TV ----------
// Mesmo método do projeto NasiLemakk/Pluto-TV-Playlists: o servidor pede uma sessão nova ao próprio
// Pluto (boot.pluto.tv) se apresentando como um aparelho no Brasil (cabeçalho X-Forwarded-For com um
// IP brasileiro) e monta os links com a chave fresquinha. Assim não dependemos só de listas de terceiros.
const IP_BR = Bun.env.PLUTO_IP_BR || "200.160.2.3";
const CLIENTE_PLUTO = crypto.randomUUID();
const UA_PLUTO = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Safari/605.1.15";
async function gerarPlutoBR(): Promise<string> {
  const h: Record<string, string> = { "x-forwarded-for": IP_BR, "user-agent": UA_PLUTO, accept: "application/json" };
  const hora = encodeURIComponent(new Date().toISOString());
  const boot = await (await fetch("https://boot.pluto.tv/v4/start?appName=web&appVersion=7.9.0-a9cca6b89aea4dc0998b92a51989d2adb9a9025d&deviceVersion=16.2.0&deviceModel=web&deviceMake=Chrome&deviceType=web&clientID=" + CLIENTE_PLUTO + "&clientModelNumber=1.0.0&channelID=5a4d3a00ad95e4718ae8d8db&serverSideAds=true&constraints=&drmCapabilities=&blockingMode=&clientTime=" + hora, { headers: h, signal: AbortSignal.timeout(20000) })).json() as any;
  if (!boot?.sessionToken || !boot?.servers?.stitcher) throw new Error("boot sem sessão");
  const auth = { ...h, authorization: "Bearer " + boot.sessionToken };
  const [canais, cats] = await Promise.all([
    fetch("https://service-channels.clusters.pluto.tv/v2/guide/channels?channelIds=&offset=0&limit=1000&sort=number%3Aasc", { headers: auth, signal: AbortSignal.timeout(20000) }).then((r) => r.json() as any),
    fetch("https://service-channels.clusters.pluto.tv/v2/guide/categories", { headers: auth, signal: AbortSignal.timeout(20000) }).then((r) => r.json() as any).catch(() => ({ data: [] })),
  ]);
  const nomeCat = new Map<string, string>(((cats?.data || []) as any[]).map((c) => [c.id, c.name]));
  const linhas = ["#EXTM3U"];
  for (const c of (canais?.data || []) as any[]) {
    if (!c?.id || !c?.stitched?.path) continue;
    const url = boot.servers.stitcher + "/v2" + c.stitched.path + "?" + boot.stitcherParams + "&jwt=" + boot.sessionToken + "&masterJWTPassthrough=true";
    const grupo = (c.categoryIDs && nomeCat.get(c.categoryIDs[0])) || "";
    const logo = (c.images && c.images[0] && c.images[0].url) || "";
    linhas.push('#EXTINF:-1 tvg-id="' + c.id + '" tvg-logo="' + logo + '" group-title="' + grupo.replace(/"/g, "'") + '",' + c.name, url);
  }
  const pais = (String(boot.stitcherParams || "").match(/country=([A-Z]+)/) || [])[1] || "?";
  console.log(JSON.stringify({ evt: "pluto_gerado", canais: (linhas.length - 1) / 2, pais }));
  return linhas.join("\n");
}
// Junta o gerador próprio com a lista do OwnerPlugins. Se um falhar, o outro segura.
async function textoPluto(): Promise<string> {
  const [gerado, owner] = await Promise.allSettled([
    gerarPlutoBR(),
    fetch(FONTE_PLUTO, { signal: AbortSignal.timeout(30000) }).then((r) => (r.ok ? r.text() : "")),
  ]);
  if (gerado.status === "rejected") console.log(JSON.stringify({ evt: "pluto_gerador_erro", erro: String(gerado.reason) }));
  return (gerado.status === "fulfilled" ? gerado.value : "") + "\n" + (owner.status === "fulfilled" ? owner.value : "");
}
const GRUPOS: Record<string, string> = {
  news: "Notícias", entertainment: "Entretenimento", kids: "Infantil", animation: "Infantil", sports: "Esportes",
  religious: "Religioso", music: "Música", movies: "Filmes", series: "Séries", education: "Educação", general: "Geral",
  shop: "Compras", documentary: "Documentários", business: "Negócios", culture: "Cultura", lifestyle: "Estilo de vida",
  legislative: "Governo", outdoor: "Campo e natureza", comedy: "Comédia", cooking: "Culinária", travel: "Viagem",
  auto: "Automóveis", classic: "Clássicos", family: "Família", undefined: "Geral", science: "Ciência", weather: "Clima",
  brazil: "TV aberta", brasil: "TV aberta",
};
// Recusas que podem ser só do servidor (fora do Brasil): o canal fica como reserva em vez de sair.
function talvezFunciona(chave: string, motivo: string): boolean {
  if (motivo === "HTTP 403") return true;
  return chave.startsWith("pluto:") && /HTTP 4(00|01|03|10|51)|variante HTTP 4|não é transmissão/.test(motivo);
}

type Fonte = { nome: string; logo: string; grupo: string; chave: string; url: string; ref: string; ua: string };
type Canal = { id: string; name: string; logo: string; group: string; url: string; ref: string; ua: string; alts: { url: string; ref: string; ua: string }[] };
const estado: { canais: Canal[]; atualizado: number; atualizando: boolean; ultimaTentativa: number; plutoTs: number; plutoRodando: boolean } = { canais: [], atualizado: 0, atualizando: false, ultimaTentativa: 0, plutoTs: 0, plutoRodando: false };

function grupoPt(g: string): string {
  const k = (g || "").split(";")[0].trim();
  return GRUPOS[k.toLowerCase()] || k || "Geral";
}
function limparNome(n: string): string {
  return n.replace(/[Ⓐ-ⓩ]/g, "").replace(/\s*\(\d+p\)/gi, "").replace(/\s*\[[^\]]*\]/g, "").trim() || n;
}
function chaveDe(tvgId: string, nome: string): string {
  if (tvgId) return tvgId.split("@")[0].toLowerCase();
  return limparNome(nome).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function lerM3U(texto: string): Fonte[] {
  const out: Fonte[] = [];
  let cur: Fonte | null = null;
  for (const bruto of texto.split(/\r?\n/)) {
    const l = bruto.trim();
    if (!l) continue;
    if (l.startsWith("#EXTINF")) {
      const at = (k: string) => (l.match(new RegExp(k + '="([^"]*)"', "i")) || [])[1] || "";
      const nome = l.slice(l.lastIndexOf(",") + 1).trim() || at("tvg-name") || "Sem nome";
      cur = { nome, logo: at("tvg-logo"), grupo: at("group-title"), chave: chaveDe(at("tvg-id"), nome), url: "", ref: at("http-referrer"), ua: at("http-user-agent") };
    } else if (cur && /^#EXTVLCOPT:http-referr?er=/i.test(l)) cur.ref = l.slice(l.indexOf("=") + 1).trim();
    else if (cur && /^#EXTVLCOPT:http-user-agent=/i.test(l)) cur.ua = l.slice(l.indexOf("=") + 1).trim();
    else if (!l.startsWith("#") && cur) { cur.url = l; out.push(cur); cur = null; }
  }
  return out;
}
async function emLotes<T, R>(itens: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(itens.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < itens.length) { const k = i++; out[k] = await f(itens[k]); } }));
  return out;
}

async function atualizar(): Promise<void> {
  if (estado.atualizando) return;
  estado.atualizando = true;
  estado.ultimaTentativa = Date.now();
  const inicio = Date.now();
  try {
    const [free, iptv, pluto] = await Promise.allSettled([
      freeTv().then((r) => (r.ok ? r.text() : "")),
      fetch(FONTE_IPTV, { signal: AbortSignal.timeout(30000) }).then((r) => (r.ok ? r.text() : "")),
      textoPluto(),
    ]);
    // Free-TV primeiro: são as emissoras abertas oficiais, entram no topo da numeração.
    const fontes = [
      ...lerM3U(free.status === "fulfilled" ? free.value : "").map((f) => ({ ...f, grupo: f.grupo || "TV aberta" })),
      ...lerM3U(iptv.status === "fulfilled" ? iptv.value : ""),
    ];
    // Pluto TV não passa pelo teste (o servidor fica fora do Brasil e sempre leva recusa).
    // Se a fonte do Pluto falhar, os canais Pluto que já estavam na lista continuam.
    const fontesPluto = plutoFontes(pluto.status === "fulfilled" ? pluto.value : "");
    const canaisPluto = fontesPluto.length ? montarPluto(fontesPluto) : estado.canais.filter((c) => c.id.startsWith("pluto:"));
    if (!fontes.length && !canaisPluto.length) throw new Error("listas vazias");
    const urls = [...new Set(fontes.map((f) => f.url))];
    const porUrl = new Map<string, Fonte>();
    for (const f of fontes) if (!porUrl.has(f.url)) porUrl.set(f.url, f);
    const resultados = await emLotes(urls, 24, async (u) => {
      const f = porUrl.get(u)!;
      return { u, r: await verificar(u, f.ref || null, f.ua || null) };
    });
    const status = new Map(resultados.map((x) => [x.u, x.r]));
    // Agrupa links do mesmo canal: o primeiro que funciona vira o principal, os outros viram reserva.
    const grupos = new Map<string, Fonte[]>();
    for (const f of fontes) { const g = grupos.get(f.chave) || []; if (!g.some((x) => x.url === f.url)) g.push(f); grupos.set(f.chave, g); }
    const canais: Canal[] = [];
    for (const [chave, lista] of grupos) {
      // 403 fica como reserva: pode ser bloqueio de região que só libera para quem está no Brasil.
      const bons = lista.filter((f) => status.get(f.url)?.ok);
      // Pluto TV: o link traz uma chave gerada para quem está no Brasil; o servidor (fora do Brasil)
      // recebe recusa de acesso, mas a TV na sua casa abre. Só descarta se o link sumiu de vez.
      const talvez = lista.filter((f) => talvezFunciona(chave, status.get(f.url)?.motivo || ""));
      const usar = [...bons, ...talvez];
      if (!usar.length) continue;
      const p = usar[0];
      canais.push({
        id: chave, name: limparNome(p.nome), logo: (lista.find((f) => f.logo) || p).logo, group: grupoPt(p.grupo),
        url: p.url, ref: p.ref, ua: p.ua, alts: usar.slice(1).map((f) => ({ url: f.url, ref: f.ref, ua: f.ua })),
      });
    }
    // Se o teste das outras fontes deu errado de vez (internet do servidor, por exemplo), mantém os canais antigos.
    const abertos = canais.length ? canais : estado.canais.filter((c) => !c.id.startsWith("pluto:"));
    const todos = [...abertos, ...canaisPluto];
    if (todos.length) { estado.canais = todos; estado.atualizado = Date.now(); estado.plutoTs = Date.now(); await salvarLista(); }
    console.log(JSON.stringify({ evt: "lista_atualizada", pluto: canaisPluto.length, plutoDaFonte: fontesPluto.length > 0, fontes: fontes.length, links: urls.length, canais: todos.length, ms: Date.now() - inicio }));
  } catch (e) {
    console.log(JSON.stringify({ evt: "lista_erro", erro: String(e), mantidos: estado.canais.length }));
  } finally {
    estado.atualizando = false;
  }
}

// ---------- Guardião do Pluto TV ----------
// Os links do Pluto trazem uma chave que vence em poucas horas. O guardião busca links novos
// a cada hora e nunca tira um canal Pluto da lista: se a fonte falhar, os canais de antes ficam.
// Cada canal ganha também um link reserva pelo jmp2.uk, que gera a sessão do Pluto na hora
// e não depende de chave nenhuma.
const PLUTO_ID = /^[0-9a-f]{24}$/;
const UMA_HORA = 60 * 60 * 1000;
function plutoFontes(texto: string): Fonte[] {
  const out: Fonte[] = [];
  for (const f of lerM3U(texto)) {
    const base = { ...f, chave: "pluto:" + f.chave, grupo: "Pluto TV" + (f.grupo ? " · " + f.grupo.split(";")[0].trim() : "") };
    // O link do jmp2.uk vem primeiro: ele foi conferido do servidor e responde "no ar".
    // O link com chave fica de reserva logo atrás.
    if (PLUTO_ID.test(f.chave)) out.push({ ...base, url: "https://jmp2.uk/plu-" + f.chave + ".m3u8", ref: "", ua: "" });
    out.push(base);
  }
  return out;
}
function montarPluto(fontes: Fonte[]): Canal[] {
  const grupos = new Map<string, Fonte[]>();
  for (const f of fontes) { const g = grupos.get(f.chave) || []; if (!g.some((x) => x.url === f.url)) g.push(f); grupos.set(f.chave, g); }
  const out: Canal[] = [];
  for (const [chave, lista] of grupos) {
    const p = lista[0];
    out.push({
      id: chave, name: limparNome(p.nome), logo: (lista.find((f) => f.logo) || p).logo, group: grupoPt(p.grupo),
      url: p.url, ref: p.ref, ua: p.ua, alts: lista.slice(1).map((f) => ({ url: f.url, ref: f.ref, ua: f.ua })),
    });
  }
  return out;
}
async function atualizarPluto(): Promise<void> {
  if (estado.atualizando || estado.plutoRodando) return;
  estado.plutoRodando = true;
  try {
    const fontes = plutoFontes(await textoPluto());
    if (!fontes.length) throw new Error("fonte sem canais");
    const novos = montarPluto(fontes);
    if (estado.atualizando) return; // a atualização completa já cuida do Pluto
    // Canais que saíram da fonte ficam por mais um tempo, com os links antigos, até a próxima rodada completa.
    const ids = new Set(novos.map((c) => c.id));
    const antigos = estado.canais.filter((c) => c.id.startsWith("pluto:") && !ids.has(c.id));
    estado.canais = [...estado.canais.filter((c) => !c.id.startsWith("pluto:")), ...novos, ...antigos];
    estado.plutoTs = Date.now();
    await salvarLista();
    // Amostra: confere 3 links reserva do jmp2.uk para saber se continuam respondendo.
    const amostra = novos.slice(0, 3).map((c) => [c, ...c.alts].find((a) => a.url.includes("jmp2.uk"))?.url).filter(Boolean) as string[];
    const testes = await Promise.all(amostra.map((u) => verificar(u, null, null)));
    console.log(JSON.stringify({ evt: "pluto_renovado", canais: novos.length, mantidos: antigos.length, reservaJmp2: testes.map((t) => t.motivo) }));
  } catch (e) {
    console.log(JSON.stringify({ evt: "pluto_erro", erro: String(e), mantidos: estado.canais.filter((c) => c.id.startsWith("pluto:")).length }));
  } finally {
    estado.plutoRodando = false;
  }
}

function canaisRota(q: URLSearchParams): Response {
  const velha = Date.now() - estado.atualizado > SEIS_HORAS;
  const forcar = q.get("forcar") === "1" && Date.now() - estado.ultimaTentativa > 10 * 60 * 1000;
  if ((velha || forcar) && !estado.atualizando) atualizar();
  return new Response(JSON.stringify({ atualizado: estado.atualizado, atualizando: estado.atualizando, total: estado.canais.length, canais: estado.canais }), {
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" },
  });
}

// A TV avisa quando um canal não abriu; o servidor reconfere os links dele na hora.
const reconferido = new Map<string, number>();
async function falhou(q: URLSearchParams): Promise<Response> {
  const id = q.get("id") || "";
  const resp = (removido: boolean) => new Response(JSON.stringify({ removido }), { headers: { ...CORS, "content-type": "application/json" } });
  const c = estado.canais.find((x) => x.id === id);
  if (!c || Date.now() - (reconferido.get(id) || 0) < 5 * 60 * 1000) return resp(false);
  reconferido.set(id, Date.now());
  // Pluto TV nunca sai da lista por falha: o servidor busca links novos do Pluto na hora.
  if (id.startsWith("pluto:")) {
    console.log(JSON.stringify({ evt: "falha_relatada", id, acao: "renovar pluto" }));
    if (Date.now() - estado.plutoTs > 10 * 60 * 1000) atualizarPluto();
    return resp(false);
  }
  const links = [{ url: c.url, ref: c.ref, ua: c.ua }, ...c.alts];
  const testes = await Promise.all(links.map(async (l) => ({ l, r: await verificar(l.url, l.ref || null, l.ua || null) })));
  const bons = testes.filter((t) => t.r.ok).map((t) => t.l).concat(testes.filter((t) => !t.r.ok && talvezFunciona(id, t.r.motivo)).map((t) => t.l));
  console.log(JSON.stringify({ evt: "falha_relatada", id, links: links.length, bons: bons.length, motivos: testes.map((t) => t.r.motivo) }));
  const j = estado.canais.findIndex((x) => x.id === id);
  if (j < 0) return resp(false);
  if (!bons.length) { estado.canais.splice(j, 1); await salvarLista(); return resp(true); }
  estado.canais[j] = { ...c, url: bons[0].url, ref: bons[0].ref, ua: bons[0].ua, alts: bons.slice(1) };
  return resp(false);
}

// Lista no formato M3U para o Kodi (PVR IPTV Simple Client) e outros players.
function textoM3U(): string {
  const q = (t: string) => t.replace(/"/g, "'");
  const linhas = ["#EXTM3U"];
  estado.canais.forEach((c, i) => {
    linhas.push('#EXTINF:-1 tvg-chno="' + (i + 1) + '" tvg-id="' + q(c.id) + '" tvg-logo="' + q(c.logo) + '" group-title="' + q(c.group) + '",' + c.name);
    if (c.ref) linhas.push("#EXTVLCOPT:http-referrer=" + c.ref);
    if (c.ua) linhas.push("#EXTVLCOPT:http-user-agent=" + c.ua);
    linhas.push(c.url);
  });
  return linhas.join("\n") + "\n";
}
function listaM3U(): Response {
  return new Response(textoM3U(), { headers: { ...CORS, "content-type": "audio/x-mpegurl; charset=utf-8", "cache-control": "no-cache" } });
}

Bun.serve({
  port: Number(Bun.env.PORT) || 3000,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { ...CORS, "access-control-allow-headers": "range, content-type", "access-control-allow-methods": "GET, OPTIONS" } });
    }
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/v") return new Response(String(Bun.hash(HTML)));
    if (url.pathname === "/p") return relay(req, url.searchParams);
    if (url.pathname === "/list") return lista(url.searchParams);
    if (url.pathname === "/freetv") return freeTv();
    if (url.pathname === "/lista.m3u") { if (Date.now() - estado.atualizado > SEIS_HORAS && !estado.atualizando) atualizar(); return listaM3U(); }
    if (url.pathname === "/canais") return canaisRota(url.searchParams);
    if (url.pathname === "/falhou") return falhou(url.searchParams);
    if (url.pathname === "/check") return testar(url.searchParams);
    if (url.pathname === "/diagnostico") return diagnostico(url.searchParams);
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  },
});
// Ao ligar: carrega a última lista guardada no bucket; só refaz os testes se ela tiver mais de 6 horas.
{
  await conectarBucket();
  const salvo = await ler("canais.json");
  if (salvo) {
    try {
      const j = JSON.parse(salvo);
      if (Array.isArray(j.canais) && j.canais.length) { estado.canais = j.canais; estado.atualizado = j.atualizado || 0; }
    } catch {}
  }
  console.log(JSON.stringify({ evt: "inicio", armazenamento: S3 ? "bucket" : TEM_S3 ? "bucket indisponível" : PASTA_LOCAL ? "pasta" : "nenhum", canaisCarregados: estado.canais.length }));
}
console.log("Tela Livre no ar");
if (Date.now() - estado.atualizado > SEIS_HORAS) atualizar();
// Confere a cada 30 minutos se a lista passou de 6 horas e, se passou, refaz os testes sozinho,
// mesmo que ninguém esteja assistindo.
setInterval(() => { if (Date.now() - estado.atualizado > SEIS_HORAS && !estado.atualizando) atualizar(); }, 30 * 60 * 1000);
// Guardião do Pluto: renova os links ao ligar (se a lista completa não estiver rodando) e depois a cada hora.
setTimeout(() => { if (!estado.atualizando) atualizarPluto(); }, 30 * 1000);
setInterval(() => { if (Date.now() - estado.plutoTs > UMA_HORA - 60 * 1000) atualizarPluto(); }, 15 * 60 * 1000);
