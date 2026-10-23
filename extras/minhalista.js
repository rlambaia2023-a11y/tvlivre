/* Tela Livre — Minha lista e download de "Meus vídeos" (módulo extra)
   ------------------------------------------------------------------
   Fica fora da página principal (index.html): o servidor coloca este arquivo
   na página na hora de entregar. Ele só lê o que já está na tela e no
   armazenamento da TV, e acrescenta:

   1. "Minha lista" em Filmes e séries: guarda filmes e séries para ver depois.
      - Botão amarelo do controle (ou F no teclado) num filme ou série: põe ou
        tira da lista. O cartão ganha uma estrela.
      - Na página de uma série aparece o botão "＋ Minha lista".
      - Na tela inicial de Filmes e séries surge a fileira "Minha lista", logo
        depois de "Continuar assistindo".
      A lista fica guardada só nesta TV e não baixa nenhum vídeo.

   2. Download em "Meus vídeos": para os vídeos cadastrados por link (que são
      seus), aparece a seção "Baixar para outro aparelho" com um link de
      download de cada um. Transmissões em partes (.m3u8) não viram arquivo
      único, então ficam de fora com um aviso. */
(function () {
  "use strict";
  var CHAVE = "telalivre.minhalista";
  var COR = "#ff9386";

  function ler() { try { var l = JSON.parse(localStorage.getItem(CHAVE) || "[]"); return Array.isArray(l) ? l : []; } catch (e) { return []; } }
  function gravar(l) { try { localStorage.setItem(CHAVE, JSON.stringify(l)); } catch (e) {} }
  function naLista(pid) { return ler().some(function (x) { return x.pid === pid; }); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function iniciais(n) { return (n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join("").toUpperCase(); }

  /* Lê do cartão o que precisa para mostrar o título de novo depois (nome, tipo, capa). */
  function dadosDoCartao(b) {
    var nome = (b.querySelector(".name") || {}).textContent || "";
    var etiqueta = (b.querySelector(".grp") || {}).textContent || "";
    var img = b.querySelector("img");
    return { pid: b.dataset.v, nome: nome.trim(), tipo: /s[ée]rie/i.test(etiqueta) ? "s" : "f", etiqueta: etiqueta.trim(), capa: img ? img.getAttribute("src") : "", em: Date.now() };
  }
  var avisoT = null;
  function aviso(txt) {
    var a = document.getElementById("tlml-aviso");
    if (!a) {
      a = document.createElement("div"); a.id = "tlml-aviso"; a.setAttribute("role", "status");
      document.body.appendChild(a);
    }
    a.textContent = txt; a.className = "tlml-aviso on";
    clearTimeout(avisoT); avisoT = setTimeout(function () { a.className = "tlml-aviso"; }, 2200);
  }
  function alternar(dados) {
    var l = ler(), i = -1;
    l.forEach(function (x, k) { if (x.pid === dados.pid) i = k; });
    if (i > -1) { l.splice(i, 1); gravar(l); aviso("Tirado da Minha lista"); return false; }
    l.unshift(dados); gravar(l.slice(0, 200)); aviso("Guardado na Minha lista ★"); return true;
  }

  function iniciar() {
    var tabVod = document.getElementById("tab-vod"), corpo = document.getElementById("vod-corpo");
    if (!tabVod || !corpo) return;

    var css = document.createElement("style");
    css.textContent =
      ".tlml-estrela{position:absolute;top:.45em;right:.45em;z-index:2;background:rgba(0,0,0,.65);color:var(--signal,#ffb547);border-radius:999px;padding:.1em .45em;font-size:.8em;line-height:1.3}" +
      ".tlml-aviso{position:fixed;left:50%;bottom:6vh;transform:translate(-50%,20px);z-index:60;background:rgba(11,15,20,.94);color:#e9edf2;border:1px solid rgba(255,255,255,.14);" +
      "border-radius:999px;padding:.6em 1.2em;font-weight:700;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s}" +
      ".tlml-aviso.on{opacity:1;transform:translate(-50%,0)}" +
      ".tlml-dica{color:var(--muted,#8b97a8);font-size:.8em;margin-left:.6em;font-weight:500}" +
      ".tlml-serie{margin:.2em 0 1em}" +
      ".tlml-baixar{margin-top:clamp(18px,2vw,32px);background:var(--panel,#141a22);border-radius:14px;padding:clamp(14px,1.6vw,24px);display:flex;flex-direction:column;gap:10px}" +
      ".tlml-baixar h3{margin:0;font-family:var(--font-display,system-ui);font-weight:800;text-transform:uppercase;letter-spacing:.03em}" +
      ".tlml-baixar p{margin:0;color:var(--muted,#8b97a8);line-height:1.5}" +
      ".tlml-baixar ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}" +
      ".tlml-baixar li{display:flex;align-items:center;gap:12px;flex-wrap:wrap;border-top:1px solid var(--line,#2a3442);padding-top:8px;min-width:0}" +
      ".tlml-baixar li span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".tlml-baixar li small{color:var(--muted,#8b97a8)}" +
      "@media (prefers-reduced-motion:reduce){.tlml-aviso{transition:none}}";
    document.head.appendChild(css);

    /* ---------- estrela nos cartões que estão na lista ---------- */
    function marcarCartoes(raiz) {
      var ids = {}; ler().forEach(function (x) { ids[x.pid] = 1; });
      Array.prototype.forEach.call((raiz || corpo).querySelectorAll("[data-v]"), function (b) {
        var tem = b.querySelector(".tlml-estrela");
        if (ids[b.dataset.v] && !tem) { var s = document.createElement("span"); s.className = "tlml-estrela"; s.textContent = "★"; b.appendChild(s); }
        else if (!ids[b.dataset.v] && tem) tem.remove();
      });
    }

    /* ---------- fileira "Minha lista" na tela inicial de Filmes e séries ---------- */
    function cartao(x) {
      var ini = esc(iniciais(x.nome));
      return '<button class="card capa f" data-v="' + esc(x.pid) + '" style="--c:' + COR + '"><span class="grp">' + esc(x.etiqueta || (x.tipo === "s" ? "Série" : "Filme")) + '</span>' +
        '<div class="art">' + (x.capa ? '<img src="' + esc(x.capa) + '" alt="" loading="lazy" onerror="this.parentNode.innerHTML=\'<span class=ini>' + ini + '</span>\'">' : '<span class="ini">' + ini + '</span>') + '</div>' +
        '<div class="meta"><span class="name">' + esc(x.nome) + '</span></div></button>';
    }
    function ehInicio() {
      // Tela inicial = tem fileiras e não está numa série, categoria ou busca.
      return !!corpo.querySelector(".rail") && !corpo.querySelector("#vod-grid") && !corpo.querySelector("#vod-eps") && !document.getElementById("vod-voltar").offsetParent;
    }
    function filtroAtual() {
      var c = document.querySelector('#vod-filtro [aria-pressed="true"]');
      return c ? c.getAttribute("data-vf") || "" : "";
    }
    function pintarFileira() {
      var velha = document.getElementById("tlml-fileira");
      if (!ehInicio()) { if (velha) velha.remove(); return; }
      var f = filtroAtual(), l = ler().filter(function (x) { return !f || x.tipo === f; });
      if (!l.length) { if (velha) velha.remove(); return; }
      var html = '<div class="rhead"><span class="ricon">★</span><h3>Minha lista</h3><span class="rcount">' + l.length + '</span>' +
        '<span class="tlml-dica">amarelo (F) num título põe ou tira da lista</span></div><div class="rrow capas">' + l.slice(0, 40).map(cartao).join("") + '</div>';
      var sec = velha;
      if (!sec) { sec = document.createElement("section"); sec.className = "rail"; sec.id = "tlml-fileira"; sec.style.setProperty("--c", COR); }
      sec.innerHTML = html;
      // Logo depois de "Continuar assistindo" (que é sempre a primeira quando existe).
      var primeira = corpo.querySelector(".rail:not(#tlml-fileira)");
      var cont = primeira && /Continuar assistindo/.test(primeira.textContent) ? primeira : null;
      if (cont) { if (cont.nextSibling !== sec) cont.parentNode.insertBefore(sec, cont.nextSibling); }
      else if (corpo.firstChild !== sec) corpo.insertBefore(sec, corpo.firstChild);
    }

    /* ---------- botão na página da série ---------- */
    var ultimaSerie = null;
    tabVod.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-v]");
      if (b && /s[ée]rie/i.test((b.querySelector(".grp") || {}).textContent || "")) ultimaSerie = dadosDoCartao(b);
      var bt = e.target.closest && e.target.closest("#tlml-serie-bt");
      if (bt && ultimaSerie) { alternar(ultimaSerie); pintarBotaoSerie(); }
    }, true);
    function pintarBotaoSerie() {
      var eps = corpo.querySelector("#vod-eps"), bt = document.getElementById("tlml-serie-bt");
      if (!eps || !ultimaSerie) { if (bt && !eps) bt.parentNode.remove(); return; }
      var tem = naLista(ultimaSerie.pid);
      if (!bt) {
        var linha = document.createElement("div"); linha.className = "row tlml-serie";
        linha.innerHTML = '<button class="btn ghost f" id="tlml-serie-bt"></button>';
        var sinopse = corpo.querySelector(".vsinopse");
        if (sinopse) sinopse.parentNode.insertBefore(linha, sinopse.nextSibling); else corpo.insertBefore(linha, corpo.firstChild);
        bt = document.getElementById("tlml-serie-bt");
      }
      bt.textContent = tem ? "★ Na Minha lista (tirar)" : "＋ Minha lista";
    }

    /* Toda vez que a página redesenha Filmes e séries, a fileira, as estrelas e o botão voltam. */
    var ocupado = false;
    function repintar() {
      if (ocupado) return; ocupado = true;
      try { pintarFileira(); pintarBotaoSerie(); marcarCartoes(); } finally { ocupado = false; }
    }
    new MutationObserver(function () { if (!ocupado) repintar(); }).observe(corpo, { childList: true });
    var filtro = document.getElementById("vod-filtro");
    if (filtro) new MutationObserver(function () { if (!ocupado) repintar(); }).observe(filtro, { childList: true, subtree: true, attributes: true });
    repintar();

    /* ---------- botão amarelo (ou F) num filme ou série ---------- */
    window.addEventListener("keydown", function (e) {
      var k = e.keyCode, a = document.activeElement;
      if (k !== 405 && k !== 70) return;
      if (a && a.tagName === "INPUT") return;
      var player = document.getElementById("player"); if (player && !player.hidden) return;
      var b = a && a.closest && a.closest("#tab-vod [data-v]");
      if (!b) return;
      e.preventDefault(); e.stopImmediatePropagation();
      var pid = b.dataset.v;
      alternar(dadosDoCartao(b));
      repintar();
      var volta = corpo.querySelector('[data-v="' + pid + '"]:not(#tlml-fileira [data-v])') || corpo.querySelector('[data-v="' + pid + '"]');
      if (a !== volta && volta && !document.body.contains(a)) volta.focus();
    }, true);

    /* ---------- "Meus vídeos": baixar os vídeos cadastrados por link ---------- */
    var grade = document.getElementById("videos");
    function meusVideos() {
      try { var s = JSON.parse(localStorage.getItem("telalivre.v1") || "{}"); return Array.isArray(s.videos) ? s.videos : []; } catch (e) { return []; }
    }
    function pintarBaixar() {
      if (!grade) return;
      var caixa = document.getElementById("tlml-baixar");
      var v = meusVideos().filter(function (x) { return x && /^https?:\/\//i.test(x.url || ""); });
      if (!v.length) { if (caixa) caixa.remove(); return; }
      if (!caixa) { caixa = document.createElement("div"); caixa.className = "tlml-baixar"; caixa.id = "tlml-baixar"; grade.parentNode.insertBefore(caixa, grade.nextSibling); }
      caixa.innerHTML = '<h3>Baixar para outro aparelho</h3>' +
        '<p>Abra o Tela Livre no celular ou no computador para baixar. Na TV o navegador costuma não ter espaço para guardar vídeos.</p><ul>' +
        v.map(function (x) {
          var partes = /\.m3u8?(\?|$)/i.test(x.url);
          var nome = (x.name || "video").replace(/[\\/:*?"<>|]+/g, " ").trim();
          return '<li><span>' + esc(x.name) + '</span>' + (partes
            ? '<small>transmissão em partes (.m3u8): não dá para baixar como um arquivo só</small>'
            : '<a class="btn ghost f" href="' + esc(x.url) + '" download="' + esc(nome) + '" target="_blank" rel="noopener">⬇ Baixar</a>') + '</li>';
        }).join("") + '</ul>';
    }
    if (grade) new MutationObserver(pintarBaixar).observe(grade, { childList: true });
    pintarBaixar();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar); else iniciar();
})();
