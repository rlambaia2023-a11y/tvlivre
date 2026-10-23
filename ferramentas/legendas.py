#!/usr/bin/env python3
"""Levantamento de legendas: confere em cada canal da lista se a transmissão já traz legenda.

Para cada canal, abre a lista HLS (mestre e variante) e procura:
  - legendas anunciadas na lista (EXT-X-MEDIA TYPE=SUBTITLES ou CLOSED-CAPTIONS), com o idioma;
  - legenda oculta embutida no vídeo (CEA-608/708), procurando a marca "GA94" no primeiro pedaço;
  - o idioma do áudio, quando a lista informa.
Grava o resultado em listas/legendas.json e um resumo no log da execução.
Uso: python3 ferramentas/legendas.py listas/canais.json listas/legendas.json
"""
import json
import os
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin, urlparse

UA = "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0 Safari/537.36"
IP_BR = "200.160.2.3"
ATTR = re.compile(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)')


def baixar(url, ref="", ua="", limite=None):
    h = {"User-Agent": ua or UA, "Accept": "*/*", "Accept-Encoding": "identity"}
    if ref:
        h["Referer"] = ref
    host = urlparse(url).hostname or ""
    if re.search(r"pluto\.tv$|plutotv\.net$|jmp2\.uk$", host):
        h["X-Forwarded-For"] = IP_BR
    if limite:
        h["Range"] = "bytes=0-%d" % (limite - 1)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=12) as r:
        dados = r.read(limite) if limite else r.read(3_000_000)
        return r.geturl(), dados


def attrs(linha):
    return {k: v.strip('"') for k, v in ATTR.findall(linha.split(":", 1)[1])}


def primeira_url(texto):
    for l in texto.splitlines():
        l = l.strip()
        if l and not l.startswith("#"):
            return l
    return None


def examinar(canal):
    links = [{"url": canal["url"], "ref": canal.get("ref", ""), "ua": canal.get("ua", "")}] + canal.get("alts", [])[:2]
    res = {"id": canal["id"], "nome": canal["name"], "grupo": canal["group"], "legendas": [], "audio": [], "cc608": None}
    ultimo_erro = ""
    for l in links:
        try:
            final, dados = baixar(l["url"], l.get("ref", ""), l.get("ua", ""))
            texto = dados.decode("utf-8", "replace").lstrip("﻿")
            if not texto.lstrip().startswith("#EXTM3U"):
                ultimo_erro = "não é HLS"
                continue
            midia, base = texto, final
            if "#EXT-X-STREAM-INF" in texto:
                for linha in texto.splitlines():
                    if linha.startswith("#EXT-X-MEDIA:"):
                        a = attrs(linha)
                        tipo = a.get("TYPE", "")
                        if tipo in ("SUBTITLES", "CLOSED-CAPTIONS"):
                            res["legendas"].append({"tipo": tipo, "idioma": a.get("LANGUAGE", "?"), "nome": a.get("NAME", "")})
                        elif tipo == "AUDIO":
                            res["audio"].append(a.get("LANGUAGE", "?"))
                v = primeira_url(texto)
                if v:
                    base, d2 = baixar(urljoin(final, v), l.get("ref", ""), l.get("ua", ""))
                    midia = d2.decode("utf-8", "replace")
            seg = primeira_url(midia)
            if "#EXT-X-KEY:METHOD=AES" in midia:
                res["cc608"] = None
                res["obs"] = "vídeo criptografado, não deu para olhar dentro"
            elif seg:
                _, pedaco = baixar(urljoin(base, seg), l.get("ref", ""), l.get("ua", ""), limite=1_500_000)
                res["cc608"] = b"GA94\x03" in pedaco
            res["link"] = urlparse(l["url"]).hostname
            return res
        except Exception as e:  # noqa: BLE001
            ultimo_erro = type(e).__name__ + ": " + str(e)[:120]
    res["erro"] = ultimo_erro or "sem resposta"
    return res


def main():
    entrada, saida = sys.argv[1], sys.argv[2]
    canais = json.load(open(entrada, encoding="utf-8"))["canais"]
    with ThreadPoolExecutor(16) as ex:
        resultados = list(ex.map(examinar, canais))
    json.dump({"total": len(resultados), "canais": resultados}, open(saida, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    com_lista = [r for r in resultados if r["legendas"]]
    com_608 = [r for r in resultados if r["cc608"]]
    com_qualquer = [r for r in resultados if r["legendas"] or r["cc608"]]
    erros = [r for r in resultados if r.get("erro")]
    linhas = [
        "# Levantamento de legendas",
        "",
        "- Canais conferidos: %d" % len(resultados),
        "- Com alguma legenda: %d" % len(com_qualquer),
        "- Legenda anunciada na lista: %d" % len(com_lista),
        "- Legenda oculta embutida no vídeo (CEA-608): %d" % len(com_608),
        "- Não abriram daqui: %d" % len(erros),
        "",
        "| Canal | Grupo | Legendas | Embutida | Áudio |",
        "|---|---|---|---|---|",
    ]
    for r in sorted(com_qualquer, key=lambda x: x["grupo"]):
        leg = ", ".join("%s %s" % (x["tipo"][:3].lower(), x["idioma"]) for x in r["legendas"]) or "-"
        linhas.append("| %s | %s | %s | %s | %s |" % (r["nome"], r["grupo"], leg, "sim" if r["cc608"] else "-", ", ".join(r["audio"]) or "-"))
    resumo = "\n".join(linhas) + "\n"
    print(resumo)
    caminho = os.environ.get("GITHUB_STEP_SUMMARY")
    if caminho:
        open(caminho, "a", encoding="utf-8").write(resumo)


if __name__ == "__main__":
    main()
