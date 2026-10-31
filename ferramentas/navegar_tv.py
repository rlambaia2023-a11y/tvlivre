#!/usr/bin/env python3
"""Teste de navegação da TV publicada, com um Chrome de verdade (toca H.264/AAC como a TV).

Passos (cada um vira uma linha do relatório):
 1. Abre a TV e espera os canais abertos chegarem do servidor.
 2. Passa por todas as telas (Ao vivo, Rádios, Mundo, Câmeras, Filmes e séries, Meus vídeos, Ajustes)
    e confere se cada uma mostra conteúdo. Tira foto de cada tela.
 3. Em Ajustes: confere o link da Lista IPTV, aperta "Carregar lista" e confere se os canais
    novos aparecem na grade (Todos, 300 por vez e "Mostrar mais").
 4. Aperta "Atualizar agora" e confere se os canais abertos voltam e a Lista IPTV continua lá.
 5. Fecha e abre a TV de novo: a Lista IPTV tem que voltar sozinha.
 6. Aperta "Testar canais": confere se o teste inclui a Lista IPTV e se avança. Com
    TESTE_COMPLETO=1 espera até o fim e mostra quantos ficaram "Funcionando".
 7. Abre canais da grade (abertos e da Lista IPTV) e espera o vídeo andar de verdade.

Uso: TV=https://... python3 navegar_tv.py   (fotos e relatorio-navegacao.json na pasta atual)
"""
import json, os, random, re, sys, time
from playwright.sync_api import sync_playwright

TV = os.environ.get("TV", "https://tela-livre-production.up.railway.app").rstrip("/")
COMPLETO = os.environ.get("TESTE_COMPLETO") == "1"
N_ABERTOS = int(os.environ.get("CANAIS_ABERTOS", "6"))
N_IPTV = int(os.environ.get("CANAIS_IPTV", "8"))
FOTOS = os.environ.get("FOTOS", "fotos")
os.makedirs(FOTOS, exist_ok=True)

linhas, falhas, canais = [], [], []


def ok(passo, bom, detalhe=""):
    linhas.append(("OK" if bom else "FALHA", passo, detalhe))
    if not bom:
        falhas.append(passo)
    print(("OK    " if bom else "FALHA ") + passo + (" — " + detalhe if detalhe else ""), flush=True)


def txt(pg, sel):
    try:
        return (pg.text_content(sel, timeout=2000) or "").strip()
    except Exception:  # noqa: BLE001
        return ""


def foto(pg, nome):
    try:
        pg.screenshot(path=os.path.join(FOTOS, nome + ".png"))
    except Exception:  # noqa: BLE001
        pass


def aba(pg, t):
    # "Ao vivo" não tem botão próprio no menu: volta-se a ela pelas categorias (Início, Todos...).
    sel = '[data-g="inicio"]' if t == "live" else 'button[data-tab="' + t + '"]'
    pg.evaluate("s=>{var b=document.querySelector(s);if(b)b.click()}", sel)
    time.sleep(1.5)


def todos(pg):
    pg.evaluate("()=>{var b=document.querySelector('[data-g=\"todos\"]');if(b)b.click()}")
    time.sleep(1.5)
    return pg.evaluate("()=>{var s=document.querySelector('#vtitle small');return s?s.textContent:''}")


def numero(s):
    m = re.search(r"(\d[\d.]*)\s*canais", s or "")
    return int(m.group(1).replace(".", "")) if m else 0


def abrir_canal(pg, cid, nome):
    pg.evaluate("id=>{var b=document.querySelector('#channels .card[data-id=\"'+CSS.escape(id)+'\"]');if(b)b.click()}", cid)
    t0, res = time.time(), "não abriu em 30 s"
    while time.time() - t0 < 30:
        st = pg.evaluate("()=>{var v=document.getElementById('video'),e=document.getElementById('perr');"
                         "return {t:v.currentTime,r:v.readyState,w:v.videoWidth,err:e&&!e.hidden,why:e?e.textContent.slice(0,140):''}}")
        if st["t"] > 1.5 and st["r"] >= 2:
            res = "tocando (%dp, %.0f s de vídeo)" % (st["w"] and pg.evaluate("()=>document.getElementById('video').videoHeight") or 0, st["t"])
            break
        if st["err"]:
            res = "erro na tela: " + re.sub(r"\s+", " ", st["why"])
            break
        time.sleep(1)
    tocou = res.startswith("tocando")
    canais.append({"id": cid, "nome": nome, "abriu": tocou, "resultado": res, "segundos": round(time.time() - t0)})
    foto(pg, "canal-" + re.sub(r"\W+", "-", nome)[:40])
    pg.keyboard.press("Escape")
    time.sleep(1)
    if pg.evaluate("()=>!document.getElementById('player').hidden"):
        pg.keyboard.press("Backspace")
        time.sleep(1)
    return tocou, res


def main():
    with sync_playwright() as p:
        nav = p.chromium.launch(channel=os.environ.get("CANAL_CHROME", "chrome"),
                                args=["--autoplay-policy=no-user-gesture-required"])
        pg = nav.new_page(viewport={"width": 1280, "height": 720}, locale="pt-BR")
        erros_js = []
        pg.on("pageerror", lambda e: erros_js.append(str(e)[:160]))

        # 1. Abrir
        t0 = time.time()
        pg.goto(TV + "/", wait_until="domcontentloaded", timeout=60000)
        try:
            pg.wait_for_function("()=>document.querySelectorAll('#home .card[data-id]').length>5", timeout=90000)
            ok("Abrir a TV e carregar os canais abertos", True, "%d cartões na tela inicial em %.0f s" % (pg.evaluate("()=>document.querySelectorAll('#home .card[data-id]').length"), time.time() - t0))
        except Exception:  # noqa: BLE001
            ok("Abrir a TV e carregar os canais abertos", False, "a tela inicial não mostrou canais em 90 s")
        foto(pg, "01-inicio")
        antes = numero(todos(pg))

        # 2. Telas
        for t, nome, sel in (("radio", "Rádios", "#tab-radio button"), ("mundo", "Mundo", "#tab-mundo button"),
                             ("cams", "Câmeras", "#tab-cams button"), ("vod", "Filmes e séries", "#tab-vod .card"),
                             ("videos", "Meus vídeos", "#tab-videos"), ("settings", "Ajustes", "#tab-settings .box"),
                             ("live", "Ao vivo", "#tab-live .card")):
            aba(pg, t)
            try:
                pg.wait_for_function("s=>document.querySelectorAll(s).length>0", arg=sel, timeout=30000)
                visivel = pg.evaluate("t=>{var s=document.getElementById('tab-'+t);return !!s&&!s.hidden}", t)
                ok("Tela " + nome, visivel, "%d itens" % pg.evaluate("s=>document.querySelectorAll(s).length", sel))
            except Exception:  # noqa: BLE001
                ok("Tela " + nome, False, "ficou vazia em 30 s")
            foto(pg, "02-tela-" + t)

        # 3. Lista IPTV
        aba(pg, "settings")
        link = pg.eval_on_selector("#m3u-url", "e=>e.value")
        ok("Link da Lista IPTV aparece em Ajustes", bool(link), link)
        if not txt(pg, "#m3u-status").endswith("canais carregados."):
            pg.evaluate("()=>document.getElementById('m3u-load').click()")
        try:
            pg.wait_for_function("()=>/canais carregados|canais salvos/.test(document.getElementById('m3u-status').textContent)", timeout=120000)
            ok("Carregar lista", True, txt(pg, "#m3u-status") + " | " + txt(pg, "#sources"))
        except Exception:  # noqa: BLE001
            ok("Carregar lista", False, txt(pg, "#m3u-status") or "sem resposta em 2 min")
        foto(pg, "03-ajustes-lista")
        aba(pg, "live")
        depois = numero(todos(pg))
        cartoes = pg.evaluate("()=>document.querySelectorAll('#channels .card[data-id]').length")
        ok("Canais novos aparecem em Ao vivo › Todos", depois > antes + 1000, "%d antes, %d depois; %d cartões desenhados" % (antes, depois, cartoes))
        mais = pg.evaluate("()=>{var b=document.querySelector('#channels [data-mais]');if(!b)return 0;b.click();return document.querySelectorAll('#channels .card[data-id]').length}")
        ok("Botão Mostrar mais", mais > cartoes, "%d cartões depois do clique" % mais)
        foto(pg, "04-todos")

        # 4. Atualizar agora
        aba(pg, "settings")
        pg.evaluate("()=>document.getElementById('auto-refresh').click()")
        try:
            pg.wait_for_function("()=>/canais abertos no ar|Conferindo|Montando/.test(document.getElementById('auto-status').textContent)", timeout=90000)
            time.sleep(3)
            aba(pg, "live")
            n = numero(todos(pg))
            ok("Atualizar agora", n >= depois - 50, txt(pg, "#auto-status") + " | %d canais em Todos" % n)
        except Exception:  # noqa: BLE001
            ok("Atualizar agora", False, txt(pg, "#auto-status") or "sem resposta")

        # 5. Reabrir
        pg.reload(wait_until="domcontentloaded")
        try:
            pg.wait_for_function("()=>/canais carregados|canais salvos/.test(document.getElementById('m3u-status').textContent)", timeout=120000)
            time.sleep(2)
            ok("Ao reabrir, a Lista IPTV volta sozinha", True, txt(pg, "#m3u-status"))
        except Exception:  # noqa: BLE001
            ok("Ao reabrir, a Lista IPTV volta sozinha", False, txt(pg, "#m3u-status") or "não voltou em 2 min")
        aba(pg, "live")
        n = numero(todos(pg))
        ok("Canais da lista na grade depois de reabrir", n > antes + 1000, "%d canais em Todos" % n)

        # 6. Testar canais
        pg.evaluate("()=>document.getElementById('test').click()")
        try:
            pg.wait_for_function("()=>/Testando \\d+ de \\d+/.test(document.getElementById('test-status').textContent)", timeout=60000)
            time.sleep(20)
            s = txt(pg, "#test-status")
            m = re.search(r"Testando (\d+) de (\d+)", s)
            total = int(m.group(2)) if m else 0
            # O botão pula o que já tem resultado (inclusive o que o servidor compartilha por 6 h),
            # então "de N" pode ser bem menor que a lista: conta os canais da Lista IPTV no teste.
            lista_no_teste = pg.evaluate("()=>{try{return S.channels.filter(function(c){return c.src&&c.src!=='auto'}).length}catch(e){return 0}}")
            ok("Testar canais inclui a Lista IPTV e avança", (total > 5000 or lista_no_teste > 5000) and total > 0 and int(m.group(1)) > 20,
               s + " (%d canais da Lista IPTV no teste; o resto já tinha resultado)" % lista_no_teste)
            if COMPLETO:
                pg.wait_for_function("()=>/canais no ar/.test(document.getElementById('test-status').textContent)", timeout=3 * 3600 * 1000, polling=5000)
                ok("Testar canais até o fim", True, txt(pg, "#test-status"))
                foto(pg, "05-depois-do-teste")
            # Fecha e abre de novo no meio do teste: a lista tem que abrir da cópia guardada na TV
            # (sem baixar) e o que já foi testado tem que continuar salvo.
            time.sleep(25)
            pg.reload(wait_until="domcontentloaded")
            pg.wait_for_function("()=>/canais carregados|canais salvos/.test(document.getElementById('m3u-status').textContent)", timeout=60000)
            st = txt(pg, "#m3u-status")
            ok("Reabrir usa a lista salva na TV (sem baixar de novo)", "salvos nesta TV" in st, st)
            testados = pg.evaluate("()=>{try{return Object.keys(JSON.parse(localStorage.getItem('telalivre.v1')).teste||{}).length}catch(e){return 0}}")
            ok("Resultado do teste fica salvo na TV", testados >= 300, "%d canais com resultado guardado" % testados)
        except Exception as e:  # noqa: BLE001
            ok("Testar canais", False, (txt(pg, "#test-status") or "") + " " + str(e)[:80])

        # 7. Abrir canais (com o teste rodando a TV continua usável; recarrega para soltar o servidor)
        pg.reload(wait_until="domcontentloaded")
        pg.wait_for_function("()=>/canais carregados|canais salvos/.test(document.getElementById('m3u-status').textContent)", timeout=120000)
        aba(pg, "live")
        todos(pg)
        for _ in range(8):  # desenha uns 2.700 cartões para sortear da lista inteira
            if not pg.evaluate("()=>{var b=document.querySelector('#channels [data-mais]');if(b)b.click();return !!b}"):
                break
        cards = pg.evaluate("()=>[].map.call(document.querySelectorAll('#channels .card[data-id]'),function(b){return [b.dataset.id,(b.querySelector('.name')||b).textContent.trim()]})")
        rnd = random.Random(time.strftime("%Y%m%d%H"))
        abertos = [c for c in cards if c[0].startswith("a-") and not c[0].startswith("a-pluto")]
        iptv = [c for c in cards if c[0].startswith("m")]
        for grupo, lista, qtd in (("canal aberto", abertos, N_ABERTOS), ("Lista IPTV", iptv, N_IPTV)):
            esc = rnd.sample(lista, min(qtd, len(lista)))
            n_ok = 0
            for cid, nome in esc:
                tocou, res = abrir_canal(pg, cid, nome)
                n_ok += tocou
                print("   %s %s: %s" % ("▶" if tocou else "✕", nome, res), flush=True)
            ok("Abrir %s (vídeo tocando)" % grupo, n_ok >= max(1, len(esc) // 3), "%d de %d tocaram" % (n_ok, len(esc)))

        ok("Sem erros de JavaScript na página", not erros_js, "; ".join(erros_js[:3]))
        nav.close()

    resumo = ["## Navegação da TV (" + TV + ")", "", "| Resultado | Passo | Detalhe |", "|---|---|---|"]
    resumo += ["| %s | %s | %s |" % (a, b, c.replace("|", "/")) for a, b, c in linhas]
    resumo += ["", "**Canais abertos na tela:**"] + ["- %s %s: %s" % ("▶" if c["abriu"] else "✕", c["nome"], c["resultado"]) for c in canais]
    print("\n".join(resumo))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write("\n".join(resumo) + "\n")
    if os.environ.get("GITHUB_ACTIONS"):
        print("::notice title=Navegacao da TV::" + "%0A".join(resumo).replace("|", "¦"))
    with open("relatorio-navegacao.json", "w", encoding="utf-8") as f:
        json.dump({"passos": linhas, "canais": canais, "falhas": falhas}, f, ensure_ascii=False, indent=1)
    return 1 if falhas else 0


if __name__ == "__main__":
    sys.exit(main())
