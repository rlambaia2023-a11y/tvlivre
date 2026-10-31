// A pÃ¡gina da TV fica em index.html no repositÃ³rio tvlivre. O servidor carrega a pÃ¡gina ao ligar:
// 1) do arquivo ao lado (testes no computador); 2) do GitHub, presa ao commit TL_HTML_REF;
// 3) da Ãºltima cÃ³pia guardada no bucket, se o GitHub nÃ£o responder. Assim o cÃ³digo do Railway
// fica pequeno e a pÃ¡gina nÃ£o precisa vir embutida nele. Os mÃ³dulos da pasta extras/ seguem o mesmo caminho.
const HTML_REF = Bun.env.TL_HTML_REF || "1a0c8da6a98ab29f99b638775a7263d8a0dc01e6";
const HTML_URL = "https://raw.githubusercontent.com/rlambaia2023-a11y/tvlivre/" + HTML_REF + "/index.html";
const PAGINA_RESERVA = '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Tela Livre</title><body style="background:#0b0f14;color:#e9edf2;font:24px system-ui;display:grid;place-items:center;height:100vh;margin:0">Ligando a TVâ€¦ a pÃ¡gina abre sozinha em instantes.</body>';
let HTML = PAGINA_RESERVA;
// MÃ³dulos extras (pasta extras/ do repositÃ³rio): ficam fora da pÃ¡gina principal e entram nela na hora
// de entregar, logo depois do hls.js. VÃªm do mesmo commit da pÃ¡gina, com reserva no bucket.
const EXTRAS = ["controles.js", "minhalista.js"];
const extras: Record<string, string> = {};
async function baixarDoRepo(caminho: string): Promise<{ texto: string; origem: string } | null> {
  try {
    const local = Bun.file(new URL("./" + caminho, import.meta.url));
    if (await local.exists()) return { texto: await local.text(), origem: "arquivo" };
  } catch {}
  try {
    const r = await fetch("https://raw.githubusercontent.com/rlambaia2023-a11y/tvlivre/" + HTML_REF + "/" + caminho, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const texto = await r.text();
    await guardar(caminho, texto, caminho.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
    return { texto, origem: "github" };
  } catch (e) {
    const salvo = await ler(caminho);
    if (salvo) return { texto: salvo, origem: "bucket" };
    console.log(JSON.stringify({ evt: "arquivo_erro", caminho, erro: String(e) }));
    return null;
  }
}
function comExtras(pagina: string): string {
  const tags = Object.keys(extras).map((n) => '<script src="/extras/' + n + '?v=' + HTML_REF.slice(0, 7) + '"></script>').join("");
  if (!tags) return pagina;
  const marca = 'hls.min.js"></script>';
  return pagina.includes(marca) ? pagina.replace(marca, marca + tags) : pagina.replace("<script>", tags + "<script>");
}
async function carregarPagina(): Promise<void> {
  const pag = await baixarDoRepo("index.html");
  for (const n of EXTRAS) { const x = await baixarDoRepo("extras/" + n); if (x) extras[n] = x.texto; }
  if (pag && pag.texto.includes("<html")) {
    HTML = comExtras(pag.texto);
    console.log(JSON.stringify({ evt: "pagina", origem: pag.origem, ref: HTML_REF.slice(0, 7), bytes: pag.texto.length, extras: Object.keys(extras) }));
    return;
  }
  console.log(JSON.stringify({ evt: "pagina_erro" }));
  setTimeout(carregarPagina, 60 * 1000);
}

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

// Perfis usados quando a emissora responde 403/401: muitas sÃ³ aceitam players conhecidos (VLC, Kodi)
// ou o prÃ³prio site como origem. O servidor lembra qual perfil funcionou para cada emissora.
const PERFIS: { ua: string; refDoProprio: boolean }[] = [
  { ua: "", refDoProprio: false },
  { ua: "VLC/3.0.21 LibVLC/3.0.21", refDoProprio: false },
  { ua: "Kodi/21.3 (Windows NT 10.0; Win64; x64) App_Bitness/64 Version/21.3", refDoProprio: false },
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", refDoProprio: true },
];
const perfilPorHost = new Map<string, number>();

const prazos = new WeakMap<Response, ReturnType<typeof setTimeout>>();
function soltarPrazo(r: Response) { clearTimeout(prazos.get(r)); prazos.delete(r); }

async function buscar(u: URL, ref: string | null, ua: string | null, range: string | null, ms: number): Promise<Response> {
  // Pluto TV usa chave prÃ³pria no link; trocar o perfil nÃ£o muda nada, entÃ£o vai direto.
  const tentativas = /pluto\.tv$/i.test(u.hostname) ? 1 : PERFIS.length;
  const inicio = perfilPorHost.get(u.host) ?? 0;
  for (let k = 0; k < tentativas; k++) {
    const i = (inicio + k) % PERFIS.length;
    const p = PERFIS[i];
    // O prazo corre atÃ© o fim da leitura, como antes; o relay solta o prazo (soltarPrazo) quando
    // repassa o vÃ­deo direto, para transmissÃ£o contÃ­nua (TS/MP4) nÃ£o ser cortada no meio.
    const ctl = new AbortController();
    const prazo = setTimeout(() => ctl.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
    const r = await fetch(u.href, {
      headers: { ...cabecalhos(ref || (p.refDoProprio ? u.origin + "/" : null), (i === 0 ? ua : null) || p.ua || null, range), ...(/pluto\.tv$|plutotv\.net$|jmp2\.uk$/i.test(u.hostname) ? { "x-forwarded-for": IP_BR } : {}) },
      redirect: "follow", signal: ctl.signal,
    }).catch((e) => { clearTimeout(prazo); throw e; });
    prazos.set(r, prazo);
    if (r.status !== 403 && r.status !== 401) {
      if (i !== 0 || perfilPorHost.has(u.host)) perfilPorHost.set(u.host, i);
      return r;
    }
    // A Ãºltima resposta volta inteira para quem chamou; sÃ³ as anteriores sÃ£o descartadas.
    if (k === tentativas - 1) return r;
    r.body?.cancel();
  }
  throw new Error("sem tentativas");
}

function cabecalhos(ref: string | null, ua: string | null, range?: string | null): Record<string, string> {
  // identity: alguns servidores (Pluto, por exemplo) marcam a chave do vÃ­deo como gzip sem ela estar
  // comprimida, e a descompressÃ£o automÃ¡tica quebrava no meio da transmissÃ£o.
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

// Reescreve uma playlist HLS para que cada endereÃ§o passe pelo relay.
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
  if (!u) return new Response("EndereÃ§o invÃ¡lido", { status: 400, headers: CORS });
  const ref = q.get("r"), ua = q.get("a");
  let res: Response;
  try {
    res = await buscar(u, ref, ua, req.headers.get("range"), 20000);
  } catch (e) {
    console.log(JSON.stringify({ evt: "relay_erro", host: u.hostname, erro: String(e) }));
    return new Response("NÃ£o foi possÃ­vel alcanÃ§ar a transmissÃ£o", { status: 502, headers: CORS });
  }
  const tipo = res.headers.get("content-type") || "";
  if (res.ok && ehPlaylist(res.url || u.href, tipo)) {
    // LÃª como bytes: o Pluto manda a chave do vÃ­deo (16 bytes binÃ¡rios) marcada como playlist.
    // Ler isso como texto estragava a chave e o vÃ­deo nÃ£o abria.
    const bytes = new Uint8Array(await res.arrayBuffer());
    const comeco = new TextDecoder().decode(bytes.subarray(0, 32)).replace(/^\uFEFF/, "").trimStart();
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
  soltarPrazo(res);
  return new Response(res.body, { status: res.status, headers: h });
}

async function lista(q: URLSearchParams): Promise<Response> {
  const u = alvo(q.get("u"));
  if (!u) return new Response("EndereÃ§o invÃ¡lido", { status: 400, headers: CORS });
  try {
    const res = await fetch(u.href, { headers: cabecalhos(null, null), redirect: "follow", signal: AbortSignal.timeout(30000) });
    const texto = await res.text();
    return new Response(texto, { status: res.status, headers: { ...CORS, "content-type": "text/plain; charset=utf-8" } });
  } catch {
    return new Response("NÃ£o foi possÃ­vel baixar a lista", { status: 502, headers: CORS });
  }
}

// Free-TV: tenta o arquivo do Brasil; se nÃ£o existir, filtra a lista geral pelo grupo Brasil.
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
    return new Response("NÃ£o foi possÃ­vel baixar a lista do Free-TV", { status: 502, headers: CORS });
  }
}

// DiagnÃ³stico de um canal: segue a transmissÃ£o como o player faria (lista mestre, variante,
// chave e primeiro pedaÃ§o do vÃ­deo) e mostra o que cada etapa respondeu.
async function diagnostico(q: URLSearchParams): Promise<Response> {
  const etapas: Record<string, unknown>[] = [];
  const ref = q.get("r"), ua = q.get("a");
  async function passo(nome: string, url: string, range: string | null) {
    const u = alvo(url);
    if (!u) { etapas.push({ nome, url, erro: "endereÃ§o invÃ¡lido" }); return null; }
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

// Resultados de teste guardados por link, valendo para todas as TVs: um canal testado por qualquer
// aparelho (ou pela rodada automÃ¡tica do servidor) nÃ£o Ã© testado de novo por 6 horas.
// A memÃ³ria fica guardada no bucket (testes.json) e sobrevive a reinÃ­cios.
type Testado = { ok: boolean; motivo: string; ts: number };
const testados = new Map<string, Testado>();
let testadosMudou = false;
const chaveTeste = (u: string, ref?: string | null, ua?: string | null) => u + "|" + (ref || "") + "|" + (ua || "");
function lembrarTeste(u: string, ref: string | null, ua: string | null, r: { ok: boolean; motivo: string }) {
  const k = chaveTeste(u, ref, ua);
  testados.delete(k);
  testados.set(k, { ok: r.ok, motivo: r.motivo, ts: Date.now() });
  if (testados.size > 30000) testados.delete(testados.keys().next().value!);
  testadosMudou = true;
}
function testeGuardado(u: string, ref?: string | null, ua?: string | null): Testado | null {
  const t = testados.get(chaveTeste(u, ref, ua));
  return t && Date.now() - t.ts < SEIS_HORAS ? t : null;
}
async function salvarTestados(): Promise<void> {
  if (!testadosMudou) return;
  testadosMudou = false;
  const agora = Date.now();
  const vivos = [...testados].filter(([, t]) => agora - t.ts < SEIS_HORAS);
  await guardar("testes.json", JSON.stringify(vivos), "application/json");
}
async function carregarTestados(): Promise<void> {
  try {
    const l = JSON.parse((await ler("testes.json")) || "[]");
    if (Array.isArray(l)) for (const [k, t] of l) if (typeof k === "string" && t && typeof t.ts === "number") testados.set(k, t);
  } catch {}
}

async function testar(q: URLSearchParams): Promise<Response> {
  const u = q.get("u"), ref = q.get("r"), ua = q.get("a");
  const guardado = q.get("novo") === "1" ? null : testeGuardado(u || "", ref, ua);
  const r = guardado ? { ok: guardado.ok, motivo: guardado.motivo } : await verificar(u, ref, ua);
  if (!guardado) {
    if (alvo(u)) lembrarTeste(u!, ref, ua, r);
    console.log(JSON.stringify({ evt: "check", host: (alvo(u)?.hostname) || "?", ok: r.ok, motivo: r.motivo }));
  }
  return new Response(JSON.stringify(guardado ? { ...r, guardado: true, ts: guardado.ts } : r), { headers: { ...CORS, "content-type": "application/json" } });
}
// A TV manda os links da lista dela (atÃ© 5000 por vez) e recebe o resultado dos que jÃ¡ foram testados.
async function testadosRota(req: Request): Promise<Response> {
  const out: Record<string, { ok: boolean; ts: number }> = {};
  try {
    const l = req.method === "POST" ? await req.json() : [];
    if (Array.isArray(l)) for (const x of l.slice(0, 5000)) {
      const u = typeof x === "string" ? x : String(x?.u || "");
      const t = testeGuardado(u, typeof x === "string" ? "" : x?.r, typeof x === "string" ? "" : x?.a);
      if (t) out[u] = { ok: t.ok, ts: t.ts };
    }
  } catch {}
  return new Response(JSON.stringify({ testados: out }), { headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" } });
}

async function verificar(url: string | null, ref: string | null, ua: string | null): Promise<{ ok: boolean; motivo: string }> {
  const json = (ok: boolean, motivo: string) => ({ ok, motivo });
  const u = alvo(url);
  if (!u) return json(false, "endereÃ§o invÃ¡lido");
  try {
    const res = await buscar(u, ref, ua, "bytes=0-65535", 8000);
    if (!res.ok && res.status !== 206) { res.body?.cancel(); return json(false, "HTTP " + res.status); }
    const tipo = res.headers.get("content-type") || "";
    if (!ehPlaylist(res.url || u.href, tipo)) {
      res.body?.cancel();
      // PÃ¡gina de site (YouTube, portal da emissora) nÃ£o Ã© vÃ­deo que a TV consegue tocar.
      if (/text\/html|json/i.test(tipo) || /youtube\.com|youtu\.be/i.test(res.url || u.href)) return json(false, "pÃ¡gina, nÃ£o vÃ­deo");
      return json(true, "arquivo");
    }
    const texto = await res.text();
    if (!texto.trimStart().startsWith("#EXTM3U")) return json(false, "nÃ£o Ã© transmissÃ£o");
    // Se for playlist mestre, confere a primeira variante tambÃ©m.
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
    return json(false, String(e).includes("timeout") ? "sem resposta" : "erro de conexÃ£o");
  }
}

// ---------- Armazenamento no Railway Bucket ----------
// Guarda a Ãºltima lista testada. Quando o servidor reinicia, a TV jÃ¡ recebe os canais na hora,
// sem esperar a rodada de testes. Sem bucket configurado (ou se ele falhar), o servidor funciona como antes.
const TEM_S3 = !!(Bun.env.S3_BUCKET && Bun.env.S3_ACCESS_KEY_ID && Bun.env.S3_SECRET_ACCESS_KEY);
// O provedor do bucket aceita assinaturas em formatos diferentes; o servidor testa as combinaÃ§Ãµes
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
const PASTA_LOCAL = Bun.env.TL_STORE_DIR || ""; // sÃ³ para testes no computador

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
  await guardar("caidos.json", JSON.stringify(caidos), "application/json");
}

// ---------- Lista automÃ¡tica: baixa, testa e guarda sÃ³ o que funciona ----------
const FONTE_IPTV = Bun.env.FONTE_IPTV || "https://iptv-org.github.io/iptv/countries/br.m3u";
// Pluto TV Brasil (repositÃ³rio OwnerPlugins/pluto-tv-m3u, refeito a cada 6 horas com os links do dia).
const FONTE_PLUTO = Bun.env.FONTE_PLUTO || "https://raw.githubusercontent.com/OwnerPlugins/pluto-tv-m3u/main/pluto-live-BR.m3u";
// Segunda lista pronta do Pluto Brasil (BuddyChewChew/pluto, refeita a cada 6 horas), usada como reserva.
const FONTE_PLUTO2 = Bun.env.FONTE_PLUTO2 || "https://raw.githubusercontent.com/BuddyChewChew/pluto/main/pluto_br.m3u";
// Famelack (antigo TV.Garden): base pÃºblica em JSON, montada a partir do iptv-org e de outras transmissÃµes abertas.
const FONTE_FAMELACK = Bun.env.FONTE_FAMELACK || "https://raw.githubusercontent.com/famelack/famelack-data/main/tv/raw/countries/br.json";
// Canais em portuguÃªs de fora da lista do Brasil (iptv-org por idioma): Portugal, Ãfrica lusÃ³fona,
// regionais brasileiras e canais FAST gratuitos. SÃ³ entram os IDs desta lista, conferidos um a um;
// o resto da fonte fica de fora porque mistura retransmissÃµes de canais pagos.
const FONTE_PORTUGUES = Bun.env.FONTE_PORTUGUES || "https://iptv-org.github.io/iptv/languages/por.m3u";
const LUSOFONOS = new Set([
  "adbtv.pt", "artv.pt", "babyfirst.us", "blitstv.br", "catve2.br", "catvefm.br", "catvemastertv.br", "cindietv.br",
  "ebs.be", "ebsplus.be", "impdtvworldwide.br", "kktv.ao", "kuriakoscine.pt", "kuriakosmusic.pt", "kuriakostv.pt",
  "manaigrejaonline.pt", "muzangalatv.ao", "onfm.pt", "portocanal.pt", "reinoinfantil.mz", "rfptv.pt", "sbntvglobal.us",
  "tracetoca.fr", "traceurban.fr", "tvcidade.cv", "tvmana1.pt", "tvmana2.pt", "tvmanamocambique.mz", "tvshowfortaleza.br",
  "tvzimbo.ao", "xitenuevolatino.us", "xitesiemprelatino.us",
]);
// Canais que recusam conexÃµes de fora do Brasil (o servidor fica nos EUA), mas abrem na TV daqui:
// ficam na lista mesmo quando o teste do servidor dÃ¡ erro de conexÃ£o ou falta de resposta.
const SO_DO_BRASIL = new Set(["blitstv.br", "catve2.br", "catvefm.br", "catvemastertv.br"]);
const SEIS_HORAS = 6 * 60 * 60 * 1000;
// Doramas: canais FAST oficiais e gratuitos (Pluto TV AmÃ©rica Latina/Espanha e Samsung TV Plus),
// abertos pelo jmp2.uk. O Pluto Brasil nÃ£o tem canal de dorama, por isso eles vÃªm de outros paÃ­ses.
// Nada de sites piratas: sÃ³ canais que o prÃ³prio dono distribui de graÃ§a com anÃºncios.
const DORAMAS: { id: string; nome: string; links: string[] }[] = [
  { id: "dorama:dramascoreanos", nome: "Dramas Coreanos (Pluto TV)", links: ["https://jmp2.uk/plu-6185a9a88b2ce30007de5128.m3u8"] },
  { id: "dorama:dramascoreanosteen", nome: "Dramas Coreanos Teen (Pluto TV)", links: ["https://jmp2.uk/plu-6661d5424b10960008599fa3.m3u8"] },
  { id: "dorama:kdramaes", nome: "K-Drama (Pluto TV Espanha)", links: ["https://jmp2.uk/plu-6475bfec536e0c0008858e9f.m3u8"] },
  { id: "dorama:knovela", nome: "K-Novela en EspaÃ±ol", links: ["https://jmp2.uk/stvp-US1700019P7", "https://jmp2.uk/stvp-ES1700003C6"] },
  { id: "dorama:kstories", nome: "K-Stories (legendas em inglÃªs)", links: ["https://jmp2.uk/stvp-US17000164B"] },
  // Arirang TV: canal pÃºblico internacional da Coreia, em inglÃªs e gratuito (links da CDN da prÃ³pria emissora, via iptv-org).
  { id: "dorama:arirang", nome: "Arirang TV (Coreia, em inglÃªs)", links: [
    "https://amdlive-ch01-ctnd-com.akamaized.net/arirang_1ch/smil:arirang_1ch.smil/playlist.m3u8",
    "https://amdlive-ch02-ctnd-com.akamaized.net/arirang_1ch/smil:arirang_1ch.smil/playlist.m3u8",
    "https://amdlive-ch03-ctnd-com.akamaized.net/arirang_1ch/smil:arirang_1ch.smil/playlist.m3u8",
  ] },
];
function doramaFontes(): Fonte[] {
  return DORAMAS.flatMap((d) => d.links.map((url) => ({ nome: d.nome, logo: "", grupo: "Doramas", chave: d.id, url, ref: "", ua: "" })));
}

// ---------- Gerador prÃ³prio de links do Pluto TV ----------
// Mesmo mÃ©todo do projeto NasiLemakk/Pluto-TV-Playlists: o servidor pede uma sessÃ£o nova ao prÃ³prio
// Pluto (boot.pluto.tv) se apresentando como um aparelho no Brasil (cabeÃ§alho X-Forwarded-For com um
// IP brasileiro) e monta os links com a chave fresquinha. Assim nÃ£o dependemos sÃ³ de listas de terceiros.
const IP_BR = Bun.env.PLUTO_IP_BR || "200.160.2.3";
const CLIENTE_PLUTO = crypto.randomUUID();
const UA_PLUTO = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Safari/605.1.15";
const H_PLUTO: Record<string, string> = { "x-forwarded-for": IP_BR, "user-agent": UA_PLUTO, accept: "application/json" };
// A sessÃ£o do Pluto vale algumas horas; o gerador e o guia de programaÃ§Ã£o usam a mesma.
let sessaoPluto: { boot: any; ts: number } | null = null;
async function bootPluto(): Promise<any> {
  if (sessaoPluto && Date.now() - sessaoPluto.ts < 2 * 60 * 60 * 1000) return sessaoPluto.boot;
  const hora = encodeURIComponent(new Date().toISOString());
  const boot = await (await fetch("https://boot.pluto.tv/v4/start?appName=web&appVersion=7.9.0-a9cca6b89aea4dc0998b92a51989d2adb9a9025d&deviceVersion=16.2.0&deviceModel=web&deviceMake=Chrome&deviceType=web&clientID=" + CLIENTE_PLUTO + "&clientModelNumber=1.0.0&channelID=5a4d3a00ad95e4718ae8d8db&serverSideAds=true&constraints=&drmCapabilities=&blockingMode=&clientTime=" + hora, { headers: H_PLUTO, signal: AbortSignal.timeout(20000) })).json() as any;
  if (!boot?.sessionToken || !boot?.servers?.stitcher) throw new Error("boot sem sessÃ£o");
  sessaoPluto = { boot, ts: Date.now() };
  return boot;
}
async function gerarPlutoBR(): Promise<string> {
  sessaoPluto = null; // links novos pedem sessÃ£o nova
  const h = H_PLUTO;
  const boot = await bootPluto();
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
    // EndereÃ§o alternativo do Pluto (mÃ©todo do BuddyChewChew/pluto): sÃ³ IPv4 e qualidade fixa em 720p,
    // que trava menos em TV com internet mais fraca.
    const url720 = "https://ipv4.pluto.tv/api/tn/video/playout/v2/stitch/hls/channel/" + c.id + "/master.m3u8?" + boot.stitcherParams + "&jwt=" + boot.sessionToken + "&quality=720p&includeExtendedEvents=true&masterJWTPassthrough=true";
    const grupo = (c.categoryIDs && nomeCat.get(c.categoryIDs[0])) || "";
    const logo = (c.images && c.images[0] && c.images[0].url) || "";
    const inf = '#EXTINF:-1 tvg-id="' + c.id + '" tvg-logo="' + logo + '" group-title="' + grupo.replace(/"/g, "'") + '",' + c.name;
    linhas.push(inf, url, inf, url720);
  }
  const pais = (String(boot.stitcherParams || "").match(/country=([A-Z]+)/) || [])[1] || "?";
  console.log(JSON.stringify({ evt: "pluto_gerado", canais: (linhas.length - 1) / 4, pais }));
  return linhas.join("\n");
}
// Junta o gerador prÃ³prio com as listas do OwnerPlugins e do BuddyChewChew. Se uma falhar, as outras seguram.
async function textoPluto(): Promise<string> {
  const baixar = (u: string) => fetch(u, { signal: AbortSignal.timeout(30000) }).then((r) => (r.ok ? r.text() : ""));
  const [gerado, owner, buddy] = await Promise.allSettled([gerarPlutoBR(), baixar(FONTE_PLUTO), baixar(FONTE_PLUTO2)]);
  if (gerado.status === "rejected") console.log(JSON.stringify({ evt: "pluto_gerador_erro", erro: String(gerado.reason) }));
  const txt = (x: PromiseSettledResult<string>) => (x.status === "fulfilled" ? x.value : "");
  return txt(gerado) + "\n" + txt(owner) + "\n" + txt(buddy);
}
const GRUPOS: Record<string, string> = {
  news: "NotÃ­cias", entertainment: "Entretenimento", kids: "Infantil", animation: "Infantil", sports: "Esportes",
  religious: "Religioso", music: "MÃºsica", movies: "Filmes", series: "SÃ©ries", education: "EducaÃ§Ã£o", general: "Geral",
  shop: "Compras", documentary: "DocumentÃ¡rios", business: "NegÃ³cios", culture: "Cultura", lifestyle: "Estilo de vida",
  legislative: "Governo", outdoor: "Campo e natureza", comedy: "ComÃ©dia", cooking: "CulinÃ¡ria", travel: "Viagem",
  auto: "AutomÃ³veis", classic: "ClÃ¡ssicos", family: "FamÃ­lia", undefined: "Geral", science: "CiÃªncia", weather: "Clima",
  brazil: "TV aberta", brasil: "TV aberta",
};
// Recusas que podem ser sÃ³ do servidor (fora do Brasil): o canal fica como reserva em vez de sair.
function talvezFunciona(chave: string, motivo: string): boolean {
  if (motivo === "HTTP 403") return true;
  if (SO_DO_BRASIL.has(chave) && (motivo === "erro de conexÃ£o" || motivo === "sem resposta")) return true;
  return chave.startsWith("pluto:") && /HTTP 4(00|01|03|10|51)|variante HTTP 4|nÃ£o Ã© transmissÃ£o/.test(motivo);
}

type Fonte = { nome: string; logo: string; grupo: string; chave: string; url: string; ref: string; ua: string };
type Canal = { id: string; name: string; logo: string; group: string; url: string; ref: string; ua: string; alts: { url: string; ref: string; ua: string }[] };
const estado: { canais: Canal[]; atualizado: number; atualizando: boolean; ultimaTentativa: number; plutoTs: number; plutoRodando: boolean } = { canais: [], atualizado: 0, atualizando: false, ultimaTentativa: 0, plutoTs: 0, plutoRodando: false };
// Canais que caÃ­ram (nenhum link respondeu). A rotina de recuperaÃ§Ã£o reconfere de 20 em 20 minutos e
// devolve o canal Ã  lista assim que um link voltar; a lista fica guardada no bucket para sobreviver a reinÃ­cios.
let caidos: Canal[] = [];

function grupoPt(g: string): string {
  const k = (g || "").split(";")[0].trim();
  return GRUPOS[k.toLowerCase()] || k || "Geral";
}
function limparNome(n: string): string {
  return n.replace(/[\u24B6-\u24E9]/g, "").replace(/\s*\(\d+p\)/gi, "").replace(/\s*\[[^\]]*\]/g, "").trim() || n;
}
function chaveDe(tvgId: string, nome: string): string {
  if (tvgId) return tvgId.split("@")[0].toLowerCase();
  return limparNome(nome).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
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
// SÃ³ canais abertos e gratuitos: retransmissÃµes de canais de TV paga (links nÃ£o oficiais) ficam de fora.
// Os canais do Pluto (jmp2.uk / pluto.tv) sÃ£o gratuitos e nunca passam por este filtro.
const PAGOS = /\b(a&e|adult swim|amc|axn|arte 1|cartoon network|cinemax|combate|discovery|disney|espn|film ?& ?arts|fox|globonews|gloob|gnt|hbo|history|lifetime|megapix|multishow|music box brazil|national geographic|nat ?geo|nickelodeon|paramount|premiere|sony (channel|movies)|space|sportv|studio universal|syfy|telecine|tlc|tnt|travel box brazil|universal tv|canal viva|warner|woohoo|box kids)\b/i;
// A Globo sÃ³ transmite pela internet no Globoplay (a pÃ¡gina tem o cartÃ£o "Globo ao vivo"); os links
// "Rede Globo" / "TV Globo ..." das listas pÃºblicas sÃ£o retransmissÃµes nÃ£o oficiais que vivem caindo.
const GLOBO = /\b(rede globo|tv globo)\b/i;
function naoPago(f: Fonte): boolean {
  if (/jmp2\.uk|pluto\.tv/i.test(f.url)) return true;
  return !PAGOS.test(f.nome) && !GLOBO.test(f.nome);
}
// LÃª o JSON do Famelack e devolve sÃ³ os links de vÃ­deo direto (os de YouTube nÃ£o tocam no player).
async function famelack(): Promise<Fonte[]> {
  const r = await fetch(FONTE_FAMELACK, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("famelack HTTP " + r.status);
  const dados = await r.json();
  const out: Fonte[] = [];
  for (const c of Array.isArray(dados) ? dados : []) {
    const nome = typeof c?.name === "string" ? c.name.trim() : "";
    const links = Array.isArray(c?.sources?.streams) ? c.sources.streams : [];
    if (!nome) continue;
    for (const u of links) if (typeof u === "string" && /^https?:\/\//i.test(u) && !/youtube|youtu\.be/i.test(u)) out.push({ nome, logo: "", grupo: "", chave: chaveDe("", nome), url: u.trim(), ref: "", ua: "" });
  }
  return out;
}
// Famelack sÃ³ serve de reserva: o link entra apenas em canal que jÃ¡ veio das outras fontes (mesmo nome).
// Canal que sÃ³ existe no Famelack fica de fora, porque a origem de alguns links nÃ£o Ã© garantida.
function juntarPorNome(base: Fonte[], extras: Fonte[]): Fonte[] {
  const porNome = new Map<string, Fonte>();
  for (const f of base) { const k = chaveDe("", f.nome); if (!porNome.has(k)) porNome.set(k, f); }
  const out: Fonte[] = [];
  for (const f of extras) { const m = porNome.get(f.chave); if (m) out.push({ ...f, chave: m.chave, nome: m.nome, logo: m.logo, grupo: m.grupo }); }
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
    const [free, iptv, pluto, fame, por] = await Promise.allSettled([
      freeTv().then((r) => (r.ok ? r.text() : "")),
      fetch(FONTE_IPTV, { signal: AbortSignal.timeout(30000) }).then((r) => (r.ok ? r.text() : "")),
      textoPluto(),
      famelack(),
      fetch(FONTE_PORTUGUES, { signal: AbortSignal.timeout(30000) }).then((r) => (r.ok ? r.text() : "")),
    ]);
    if (fame.status === "rejected") console.log(JSON.stringify({ evt: "famelack_erro", erro: String(fame.reason) }));
    // Free-TV primeiro: sÃ£o as emissoras abertas oficiais, entram no topo da numeraÃ§Ã£o.
    const principais = [
      ...lerM3U(free.status === "fulfilled" ? free.value : "").map((f) => ({ ...f, grupo: f.grupo || "TV aberta" })),
      ...lerM3U(iptv.status === "fulfilled" ? iptv.value : ""),
      ...doramaFontes(),
      ...lerM3U(por.status === "fulfilled" ? por.value : "").filter((f) => LUSOFONOS.has(f.chave)),
    ];
    // Famelack por Ãºltimo: sÃ³ dÃ¡ links reserva aos canais que jÃ¡ existem, sem trazer canais novos.
    const fontes = [...principais, ...juntarPorNome(principais, fame.status === "fulfilled" ? fame.value : [])].filter(naoPago);
    // Pluto TV nÃ£o passa pelo teste (o servidor fica fora do Brasil e sempre leva recusa).
    // Se a fonte do Pluto falhar, os canais Pluto que jÃ¡ estavam na lista continuam.
    const fontesPluto = plutoFontes(pluto.status === "fulfilled" ? pluto.value : "");
    const canaisPluto = fontesPluto.length ? montarPluto(fontesPluto) : estado.canais.filter((c) => c.id.startsWith("pluto:"));
    if (!fontes.length && !canaisPluto.length) throw new Error("listas vazias");
    const urls = [...new Set(fontes.map((f) => f.url))];
    const porUrl = new Map<string, Fonte>();
    for (const f of fontes) if (!porUrl.has(f.url)) porUrl.set(f.url, f);
    const resultados = await emLotes(urls, 24, async (u) => {
      const f = porUrl.get(u)!;
      const r = await verificar(u, f.ref || null, f.ua || null);
      lembrarTeste(u, f.ref || null, f.ua || null, r);
      return { u, r };
    });
    const status = new Map(resultados.map((x) => [x.u, x.r]));
    // Agrupa links do mesmo canal: o primeiro que funciona vira o principal, os outros viram reserva.
    const grupos = new Map<string, Fonte[]>();
    for (const f of fontes) { const g = grupos.get(f.chave) || []; if (!g.some((x) => x.url === f.url)) g.push(f); grupos.set(f.chave, g); }
    const canais: Canal[] = [];
    const novosCaidos: Canal[] = [];
    for (const [chave, lista] of grupos) {
      // 403 fica como reserva: pode ser bloqueio de regiÃ£o que sÃ³ libera para quem estÃ¡ no Brasil.
      const bons = lista.filter((f) => status.get(f.url)?.ok);
      // Pluto TV: o link traz uma chave gerada para quem estÃ¡ no Brasil; o servidor (fora do Brasil)
      // recebe recusa de acesso, mas a TV na sua casa abre. SÃ³ descarta se o link sumiu de vez.
      const talvez = lista.filter((f) => talvezFunciona(chave, status.get(f.url)?.motivo || ""));
      const usar = [...bons, ...talvez];
      if (!usar.length) {
        // Nenhum link respondeu agora: o canal vai para a lista de caÃ­dos e volta quando a recuperaÃ§Ã£o o achar no ar.
        const q = lista[0];
        novosCaidos.push({
          id: chave, name: limparNome(q.nome), logo: (lista.find((f) => f.logo) || q).logo, group: grupoPt(q.grupo),
          url: q.url, ref: q.ref, ua: q.ua, alts: lista.slice(1).map((f) => ({ url: f.url, ref: f.ref, ua: f.ua })),
        });
        continue;
      }
      const p = usar[0];
      canais.push({
        id: chave, name: limparNome(p.nome), logo: (lista.find((f) => f.logo) || p).logo, group: grupoPt(p.grupo),
        url: p.url, ref: p.ref, ua: p.ua, alts: usar.slice(1).map((f) => ({ url: f.url, ref: f.ref, ua: f.ua })),
      });
    }
    // Se o teste das outras fontes deu errado de vez (internet do servidor, por exemplo), mantÃ©m os canais antigos.
    const abertos = canais.length ? canais : estado.canais.filter((c) => !c.id.startsWith("pluto:"));
    const todos = [...abertos, ...canaisPluto];
    if (canais.length) caidos = novosCaidos;
    if (todos.length) { estado.canais = todos; estado.atualizado = Date.now(); estado.plutoTs = Date.now(); await salvarLista(); }
    console.log(JSON.stringify({ evt: "lista_atualizada", pluto: canaisPluto.length, plutoDaFonte: fontesPluto.length > 0, fontes: fontes.length, famelack: fame.status === "fulfilled" ? fame.value.length : 0, links: urls.length, canais: todos.length, ms: Date.now() - inicio }));
  } catch (e) {
    console.log(JSON.stringify({ evt: "lista_erro", erro: String(e), mantidos: estado.canais.length }));
  } finally {
    estado.atualizando = false;
  }
}

// ---------- GuardiÃ£o do Pluto TV ----------
// Os links do Pluto trazem uma chave que vence em poucas horas. O guardiÃ£o busca links novos
// a cada hora e nunca tira um canal Pluto da lista: se a fonte falhar, os canais de antes ficam.
// Cada canal ganha tambÃ©m um link reserva pelo jmp2.uk, que gera a sessÃ£o do Pluto na hora
// e nÃ£o depende de chave nenhuma.
const PLUTO_ID = /^[0-9a-f]{24}$/;
const UMA_HORA = 60 * 60 * 1000;
function plutoFontes(texto: string): Fonte[] {
  const out: Fonte[] = [];
  for (const f of lerM3U(texto)) {
    const base = { ...f, chave: "pluto:" + f.chave, grupo: "Pluto TV" + (f.grupo ? " Â· " + f.grupo.split(";")[0].trim() : "") };
    // O link do jmp2.uk vem primeiro: ele foi conferido do servidor e responde "no ar".
    // O link com chave fica de reserva logo atrÃ¡s.
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
    if (estado.atualizando) return; // a atualizaÃ§Ã£o completa jÃ¡ cuida do Pluto
    // Canais que saÃ­ram da fonte ficam por mais um tempo, com os links antigos, atÃ© a prÃ³xima rodada completa.
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

// Amostra de 4 MB de bytes aleatÃ³rios para o teste de internet da TV (aleatÃ³rios para nÃ£o serem comprimidos no caminho).
const AMOSTRA = new Uint8Array(4 * 1024 * 1024);
for (let i = 0; i < AMOSTRA.length; i += 65536) crypto.getRandomValues(AMOSTRA.subarray(i, i + 65536));

// ---------- Guia de programaÃ§Ã£o (Agora / A seguir) do Pluto TV ----------
// Usa a mesma sessÃ£o do gerador e pede ao Pluto a grade das prÃ³ximas 4 horas, em lotes de canais.
// A TV recebe sÃ³ o essencial: tÃ­tulo, inÃ­cio e fim de atÃ© 3 programas por canal.
type Programa = { t: string; s: number; e: number; d?: string };
const guia: { porCanal: Record<string, Programa[]>; ts: number; rodando: boolean } = { porCanal: {}, ts: 0, rodando: false };
async function atualizarGuia(): Promise<void> {
  if (guia.rodando) return;
  guia.rodando = true;
  const inicio = Date.now();
  try {
    const ids = estado.canais.filter((c) => c.id.startsWith("pluto:")).map((c) => c.id.slice(6)).filter((x) => PLUTO_ID.test(x));
    if (!ids.length) throw new Error("sem canais Pluto");
    const boot = await bootPluto();
    const auth = { ...H_PLUTO, authorization: "Bearer " + boot.sessionToken };
    const agora = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const lotes: string[][] = [];
    for (let i = 0; i < ids.length; i += 80) lotes.push(ids.slice(i, i + 80));
    const novo: Record<string, Programa[]> = {};
    let erros = 0;
    await emLotes(lotes, 3, async (lote) => {
      try {
        const r = await fetch("https://service-channels.clusters.pluto.tv/v2/guide/timelines?start=" + encodeURIComponent(agora) + "&channelIds=" + lote.join(",") + "&duration=300", { headers: auth, signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json() as any;
        for (const c of (j?.data || []) as any[]) {
          const progs: Programa[] = [];
          for (const t of (c?.timelines || []) as any[]) {
            const s = Date.parse(t.start), e = Date.parse(t.stop);
            if (!s || !e) continue;
            const serie = t.episode?.series?.name, ep = t.episode?.name;
            const titulo = String(t.title || serie || ep || "").trim();
            if (!titulo) continue;
            const d = String(t.episode?.description || "").trim().slice(0, 220);
            progs.push(d ? { t: titulo, s, e, d } : { t: titulo, s, e });
          }
          if (progs.length) novo["pluto:" + String(c.channelId).toLowerCase()] = progs.sort((a, b) => a.s - b.s);
        }
      } catch (e) { erros++; console.log(JSON.stringify({ evt: "guia_lote_erro", erro: String(e) })); }
    });
    if (Object.keys(novo).length) { guia.porCanal = novo; guia.ts = Date.now(); }
    console.log(JSON.stringify({ evt: "guia_atualizado", canais: Object.keys(novo).length, lotes: lotes.length, erros, ms: Date.now() - inicio }));
  } catch (e) {
    console.log(JSON.stringify({ evt: "guia_erro", erro: String(e) }));
  } finally {
    guia.rodando = false;
  }
}
function guiaRota(): Response {
  if (Date.now() - guia.ts > 30 * 60 * 1000 && !guia.rodando) atualizarGuia();
  const agora = Date.now();
  const out: Record<string, Programa[]> = {};
  for (const [id, progs] of Object.entries(guia.porCanal)) {
    const vivos = progs.filter((p) => p.e > agora).slice(0, 3);
    if (vivos.length) out[id] = vivos;
  }
  return new Response(JSON.stringify({ atualizado: guia.ts, guia: out }), {
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" },
  });
}

// ---------- Filmes e sÃ©ries do Pluto TV (sob demanda, grÃ¡tis) ----------
// CatÃ¡logo oficial do Pluto Brasil, pedido com a mesma sessÃ£o do gerador. A TV recebe um resumo
// (tipo, nome, sinopse curta, duraÃ§Ã£o) e abre o vÃ­deo pelo /vod/hls: o servidor busca sÃ³ as playlists,
// que o Pluto nÃ£o libera para outros sites, e os pedaÃ§os de vÃ­deo vÃ£o direto do Pluto para a TV.
const vod: { json: string; ts: number; rodando: Promise<void> | null } = { json: "", ts: 0, rodando: null };
const temporadas = new Map<string, { json: string; ts: number }>();
const JSON_H = { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" };
async function authPluto(): Promise<{ boot: any; auth: Record<string, string> }> {
  const boot = await bootPluto();
  return { boot, auth: { ...H_PLUTO, authorization: "Bearer " + boot.sessionToken } };
}
async function atualizarVod(): Promise<void> {
  const inicio = Date.now();
  try {
    const { auth } = await authPluto();
    const r = await fetch("https://service-vod.clusters.pluto.tv/v4/vod/categories?includeItems=true&offset=1000&page=1", { headers: auth, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json() as any;
    const itens: Record<string, (string | number)[]> = {};
    const cats: { n: string; i: string[] }[] = [];
    for (const c of (j?.categories || []) as any[]) {
      const ids: string[] = [];
      for (const it of (c?.items || []) as any[]) {
        const id = String(it?._id || it?.id || "");
        if (!PLUTO_ID.test(id) || (it.type !== "movie" && it.type !== "series")) continue;
        if (!itens[id]) itens[id] = [it.type === "series" ? "s" : "f", String(it.name || "").trim(), String(it.summary || it.description || "").trim().slice(0, 240), it.type === "movie" ? Math.round((it.duration || 0) / 60000) : 0, String(it.rating || ""), String(it.genre || "")];
        ids.push(id);
      }
      if (ids.length) cats.push({ n: String(c.name || "").trim(), i: ids });
    }
    if (!cats.length) throw new Error("catÃ¡logo vazio");
    vod.json = JSON.stringify({ atualizado: Date.now(), cats, itens });
    vod.ts = Date.now();
    console.log(JSON.stringify({ evt: "vod_atualizado", categorias: cats.length, titulos: Object.keys(itens).length, bytes: vod.json.length, ms: Date.now() - inicio }));
  } catch (e) {
    console.log(JSON.stringify({ evt: "vod_erro", erro: String(e) }));
  }
}
async function vodRota(req: Request): Promise<Response> {
  if (Date.now() - vod.ts > SEIS_HORAS && !vod.rodando) vod.rodando = atualizarVod().finally(() => { vod.rodando = null; });
  if (!vod.json && vod.rodando) await vod.rodando;
  if (!vod.json) return new Response(JSON.stringify({ erro: "catÃ¡logo indisponÃ­vel" }), { status: 503, headers: JSON_H });
  // O catÃ¡logo tem quase 1 MB; compactado chega Ã  TV com um quarto disso.
  if (/gzip/.test(req.headers.get("accept-encoding") || "")) return new Response(Bun.gzipSync(vod.json), { headers: { ...JSON_H, "content-encoding": "gzip" } });
  return new Response(vod.json, { headers: JSON_H });
}
async function serieRota(q: URLSearchParams): Promise<Response> {
  const id = String(q.get("id") || "").toLowerCase();
  if (!PLUTO_ID.test(id)) return new Response(JSON.stringify({ erro: "id invÃ¡lido" }), { status: 400, headers: JSON_H });
  const salvo = temporadas.get(id);
  if (salvo && Date.now() - salvo.ts < SEIS_HORAS) return new Response(salvo.json, { headers: JSON_H });
  try {
    const { auth } = await authPluto();
    const r = await fetch("https://service-vod.clusters.pluto.tv/v4/vod/series/" + id + "/seasons?offset=1000&page=1", { headers: auth, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json() as any;
    const temps = ((j?.seasons || []) as any[]).map((t) => ({
      n: Number(t.number) || 0,
      eps: ((t.episodes || []) as any[]).filter((e) => PLUTO_ID.test(String(e?._id || ""))).map((e) => [String(e._id), Number(e.number) || 0, String(e.name || "").trim(), Math.round((e.duration || 0) / 60000), String(e.description || "").trim().slice(0, 200)]),
    })).filter((t) => t.eps.length).sort((a, b) => a.n - b.n);
    const json = JSON.stringify({ id, nome: String(j?.name || ""), sinopse: String(j?.summary || j?.description || "").slice(0, 300), temporadas: temps });
    if (temporadas.size > 300) temporadas.clear();
    temporadas.set(id, { json, ts: Date.now() });
    return new Response(json, { headers: JSON_H });
  } catch (e) {
    console.log(JSON.stringify({ evt: "vod_serie_erro", id, erro: String(e) }));
    return new Response(JSON.stringify({ erro: "nÃ£o consegui abrir esta sÃ©rie agora" }), { status: 502, headers: JSON_H });
  }
}
// Link do filme ou episÃ³dio com a sessÃ£o do momento; o endereÃ§o "dash" do Pluto fica de reserva.
async function playVodRota(q: URLSearchParams): Promise<Response> {
  const id = String(q.get("id") || "").toLowerCase();
  if (!PLUTO_ID.test(id)) return new Response(JSON.stringify({ erro: "id invÃ¡lido" }), { status: 400, headers: JSON_H });
  try {
    const { boot } = await authPluto();
    const fim = "/v2/stitch/hls/episode/" + id + "/master.m3u8?" + boot.stitcherParams + "&jwt=" + boot.sessionToken + "&masterJWTPassthrough=true";
    const hosts = [boot.servers?.stitcher, boot.servers?.stitcherDash, "https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv"].filter((h, i, l) => h && l.indexOf(h) === i);
    return new Response(JSON.stringify({ url: hosts[0] + fim, alts: hosts.slice(1).map((h) => h + fim) }), { headers: JSON_H });
  } catch (e) {
    console.log(JSON.stringify({ evt: "vod_play_erro", id, erro: String(e) }));
    return new Response(JSON.stringify({ erro: "Pluto TV nÃ£o respondeu" }), { status: 502, headers: JSON_H });
  }
}
// Playlists do Pluto: sÃ³ endereÃ§os *.pluto.tv. Playlists filhas continuam passando por aqui;
// chaves e pedaÃ§os de vÃ­deo (plutotv.net, liberados para qualquer site) ficam com o endereÃ§o direto.
async function vodHls(req: Request, q: URLSearchParams): Promise<Response> {
  const u = alvo(q.get("u"));
  if (!u || u.protocol !== "https:" || !/\.pluto\.tv$/i.test(u.hostname)) return new Response("EndereÃ§o invÃ¡lido", { status: 400, headers: CORS });
  try {
    const r = await fetch(u, { headers: { "x-forwarded-for": IP_BR, "user-agent": UA_PLUTO }, signal: AbortSignal.timeout(20000) });
    const texto = await r.text();
    if (!r.ok || !texto.trimStart().startsWith("#EXTM3U")) return new Response("Pluto TV recusou (HTTP " + r.status + ")", { status: r.ok ? 502 : r.status, headers: CORS });
    const base = r.url || u.href;
    const troca = (x: string): string => {
      try {
        const a = new URL(x, base);
        return /\.m3u8$/i.test(a.pathname) ? "/vod/hls?u=" + encodeURIComponent(a.href) : a.href;
      } catch { return x; }
    };
    const saida = texto.split(/\r?\n/).map((linha) => {
      const l = linha.trim();
      if (!l) return linha;
      if (l.startsWith("#")) return linha.replace(/URI="([^"]+)"/g, (_m, uri) => 'URI="' + troca(uri) + '"');
      return troca(l);
    }).join("\n");
    const h: Record<string, string> = { ...CORS, "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-cache" };
    if (/gzip/.test(req.headers.get("accept-encoding") || "")) return new Response(Bun.gzipSync(saida), { headers: { ...h, "content-encoding": "gzip" } });
    return new Response(saida, { headers: h });
  } catch (e) {
    console.log(JSON.stringify({ evt: "vod_hls_erro", host: u.hostname, erro: String(e) }));
    return new Response("NÃ£o foi possÃ­vel alcanÃ§ar o Pluto TV", { status: 502, headers: CORS });
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

// A TV avisa quando um canal nÃ£o abriu; o servidor reconfere os links dele na hora.
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
  if (!bons.length) { estado.canais.splice(j, 1); caidos = [...caidos.filter((x) => x.id !== id), c]; await salvarLista(); return resp(true); }
  estado.canais[j] = { ...c, url: bons[0].url, ref: bons[0].ref, ua: bons[0].ua, alts: bons.slice(1) };
  return resp(false);
}

// Rotina de recuperaÃ§Ã£o: reconfere os canais caÃ­dos e devolve Ã  lista os que voltaram a responder,
// sem esperar a prÃ³xima atualizaÃ§Ã£o completa (que roda de 6 em 6 horas).
let recuperando = false;
async function recuperar(): Promise<void> {
  if (recuperando || estado.atualizando || !caidos.length) return;
  recuperando = true;
  const inicio = Date.now();
  try {
    const voltaram: Canal[] = [];
    await emLotes(caidos, 12, async (c) => {
      const links = [{ url: c.url, ref: c.ref, ua: c.ua }, ...c.alts];
      for (let i = 0; i < links.length; i++) {
        const r = await verificar(links[i].url, links[i].ref || null, links[i].ua || null);
        if (r.ok || talvezFunciona(c.id, r.motivo)) {
          voltaram.push({ ...c, url: links[i].url, ref: links[i].ref, ua: links[i].ua, alts: links.filter((_, k) => k !== i) });
          return;
        }
      }
    });
    // Se a atualizaÃ§Ã£o completa comeÃ§ou no meio do caminho, ela mesma cuida da lista.
    if (estado.atualizando || !voltaram.length) return;
    const ids = new Set(voltaram.map((c) => c.id));
    caidos = caidos.filter((c) => !ids.has(c.id));
    const jaTem = new Set(estado.canais.map((c) => c.id));
    const novos = voltaram.filter((c) => !jaTem.has(c.id));
    // Volta junto dos canais abertos, antes dos canais do Pluto.
    const pos = estado.canais.findIndex((c) => c.id.startsWith("pluto:"));
    estado.canais.splice(pos < 0 ? estado.canais.length : pos, 0, ...novos);
    await salvarLista();
    console.log(JSON.stringify({ evt: "canais_voltaram", canais: novos.map((c) => c.name), restantes: caidos.length, ms: Date.now() - inicio }));
  } catch (e) {
    console.log(JSON.stringify({ evt: "recuperar_erro", erro: String(e) }));
  } finally {
    recuperando = false;
  }
}

// EstatÃ­sticas de uso: quantos aparelhos abriram a TV e quais canais foram assistidos, por dia
// (horÃ¡rio de BrasÃ­lia). Cada aparelho manda sÃ³ um cÃ³digo aleatÃ³rio criado pela prÃ³pria pÃ¡gina;
// o IP de quem baixa a lista do Kodi vira um resumo (hash) com sal do dia e nunca Ã© guardado nem
// mostrado. No fim do dia o resumo sai no log `relatorio_diario` e fica no bucket.
type CanalVisto = { n: string; k: string; vezes: number; ap: string[] };
type Estat = { dia: string; aparelhos: string[]; canais: Record<string, CanalVisto>; kodi: string[]; aberturas: number };
const diaBR = (t = Date.now()) => new Date(t - 3 * 3600 * 1000).toISOString().slice(0, 10);
const estatVazia = (dia = diaBR()): Estat => ({ dia, aparelhos: [], canais: {}, kodi: [], aberturas: 0 });
let estat: Estat = estatVazia();
let estatMudou = false;
function resumoEstat(e: Estat) {
  const canais = Object.entries(e.canais)
    .map(([id, c]) => ({ id, nome: c.n, tipo: c.k, vezes: c.vezes, aparelhos: c.ap.length }))
    .sort((a, b) => b.aparelhos - a.aparelhos || b.vezes - a.vezes);
  return { dia: e.dia, aparelhos: e.aparelhos.length, aberturas: e.aberturas, kodi: e.kodi.length, canaisDiferentes: canais.length, assistidos: canais.reduce((s, c) => s + c.vezes, 0), canais };
}
async function fecharDia(): Promise<void> {
  const velho = estat;
  estat = estatVazia();
  estatMudou = true;
  const r = resumoEstat(velho);
  console.log(JSON.stringify({ evt: "relatorio_diario", ...r, canais: r.canais.slice(0, 40).map((c) => c.nome + " | " + c.aparelhos + " aparelho(s) | " + c.vezes + "x") }));
  await guardar("relatorio-" + velho.dia + ".json", JSON.stringify(r), "application/json");
  await guardar("estatisticas.json", JSON.stringify(estat), "application/json");
}
let ultimaParcial = 0;
async function conferirDia(): Promise<void> {
  if (estat.dia !== diaBR()) await fecharDia();
  // Uma vez por hora deixa no log a contagem parcial do dia (serve para relatÃ³rios de teste).
  if (Date.now() - ultimaParcial > UMA_HORA - 5 * 60 * 1000) {
    ultimaParcial = Date.now();
    const r = resumoEstat(estat);
    console.log(JSON.stringify({ evt: "relatorio_parcial", ...r, canais: r.canais.slice(0, 40).map((c) => c.nome + " | " + c.aparelhos + " aparelho(s) | " + c.vezes + "x") }));
  }
  if (estatMudou) { estatMudou = false; await guardar("estatisticas.json", JSON.stringify(estat), "application/json"); }
}
function contar(q: URLSearchParams): Response {
  if (estat.dia !== diaBR()) conferirDia();
  const d = (q.get("d") || "").replace(/[^a-z0-9]/gi, "").slice(0, 32);
  if (d.length >= 8) {
    if (!estat.aparelhos.includes(d) && estat.aparelhos.length < 20000) estat.aparelhos.push(d);
    const id = (q.get("id") || "").slice(0, 120);
    if (id) {
      let c = estat.canais[id];
      if (!c && Object.keys(estat.canais).length < 3000) c = estat.canais[id] = { n: (q.get("n") || id).slice(0, 80), k: (q.get("k") || "live").replace(/[^a-z]/g, "").slice(0, 10), vezes: 0, ap: [] };
      if (c) { c.vezes++; if (!c.ap.includes(d) && c.ap.length < 20000) c.ap.push(d); }
    } else if (q.get("abriu")) estat.aberturas++;
    estatMudou = true;
  }
  return new Response(null, { status: 204, headers: { ...CORS, "cache-control": "no-store" } });
}
function contarKodi(req: Request): void {
  const ip = (req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  if (!ip || /^(curl|wget|python|go-http|bun)/i.test(req.headers.get("user-agent") || "")) return;
  const h = Bun.hash(ip + "|" + estat.dia + "|tela-livre").toString(36);
  if (!estat.kodi.includes(h) && estat.kodi.length < 20000) { estat.kodi.push(h); estatMudou = true; }
}
async function relatorioRota(q: URLSearchParams): Promise<Response> {
  const dia = (q.get("dia") || "").replace(/[^0-9-]/g, "");
  let corpo: string;
  if (!dia || dia === estat.dia) corpo = JSON.stringify({ parcial: true, ...resumoEstat(estat) });
  else corpo = (await ler("relatorio-" + dia + ".json")) || JSON.stringify({ dia, erro: "sem relatÃ³rio para esse dia" });
  return new Response(corpo, { headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
async function carregarEstat(): Promise<void> {
  const salvo = await ler("estatisticas.json");
  if (!salvo) return;
  try { const j = JSON.parse(salvo); if (j && j.dia && Array.isArray(j.aparelhos) && j.canais) estat = { kodi: [], aberturas: 0, ...j }; } catch {}
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
      return new Response(null, { headers: { ...CORS, "access-control-allow-headers": "range, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" } });
    }
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/v") return new Response(String(Bun.hash(HTML)));
    if (url.pathname.startsWith("/extras/")) { const n = url.pathname.slice(8); if (extras[n]) return new Response(extras[n], { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=3600" } }); }
    if (url.pathname === "/p") return relay(req, url.searchParams);
    if (url.pathname === "/list") return lista(url.searchParams);
    if (url.pathname === "/freetv") return freeTv();
    if (url.pathname === "/contar") return contar(url.searchParams);
    if (url.pathname === "/relatorio") return relatorioRota(url.searchParams);
    if (url.pathname === "/lista.m3u") { contarKodi(req); if (Date.now() - estado.atualizado > SEIS_HORAS && !estado.atualizando) atualizar(); return listaM3U(); }
    if (url.pathname === "/canais") return canaisRota(url.searchParams);
    if (url.pathname === "/falhou") return falhou(url.searchParams);
    if (url.pathname === "/epg") return guiaRota();
    if (url.pathname === "/vod") return vodRota(req);
    if (url.pathname === "/vod/serie") return serieRota(url.searchParams);
    if (url.pathname === "/vod/play") return playVodRota(url.searchParams);
    if (url.pathname === "/vod/hls") return vodHls(req, url.searchParams);
    if (url.pathname === "/velocidade") return new Response(AMOSTRA, { headers: { ...CORS, "content-type": "application/octet-stream", "cache-control": "no-store", "content-length": String(AMOSTRA.length) } });
    if (url.pathname === "/check") return testar(url.searchParams);
    if (url.pathname === "/testados") return testadosRota(req);
    if (url.pathname === "/diagnostico") return diagnostico(url.searchParams);
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  },
});
// Ao ligar: carrega a Ãºltima lista guardada no bucket; sÃ³ refaz os testes se ela tiver mais de 6 horas.
{
  await conectarBucket();
  await carregarPagina();
  await carregarEstat();
  await carregarTestados();
  const salvo = await ler("canais.json");
  if (salvo) {
    try {
      const j = JSON.parse(salvo);
      if (Array.isArray(j.canais) && j.canais.length) { estado.canais = j.canais.filter((c: Canal) => c.id.startsWith("pluto:") || naoPago({ nome: c.name, url: c.url } as Fonte)); estado.atualizado = j.atualizado || 0; }
    } catch {}
  }
  try { const c = JSON.parse((await ler("caidos.json")) || "[]"); if (Array.isArray(c)) caidos = c.filter((x: Canal) => x && x.id && x.url && naoPago({ nome: x.name, url: x.url } as Fonte)); } catch {}
  console.log(JSON.stringify({ evt: "inicio", armazenamento: S3 ? "bucket" : TEM_S3 ? "bucket indisponÃ­vel" : PASTA_LOCAL ? "pasta" : "nenhum", canaisCarregados: estado.canais.length }));
}
console.log("Tela Livre no ar");
// EstatÃ­sticas: guarda a cada 10 minutos e fecha o dia logo depois da meia-noite de BrasÃ­lia.
conferirDia();
setInterval(conferirDia, 10 * 60 * 1000);
setInterval(salvarTestados, 10 * 60 * 1000);
if (Date.now() - estado.atualizado > SEIS_HORAS) atualizar();
// RecuperaÃ§Ã£o de canais caÃ­dos: primeira rodada 5 minutos depois de ligar, depois a cada 20 minutos.
setTimeout(recuperar, 5 * 60 * 1000);
setInterval(recuperar, 20 * 60 * 1000);
// Confere a cada 30 minutos se a lista passou de 6 horas e, se passou, refaz os testes sozinho,
// mesmo que ninguÃ©m esteja assistindo.
setInterval(() => { if (Date.now() - estado.atualizado > SEIS_HORAS && !estado.atualizando) atualizar(); }, 30 * 60 * 1000);
// GuardiÃ£o do Pluto: renova os links ao ligar (se a lista completa nÃ£o estiver rodando) e depois a cada hora.
setTimeout(() => { if (!estado.atualizando) atualizarPluto(); }, 30 * 1000);
setInterval(() => { if (Date.now() - estado.plutoTs > UMA_HORA - 60 * 1000) atualizarPluto(); }, 15 * 60 * 1000);
// Guia de programaÃ§Ã£o do Pluto: primeira busca 1 minuto depois de ligar, depois a cada 30 minutos.
setTimeout(atualizarGuia, 60 * 1000);
setInterval(() => { if (Date.now() - guia.ts > 25 * 60 * 1000) atualizarGuia(); }, 10 * 60 * 1000);
// Filmes e sÃ©ries: catÃ¡logo 2 minutos depois de ligar e renovado a cada 6 horas.
setTimeout(() => { if (!vod.rodando) vod.rodando = atualizarVod().finally(() => { vod.rodando = null; }); }, 2 * 60 * 1000);
setInterval(() => { if (Date.now() - vod.ts > SEIS_HORAS && !vod.rodando) vod.rodando = atualizarVod().finally(() => { vod.rodando = null; }); }, 30 * 60 * 1000);
