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
  let ultima: Response | null = null;
  for (let k = 0; k < tentativas; k++) {
    const i = (inicio + k) % PERFIS.length;
    const p = PERFIS[i];
    const r = await fetch(u.href, {
      headers: cabecalhos(ref || (p.refDoProprio ? u.origin + "/" : null), (i === 0 ? ua : null) || p.ua || null, range),
      redirect: "follow", signal: AbortSignal.timeout(ms),
    });
    if (r.status !== 403 && r.status !== 401) {
      if (i !== 0 || perfilPorHost.has(u.host)) perfilPorHost.set(u.host, i);
      return r;
    }
    r.body?.cancel();
    ultima = r;
  }
  return ultima!;
}

function cabecalhos(ref: string | null, ua: string | null, range?: string | null): Record<string, string> {
  const h: Record<string, string> = { "user-agent": ua || UA_PADRAO, accept: "*/*" };
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
    const texto = await res.text();
    if (texto.trimStart().startsWith("#EXTM3U")) {
      return new Response(reescrever(texto, res.url || u.href, ref, ua), {
        status: 200,
        headers: { ...CORS, "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-cache" },
      });
    }
    return new Response(texto, { status: res.status, headers: { ...CORS, "content-type": tipo || "text/plain" } });
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
const estado: { canais: Canal[]; atualizado: number; atualizando: boolean; ultimaTentativa: number } = { canais: [], atualizado: 0, atualizando: false, ultimaTentativa: 0 };

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
      fetch(FONTE_PLUTO, { signal: AbortSignal.timeout(30000) }).then((r) => (r.ok ? r.text() : "")),
    ]);
    // Free-TV primeiro: são as emissoras abertas oficiais, entram no topo da numeração.
    const fontes = [
      ...lerM3U(free.status === "fulfilled" ? free.value : "").map((f) => ({ ...f, grupo: f.grupo || "TV aberta" })),
      ...lerM3U(iptv.status === "fulfilled" ? iptv.value : ""),
      // Pluto TV por último; o grupo vira "Pluto TV · <categoria>" para ficar fácil de achar na TV.
      ...lerM3U(pluto.status === "fulfilled" ? pluto.value : "").map((f) => ({ ...f, chave: "pluto:" + f.chave, grupo: "Pluto TV" + (f.grupo ? " · " + f.grupo.split(";")[0].trim() : "") })),
    ];
    if (!fontes.length) throw new Error("listas vazias");
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
    if (canais.length) { estado.canais = canais; estado.atualizado = Date.now(); await salvarLista(); }
    const motivosPluto: Record<string, number> = {};
    for (const f of fontes) if (f.chave.startsWith("pluto:")) { const m = status.get(f.url)?.motivo || "?"; motivosPluto[m] = (motivosPluto[m] || 0) + 1; }
    console.log(JSON.stringify({ evt: "lista_atualizada", motivosPluto, pluto: canais.filter((c) => c.id.startsWith("pluto:")).length, fontes: fontes.length, links: urls.length, canais: canais.length, ms: Date.now() - inicio }));
  } catch (e) {
    console.log(JSON.stringify({ evt: "lista_erro", erro: String(e), mantidos: estado.canais.length }));
  } finally {
    estado.atualizando = false;
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
