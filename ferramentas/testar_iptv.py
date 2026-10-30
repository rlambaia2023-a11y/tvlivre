#!/usr/bin/env python3
"""Testa a Lista IPTV dos Ajustes do mesmo jeito que a TV.

1. Baixa a lista pelo servidor da TV (/list), como o botão "Carregar lista".
2. Conta canais, grupos e quantos trazem opções do VLC (#EXTVLCOPT: referrer e user-agent).
3. Sorteia canais (metade com opções do VLC) e chama /check no servidor, como o botão
   "Testar canais".
4. Para cada canal aprovado, abre de verdade pelo relay (/p): playlist, variante e o
   primeiro pedaço de vídeo. Só conta como "abriu" se o pedaço chegar com bytes.

Escreve o resumo no terminal, em $GITHUB_STEP_SUMMARY (se existir) e em resultado-iptv.json.
Sai com erro se a lista não baixar, vier pequena demais ou quase nada abrir.

Uso: TV=https://... python3 testar_iptv.py [quantidade]
"""
import json, os, random, re, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

TV = os.environ.get("TV", "https://tela-livre-production.up.railway.app").rstrip("/")
LISTA = os.environ.get("LISTA_IPTV", "https://iptv-org.github.io/iptv/index.m3u")
QTD = int(sys.argv[1]) if len(sys.argv) > 1 else 80
UA = "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0 TV Safari/537.36"


def pegar(caminho, tempo=30, limite=None):
    req = urllib.request.Request(TV + caminho, headers={"user-agent": UA})
    with urllib.request.urlopen(req, timeout=tempo) as r:
        return r.read(limite) if limite else r.read()


def ler_m3u(texto):
    out, cur = [], None
    for l in texto.splitlines():
        l = l.strip()
        if not l:
            continue
        if l.startswith("#EXTINF"):
            at = dict((k.lower(), v) for k, v in re.findall(r'([\w-]+)="([^"]*)"', l))
            nome = l.rsplit(",", 1)[-1].strip() if "," in l else ""
            cur = {"nome": nome or at.get("tvg-name", "Sem nome"), "grupo": at.get("group-title", "Outros"),
                   "ref": at.get("http-referrer", ""), "ua": at.get("http-user-agent", "")}
        elif cur is not None and re.match(r"#EXTVLCOPT:http-referr?er=", l, re.I):
            cur["ref"] = l.split("=", 1)[1].strip()
        elif cur is not None and re.match(r"#EXTVLCOPT:http-user-agent=", l, re.I):
            cur["ua"] = l.split("=", 1)[1].strip()
        elif not l.startswith("#") and cur is not None:
            cur["url"] = l
            out.append(cur)
            cur = None
    return out


def q(c, rota):
    s = rota + "?u=" + urllib.parse.quote(c["url"], safe="")
    if c["ref"]:
        s += "&r=" + urllib.parse.quote(c["ref"], safe="")
    if c["ua"]:
        s += "&a=" + urllib.parse.quote(c["ua"], safe="")
    return s


def abrir(c):
    """Abre pelo relay como o player da TV: playlist -> variante -> primeiro pedaço."""
    try:
        txt = pegar(q(c, "/p"), 20).decode("utf-8", "replace")
        if not txt.lstrip().startswith("#EXTM3U"):
            return len(txt) > 0, "arquivo direto"
        linhas = [l.strip() for l in txt.splitlines()]
        if any(l.startswith("#EXT-X-STREAM-INF") for l in linhas):
            i = next(k for k, l in enumerate(linhas) if l.startswith("#EXT-X-STREAM-INF"))
            var = next((l for l in linhas[i + 1:] if l and not l.startswith("#")), "")
            if not var.startswith("/p?"):
                return False, "variante fora do relay"
            linhas = [l.strip() for l in pegar(var, 20).decode("utf-8", "replace").splitlines()]
        ped = next((l for l in linhas if l and not l.startswith("#")), "")
        if not ped.startswith("/p?"):
            return False, "sem pedaços de vídeo"
        dados = pegar(ped, 25, 200000)
        return len(dados) > 1000, "pedaço com %d bytes" % len(dados)
    except Exception as e:  # noqa: BLE001 — o motivo vai para o relatório
        return False, type(e).__name__ + ": " + str(e)[:80]


def testar(c):
    t = time.time()
    try:
        r = json.loads(pegar(q(c, "/check"), 30))
    except Exception as e:  # noqa: BLE001
        r = {"ok": False, "motivo": "check falhou: " + type(e).__name__}
    c["check"], c["motivo"] = bool(r.get("ok")), r.get("motivo", "")
    c["abriu"], c["detalhe"] = abrir(c) if c["check"] else (False, "")
    c["seg"] = round(time.time() - t, 1)
    return c


def main():
    t0 = time.time()
    try:
        texto = pegar("/list?u=" + urllib.parse.quote(LISTA, safe=""), 90).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        print("FALHA: a lista não baixou pelo servidor da TV:", e)
        return 1
    canais = ler_m3u(texto)
    pluto = [c for c in canais if re.search(r"pluto\.tv|jmp2\.uk", c["url"], re.I)]
    resto = [c for c in canais if c not in pluto]
    vlc = [c for c in resto if c["ref"] or c["ua"]]
    grupos = len({c["grupo"] for c in canais})
    navegador = [c for c in resto if not re.match(r"^(rtmp|rtsp|mms|udp)", c["url"], re.I) and not re.search(r"\.mpd(\?|$)", c["url"], re.I)]
    print(f"Lista: {len(canais)} canais | {grupos} grupos | Pluto: {len(pluto)} | com opções do VLC: {len(vlc)} "
          f"(referrer {sum(1 for c in vlc if c['ref'])}, user-agent {sum(1 for c in vlc if c['ua'])}) | "
          f"formatos que o navegador não toca (rtmp/rtsp/mms/udp/dash): {len(resto) - len(navegador)}")
    if len(canais) < 5000:
        print("FALHA: lista menor que o esperado")
        return 1

    rnd = random.Random(time.strftime("%Y%m%d%H"))
    metade = QTD // 2
    amostra = rnd.sample([c for c in vlc if c in navegador], min(metade, len(vlc)))
    sem_vlc = [c for c in navegador if not (c["ref"] or c["ua"])]
    amostra += rnd.sample(sem_vlc, min(QTD - len(amostra), len(sem_vlc)))
    with ThreadPoolExecutor(12) as ex:
        res = list(ex.map(testar, amostra))

    def taxa(l, k):
        return (sum(1 for c in l if c[k]), len(l))

    com, sem = [c for c in res if c["ref"] or c["ua"]], [c for c in res if not (c["ref"] or c["ua"])]
    linhas = []
    for nome, l in (("Com opções do VLC", com), ("Sem opções do VLC", sem), ("Total", res)):
        ck, n = taxa(l, "check")
        ab, _ = taxa(l, "abriu")
        linhas.append(f"| {nome} | {n} | {ck} | {ab} | {round(100 * ab / n) if n else 0}% |")
    motivos = {}
    for c in res:
        if not c["abriu"]:
            m = c["motivo"] if not c["check"] else "teste ok, mas não abriu: " + c["detalhe"]
            m = re.sub(r"\d{3,}", "N", m)[:70]
            motivos[m] = motivos.get(m, 0) + 1
    resumo = ["## Lista IPTV (" + LISTA + ")", "",
              f"{len(canais)} canais na lista, {len(vlc)} com opções do VLC. Amostra de {len(res)} canais testados em {round(time.time() - t0)} s.", "",
              "| Grupo | Testados | Passaram no Testar canais | Abriram (vídeo chegou) | Abrindo |", "|---|---|---|---|---|", *linhas, "",
              "**Por que não abriram:**", *[f"- {m}: {n}" for m, n in sorted(motivos.items(), key=lambda x: -x[1])], "",
              "**Exemplos que abriram:** " + ", ".join(c["nome"] for c in res if c["abriu"])[:900]]
    print("\n".join(resumo))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write("\n".join(resumo) + "\n")
    if os.environ.get("GITHUB_ACTIONS"):
        # Aviso na execução: dá para ler pela API (check-runs/annotations) sem baixar o log.
        print("::notice title=Lista IPTV::" + "%0A".join(resumo).replace("|", "¦"))
        falhas = [f"{c['nome']} | {'VLC' if (c['ref'] or c['ua']) else '-'} | {c['motivo'] if not c['check'] else c['detalhe']}" for c in res if not c["abriu"]]
        print("::notice title=Lista IPTV - nao abriram::" + "%0A".join(falhas)[:60000])
    with open("resultado-iptv.json", "w", encoding="utf-8") as f:
        json.dump({"lista": LISTA, "canais": len(canais), "vlc": len(vlc), "testados": res}, f, ensure_ascii=False, indent=1)
    ab, n = taxa(res, "abriu")
    abc, nc = taxa(com, "abriu")
    if n and ab / n < 0.25:
        print("FALHA: menos de 25% dos canais da amostra abriram")
        return 1
    if nc >= 10 and abc == 0:
        print("FALHA: nenhum canal com opções do VLC abriu (o relay pode não estar mandando referrer/user-agent)")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
