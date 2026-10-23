/* Tela Livre — controles de reprodução (módulo extra)
   ------------------------------------------------------------------
   Este arquivo NÃO faz parte da página principal (index.html). O servidor
   o coloca na página na hora de entregar, logo depois do hls.js e antes do
   código da TV. Ele só conversa com a página pelo elemento <video id="video">,
   pelo hls.js e pelo teclado/controle remoto.

   O que ele faz:
   1. Pausar, voltar e avançar em tudo que passa no player: canais ao vivo,
      rádios, TV de outros países e "Meus vídeos". (Filmes e séries do Pluto
      já têm esses comandos na página; aqui eles ganham a barra e o resto.)
   2. Durante a pausa, o vídeo continua carregando à frente: o limite de folga
      do hls.js sobe enquanto está pausado e volta ao normal no play.
   3. No ao vivo, pausar vira "assistir atrasado": ao soltar a pausa o canal
      continua de onde parou, e o botão "Ao vivo" volta para o momento atual.

   Controle remoto, com o player aberto:
   - OK, ⏯, ▶ ou ⏸ ............ pausa / continua
   - ⏪ / ⏩ ...................... volta / avança 10 s
   - ← / → .................... em "Meus vídeos": volta 10 s / avança 30 s;
                                no ao vivo, só enquanto pausado (sem pausa,
                                continuam abrindo a lista e as opções)
   Os filmes e séries do Pluto seguem com os comandos da própria página. */
(function () {
  "use strict";

  /* ---------- 1) hls.js: guarda a instância e dá mais folga para trás ---------- */
  var H = window.Hls, atual = null;
  if (H && !H.__tlControles) {
    var TL = function (cfg) {
      cfg = cfg || {};
      // Guarda até 90 s já assistidos, para dar para voltar sem baixar de novo.
      cfg.backBufferLength = Math.max(cfg.backBufferLength || 0, 90);
      var inst;
      if (typeof Reflect !== "undefined" && Reflect.construct) inst = Reflect.construct(H, [cfg], TL);
      else { inst = this; H.call(inst, cfg); }
      atual = inst;
      return inst;
    };
    TL.prototype = Object.create(H.prototype, { constructor: { value: TL, writable: true, configurable: true } });
    try { Object.setPrototypeOf(TL, H); } catch (e) { for (var k in H) TL[k] = H[k]; }
    TL.__tlControles = true;
    window.Hls = TL;
  }
  function hlsAtivo(v) { return atual && atual.media === v ? atual : null; }

  // Para diagnóstico no console do navegador: window.TLControles.hls() devolve o hls.js em uso.
  window.TLControles = { hls: function () { return atual; } };

  /* ---------- 2) espera a página montar o player ---------- */
  function iniciar() {
    var video = document.getElementById("video"), player = document.getElementById("player");
    if (!video || !player) return;
    video.preload = "auto";

    /* ---------- barra de controles ---------- */
    var css = document.createElement("style");
    css.textContent =
      ".tlc{position:absolute;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:4;width:min(860px,94vw);" +
      "background:rgba(11,15,20,.88);border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:14px 18px;display:flex;flex-direction:column;gap:10px;" +
      "font-family:var(--font-body,system-ui);color:#e9edf2;transition:opacity .25s}" +
      ".tlc.off{opacity:0;pointer-events:none}" +
      ".tlc .lin{display:flex;align-items:center;gap:12px;min-width:0}" +
      ".tlc button{background:rgba(255,255,255,.08);border:2px solid transparent;color:inherit;border-radius:999px;min-width:3.1em;height:3.1em;padding:0 .9em;font:inherit;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:.35em;white-space:nowrap}" +
      ".tlc button:hover,.tlc button:focus{border-color:var(--signal,#ffb547);outline:none}" +
      ".tlc .pp{background:var(--signal,#ffb547);color:#111;min-width:3.6em;height:3.6em;font-size:1.05em}" +
      ".tlc .aovivo{margin-left:auto;font-size:.8em;letter-spacing:.06em}" +
      ".tlc .aovivo.on{background:var(--live,#ff4d4d);color:#fff}" +
      ".tlc .tempo{font-variant-numeric:tabular-nums;color:#c9d1dc;font-size:.95em;white-space:nowrap}" +
      ".tlc .msg{color:#97a3b4;font-size:.85em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}" +
      ".tlc .trilha{position:relative;flex:1;height:8px;border-radius:4px;background:rgba(255,255,255,.14);overflow:hidden;cursor:pointer}" +
      ".tlc .trilha i{position:absolute;top:0;bottom:0;left:0;border-radius:4px}" +
      ".tlc .trilha .car{background:rgba(255,255,255,.32)}" +
      ".tlc .trilha .vis{background:var(--signal,#ffb547)}" +
      ".tlc-salto{position:absolute;top:50%;z-index:4;transform:translateY(-50%);font-family:var(--font-display,system-ui);font-weight:800;font-size:clamp(28px,3vw,56px);" +
      "color:#fff;background:rgba(0,0,0,.55);padding:.2em .6em;border-radius:14px;pointer-events:none;transition:opacity .3s}" +
      ".tlc-salto.esq{left:8%}.tlc-salto.dir{right:8%}.tlc-salto.off{opacity:0}" +
      ".tlc-pausa{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:3;width:110px;height:110px;border-radius:50%;background:rgba(0,0,0,.5);" +
      "display:grid;place-items:center;pointer-events:none}" +
      ".tlc-pausa:before,.tlc-pausa:after{content:'';position:absolute;top:32px;width:14px;height:46px;border-radius:4px;background:#fff}" +
      ".tlc-pausa:before{left:36px}.tlc-pausa:after{right:36px}" +
      ".player.cam .tlc,.player.cam .tlc-pausa,.player.cam .tlc-salto{display:none!important}" +
      "@media (prefers-reduced-motion:reduce){.tlc,.tlc-salto{transition:none}}";
    document.head.appendChild(css);

    var bar = document.createElement("div");
    bar.className = "tlc off";
    bar.innerHTML =
      '<div class="lin"><button class="vol" aria-label="Voltar 10 segundos">⏪ 10</button>' +
      '<button class="pp" aria-label="Pausar">❚❚</button>' +
      '<button class="ava" aria-label="Avançar 10 segundos">10 ⏩</button>' +
      '<span class="tempo"></span><button class="aovivo" hidden>AO VIVO</button></div>' +
      '<div class="lin"><div class="trilha"><i class="car"></i><i class="vis"></i></div></div>' +
      '<div class="lin"><span class="msg"></span></div>';
    player.appendChild(bar);
    var salto = document.createElement("div"); salto.className = "tlc-salto off"; player.appendChild(salto);
    var icone = document.createElement("div"); icone.className = "tlc-pausa"; icone.hidden = true; player.appendChild(icone);
    function $(s) { return bar.querySelector(s); }

    /* ---------- estado do vídeo ---------- */
    function temVideo() { return !player.hidden && !player.classList.contains("cam") && !!(video.currentSrc || video.getAttribute("src") || hlsAtivo(video)); }
    function sobDemanda() {
      // O hls.js sabe se a playlist é ao vivo; sem ele, ao vivo aparece com duração infinita.
      var h = hlsAtivo(video);
      if (h && h.levels && h.levels.length) {
        var lv = h.levels[h.currentLevel >= 0 ? h.currentLevel : 0] || h.levels[0];
        if (lv && lv.details) return !lv.details.live;
      }
      return isFinite(video.duration) && video.duration > 0;
    }
    function ehFilmePluto() { var h = document.getElementById("o-hint"); return !!(h && /volta 10/.test(h.textContent)); }
    function janela() {
      // Até onde dá para ir: no ao vivo, a janela que a emissora deixa disponível.
      var s = video.seekable, ini = 0, fim = 0;
      if (s && s.length) { ini = s.start(0); fim = s.end(s.length - 1); }
      else if (video.buffered.length) { ini = video.buffered.start(0); fim = video.buffered.end(video.buffered.length - 1); }
      if (sobDemanda()) { ini = 0; fim = video.duration; }
      var h = hlsAtivo(video);
      if (!sobDemanda() && h && h.liveSyncPosition) fim = Math.max(ini, Math.min(fim || h.liveSyncPosition, h.liveSyncPosition));
      return { ini: ini, fim: fim };
    }
    function aFrente() {
      var b = video.buffered, t = video.currentTime;
      for (var i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) >= t) return Math.max(0, b.end(i) - t);
      return 0;
    }
    function atraso() { if (sobDemanda()) return 0; var j = janela(); return Math.max(0, j.fim - video.currentTime); }
    function relogio(s) {
      s = Math.max(0, Math.round(s)); var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
      return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0");
    }

    /* ---------- folga extra durante a pausa ---------- */
    var original = null, dono = null;
    function folgaPausa(liga) {
      var h = hlsAtivo(video); if (!h) return;
      var c = h.config;
      if (dono !== h) { dono = h; original = { mbl: c.maxBufferLength, mmbl: c.maxMaxBufferLength, mbs: c.maxBufferSize, lat: c.liveMaxLatencyDurationCount }; }
      if (liga) {
        // Pausado: deixa o hls.js continuar baixando por até 10 min (ou ~120 MB) à frente.
        c.maxBufferLength = Math.max(original.mbl, 600);
        c.maxMaxBufferLength = Math.max(original.mmbl, 600);
        c.maxBufferSize = Math.max(original.mbs || 0, 120 * 1000 * 1000);
        if (!sobDemanda()) atrasado(true);
        try { h.startLoad(-1); } catch (e) {}
      } else {
        // Play: volta ao limite normal (o que já foi baixado continua guardado).
        c.maxBufferLength = original.mbl; c.maxMaxBufferLength = original.mmbl; c.maxBufferSize = original.mbs;
      }
    }
    function atrasado(sim) {
      // No ao vivo, o hls.js costuma pular de volta para o momento atual quando fica muito atrás.
      // Enquanto a pessoa assiste atrasado de propósito, esse pulo fica desligado.
      var h = hlsAtivo(video); if (!h) return;
      if (dono !== h) folgaPausa(false);
      h.config.liveMaxLatencyDurationCount = sim ? 1e6 : (original && original.lat) || 12;
      if (h.config.liveMaxLatencyDuration !== undefined && sim) h.config.liveMaxLatencyDuration = 1e6;
    }

    /* ---------- comandos ---------- */
    function tocarPausar(forca) {
      if (!temVideo()) return;
      var pausar = forca === "pausa" || (forca !== "play" && !video.paused);
      if (pausar) video.pause(); else { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
      mostrar();
    }
    var acumulo = 0, acumuloT = 0;
    function pular(seg) {
      if (!temVideo()) return;
      // Apertos seguidos aceleram: 10 s, 10 s, 20 s, 30 s…
      var agora = Date.now();
      acumulo = agora - acumuloT < 900 ? acumulo + 1 : 0; acumuloT = agora;
      var passo = seg * (acumulo < 2 ? 1 : Math.min(acumulo, 6) - 0);
      var j = janela(), alvo = video.currentTime + passo;
      if (!sobDemanda()) { atrasado(true); alvo = Math.min(alvo, j.fim - 1); }
      alvo = Math.max(j.ini + 0.1, Math.min(alvo, (sobDemanda() ? j.fim - 1 : j.fim)));
      video.currentTime = alvo;
      salto.textContent = (passo < 0 ? "⏪ " : "⏩ ") + Math.abs(passo) + " s";
      salto.className = "tlc-salto " + (passo < 0 ? "esq" : "dir");
      clearTimeout(salto._t); salto._t = setTimeout(function () { salto.classList.add("off"); }, 700);
      mostrar();
    }
    function irAoVivo() {
      var j = janela(); var h = hlsAtivo(video);
      video.currentTime = h && h.liveSyncPosition ? h.liveSyncPosition : Math.max(j.ini, j.fim - 3);
      atrasado(false);
      if (video.paused) { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
      mostrar();
    }
    $(".vol").onclick = function () { pular(-10); };
    $(".ava").onclick = function () { pular(10); };
    $(".pp").onclick = function () { tocarPausar(); };
    $(".aovivo").onclick = irAoVivo;
    $(".trilha").onclick = function (e) {
      var r = this.getBoundingClientRect(), j = janela(), f = (e.clientX - r.left) / r.width;
      if (j.fim > j.ini) { if (!sobDemanda()) atrasado(true); video.currentTime = j.ini + f * (j.fim - j.ini); mostrar(); }
    };

    /* ---------- barra: mostra, esconde e atualiza ---------- */
    var someT = null;
    function mostrar() {
      if (!temVideo()) return;
      atualizar();
      bar.classList.remove("off");
      var osd = document.getElementById("osd"); if (osd) osd.classList.add("hide");
      clearTimeout(someT);
      someT = setTimeout(function () { if (!video.paused) bar.classList.add("off"); }, 4000);
    }
    function atualizar() {
      if (!temVideo()) { bar.classList.add("off"); icone.hidden = true; return; }
      var j = janela(), vod = sobDemanda(), t = video.currentTime, frente = aFrente();
      var total = Math.max(0.001, j.fim - j.ini);
      $(".vis").style.width = Math.max(0, Math.min(100, (t - j.ini) / total * 100)) + "%";
      $(".car").style.width = Math.max(0, Math.min(100, (t + frente - j.ini) / total * 100)) + "%";
      var pp = $(".pp"); pp.textContent = video.paused ? "▶" : "❚❚"; pp.setAttribute("aria-label", video.paused ? "Continuar" : "Pausar");
      icone.hidden = !video.paused;
      var av = $(".aovivo"), atr = atraso();
      av.hidden = vod;
      av.classList.toggle("on", !vod && atr < 15);
      av.textContent = !vod && atr >= 15 ? "VOLTAR AO VIVO" : "AO VIVO";
      $(".tempo").textContent = vod ? relogio(t) + " / " + relogio(j.fim) : (atr >= 15 ? relogio(atr) + " atrás do ao vivo" : "");
      var msg = "";
      if (video.paused) msg = "Pausado · já carregou " + relogio(frente) + " à frente" + (hlsAtivo(video) ? " e continua carregando" : "");
      else if (frente < 2 && video.readyState < 3) msg = "Carregando…";
      else msg = "Folga guardada: " + relogio(frente) + (ehFilmePluto() ? " · ← volta 10 s · → avança 30 s" : vod ? " · ← volta 10 s · → avança 30 s" : " · OK pausa · ⏪ ⏩ voltam e avançam");
      $(".msg").textContent = msg;
      // Voltou para perto do ao vivo sozinho: religa o pulo automático para não ficar para trás.
      if (!vod && !video.paused && atr < 10 && hlsAtivo(video) && hlsAtivo(video).config.liveMaxLatencyDurationCount > 1e5) atrasado(false);
    }
    setInterval(function () { if (!bar.classList.contains("off") || video.paused) atualizar(); if (player.hidden) { bar.classList.add("off"); icone.hidden = true; } }, 500);

    video.addEventListener("pause", function () { if (!temVideo() || video.ended) return; folgaPausa(true); mostrar(); });
    video.addEventListener("play", function () { folgaPausa(false); mostrar(); });
    video.addEventListener("seeked", atualizar);
    video.addEventListener("loadstart", function () { dono = null; original = null; icone.hidden = true; });

    /* ---------- controle remoto ---------- */
    function painelOuSenha() {
      var ids = ["plist", "popts", "pin"];
      for (var i = 0; i < ids.length; i++) { var el = document.getElementById(ids[i]); if (el && !el.hidden) return true; }
      return false;
    }
    window.addEventListener("keydown", function (e) {
      if (!temVideo() || painelOuSenha()) return;
      var a = document.activeElement; if (a && a.tagName === "INPUT") return;
      var k = e.keyCode, feito = true;
      // Filmes e séries do Pluto: a página já cuida de ←/→/OK; aqui só a barra aparece junto.
      if (ehFilmePluto()) { if ([13, 32, 37, 39, 412, 417, 415, 19, 10252, 179].indexOf(k) > -1) setTimeout(mostrar, 0); return; }
      if (k === 13 || k === 32 || k === 10252 || k === 179) tocarPausar();
      else if (k === 415) tocarPausar("play");
      else if (k === 19) tocarPausar("pausa");
      else if (k === 412) pular(-10);
      else if (k === 417) pular(10);
      else if ((k === 37 || k === 39) && sobDemanda()) pular(k === 37 ? -10 : 30);
      else if ((k === 37 || k === 39) && video.paused) pular(k === 37 ? -10 : 10);
      else feito = false;
      if (feito) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    player.addEventListener("mousemove", function () { if (temVideo()) mostrar(); });

    /* Samsung (Tizen): pede as teclas de mídia do controle. */
    try {
      if (window.tizen && tizen.tvinputdevice) ["MediaPlayPause", "MediaPlay", "MediaPause", "MediaRewind", "MediaFastForward"].forEach(function (n) { try { tizen.tvinputdevice.registerKey(n); } catch (e) {} });
    } catch (e) {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar); else iniciar();
})();
