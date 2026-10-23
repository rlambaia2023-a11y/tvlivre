#!/usr/bin/env python3
"""Monta listas/webcams.json com câmeras ao vivo públicas do YouTube.

Os links de transmissão do YouTube mudam quando a câmera reinicia, então este script roda
de tempos em tempos (GitHub Actions), procura transmissões ao vivo de câmeras por tema,
confere se o vídeo aceita ser incorporado em outra página e grava a lista.
Se encontrar pouca coisa (YouTube fora do ar, por exemplo), mantém a lista anterior.

Uso: python3 ferramentas/webcams.py listas/webcams.json
"""
import json, re, sys, time, urllib.request, urllib.parse, urllib.error
from datetime import datetime, timezone

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"

GRUPOS = [
    ("brasil", "Brasil", ["câmera ao vivo praia", "webcam ao vivo brasil", "câmera ao vivo rio de janeiro",
                          "balneário camboriú ao vivo câmera", "florianópolis câmera ao vivo",
                          "são paulo câmera ao vivo", "câmera ao vivo cidade brasil", "praia ao vivo agora",
                          "aeroporto guarulhos ao vivo", "porto de santos ao vivo", "trem ao vivo brasil"]),
    ("praias", "Praias do mundo", ["beach live cam", "hawaii beach live cam", "caribbean beach live cam"]),
    ("cidades", "Cidades do mundo", ["times square live cam", "shibuya live camera", "venice live cam",
                                     "paris live cam", "london live cam", "tokyo live camera",
                                     "dublin live cam", "las vegas live cam", "new york live cam"]),
    ("natureza", "Natureza e animais", ["africam live", "explore.org live cam", "zoo live cam", "panda live cam",
                                        "aquarium live cam", "bird feeder live cam", "waterhole live cam"]),
    ("ceu", "Céu e espaço", ["iss live earth from space", "northern lights live cam", "volcano live cam"]),
    ("transportes", "Aeroportos, trens e portos", ["airport live cam", "train live cam", "port ship live cam"]),
]

PRECISA = re.compile(r"cam|câm|camera|webcam|ao vivo|live view|24/7|panorama|from space|earth", re.I)
FORA = re.compile(r"not[ií]cia|news|jornal|m[uú]sica|music|lo-?fi|r[aá]dio\b|radio|gam(e|ing)|jogo|futebol|football|soccer|"
                  r"\bmatch\b|bingo|cassino|casino|\bbet\b|aposta|igreja|church|culto|missa|ora[cç][aã]o|prayer|"
                  r"bikini|biqu[ií]ni|sexy|hot girl|girls|asmr|podcast|q&a|fortnite|minecraft|roblox|gta|"
                  r"trading|crypto|bitcoin|forex|sorteio|pagode|samba|sertanejo|funk|forr[oó]|\bshow\b|\bdj\b|playlist|karaok", re.I)
# No grupo Brasil só entra o que tem cara de Brasil (o YouTube mistura câmeras do mundo todo na busca).
BRASIL = re.compile(r"brasil|brazil|🇧🇷|rio de janeiro|copacabana|ipanema|leblon|barra da|s[aã]o paulo|\bsp\b|santos|"
                    r"guaruj|ubatuba|santa catarina|florian[oó]polis|cambori[uú]|itaja[ií]|bombinhas|cabo frio|arraial|"
                    r"b[uú]zios|niter[oó]i|bahia|salvador|porto seguro|recife|fortaleza|natal|macei[oó]|curitiba|"
                    r"foz do igua|gramado|porto alegre|belo horizonte|bras[ií]lia|manaus|bel[eé]m|guarapari|ilhabela|"
                    r"praia grande|guarulhos|sbgr|congonhas|viracopos|ao vivo|câmera|\bpraia", re.I)
# Além de ter cara de Brasil, precisa ter cara de câmera (senão entram canais de TV que transmitem "ao vivo 24 horas").
CAMERA_BR = re.compile(r"cam|c[aâ]mera|webcam|praia|aeroporto|airport|porto|trem|rodovia|estrada|tempo real|vista|ao vivo", re.I)
TV_BR = re.compile(r"\btv\b|rede ?vida|novo tempo|can[c]?ão nova|canal|programa|jornal|telejornal|ora[cç][aã]o|ter[cç]o|santa missa", re.I)
SO_NO_GRUPO = {"brasil": BRASIL}
FORA_SEMPRE = re.compile(r"rel[oó]gio|clock|hora certa", re.I)
POR_GRUPO = 18


def get(u, timeout=30):
    r = urllib.request.Request(u, headers={"user-agent": UA, "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
                                           "cookie": "CONSENT=YES+1; SOCS=CAI"})
    return urllib.request.urlopen(r, timeout=timeout).read().decode("utf-8", "replace")


def videos(o, out):
    if isinstance(o, dict):
        if "videoRenderer" in o:
            v = o["videoRenderer"]
            marcas = json.dumps(v.get("badges", [])) + json.dumps(v.get("thumbnailOverlays", []))
            titulo = "".join(x.get("text", "") for x in v.get("title", {}).get("runs", []))
            dono = (v.get("ownerText", {}).get("runs") or [{}])[0]
            vistos = json.dumps(v.get("viewCountText", {}), ensure_ascii=False)
            n = re.sub(r"\D", "", vistos.split('"text": "')[1] if '"text": "' in vistos else "") or "0"
            out.append({"v": v.get("videoId"), "t": titulo.strip(), "ch": dono.get("text", ""),
                        "ao_vivo": "LIVE" in marcas, "n": int(n[:9])})
        for x in o.values():
            videos(x, out)
    elif isinstance(o, list):
        for x in o:
            videos(x, out)


def buscar(q):
    # sp=EgJAAQ== é o filtro "Ao vivo" da busca do YouTube
    h = get("https://www.youtube.com/results?search_query=" + urllib.parse.quote(q) + "&sp=EgJAAQ%253D%253D")
    m = re.search(r"var ytInitialData = (\{.*?\});</script>", h)
    out = []
    if m:
        videos(json.loads(m.group(1)), out)
    return out


def incorporavel(v):
    try:
        get("https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote("https://www.youtube.com/watch?v=" + v), 15)
        return True
    except urllib.error.HTTPError:
        return False
    except Exception:
        return True  # na dúvida, deixa entrar; a TV mostra aviso se não abrir


def main(destino):
    vistos, grupos, total = set(), [], 0
    for gid, nome, consultas in GRUPOS:
        achados = []
        for q in consultas:
            try:
                achados += buscar(q)
            except Exception as e:
                print(f"busca falhou: {q}: {e}", file=sys.stderr)
            time.sleep(1)
        bons = []
        for x in sorted(achados, key=lambda x: -x["n"]):
            if not x["v"] or x["v"] in vistos or not x["ao_vivo"]:
                continue
            if not PRECISA.search(x["t"]) or FORA.search(x["t"]) or FORA.search(x["ch"]) or FORA_SEMPRE.search(x["t"]):
                continue
            exige = SO_NO_GRUPO.get(gid)
            if exige and not exige.search(x["t"] + " " + x["ch"]):
                continue
            if gid == "brasil" and (not CAMERA_BR.search(x["t"]) or TV_BR.search(x["t"] + " " + x["ch"])):
                continue
            vistos.add(x["v"])
            if not incorporavel(x["v"]):
                continue
            bons.append({"v": x["v"], "t": re.sub(r"\s+", " ", x["t"])[:110], "ch": x["ch"][:60]})
            if len(bons) >= POR_GRUPO:
                break
        print(f"{nome}: {len(bons)} câmeras")
        total += len(bons)
        if bons:
            grupos.append({"id": gid, "nome": nome, "cams": bons})
    if total < 10:
        print(f"Só {total} câmeras encontradas; mantendo a lista anterior.")
        return
    dados = {"atualizado": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "fonte": "Transmissões ao vivo públicas do YouTube", "grupos": grupos}
    with open(destino, "w", encoding="utf-8") as f:
        json.dump(dados, f, ensure_ascii=False, indent=1)
    print(f"Gravado {destino}: {total} câmeras")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "listas/webcams.json")
