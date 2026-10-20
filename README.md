# Tela Livre

A TV própria que roda no navegador da Smart TV, com os canais abertos do Brasil já carregados.

**No ar em:** https://tela-livre-production.up.railway.app

## O que tem aqui

| Arquivo | Para que serve |
|---|---|
| `index.html` | A tela da TV: grade de canais, player, navegação pelo controle remoto e ajustes |
| `server.ts` | O servidor (Bun): monta e testa a lista de canais, faz o relay das transmissões e entrega a lista para o Kodi |
| `listas/tvlivre.m3u` | A lista de canais testada, atualizada sozinha a cada 6 horas |
| `listas/canais.json` | A mesma lista em JSON, com os links reserva de cada canal |
| `.github/workflows/atualizar-lista.yml` | A rotina que confere se a TV está no ar e atualiza as listas |

## Como a lista se mantém viva

1. O servidor baixa as listas públicas do [iptv-org](https://github.com/iptv-org/iptv) (Brasil), do [Free-TV](https://github.com/Free-TV/IPTV) e do [Pluto TV Brasil](https://github.com/OwnerPlugins/pluto-tv-m3u).
2. Testa cada link, junta os links repetidos do mesmo canal e guarda os que funcionam como reserva.
3. Refaz tudo a cada 6 horas, mesmo sem ninguém assistindo.
4. A rotina do GitHub copia a lista testada para a pasta `listas/` a cada 6 horas. Se a TV estiver fora do ar, a rotina falha e o GitHub avisa você por e-mail.

## Endereços do servidor

| Endereço | O que devolve |
|---|---|
| `/` | A TV |
| `/lista.m3u` | Lista para o Kodi (PVR IPTV Simple Client), VLC e outros players |
| `/canais` | Lista em JSON, usada pela própria TV |
| `/check?u=<link>` | Testa um link de transmissão |
| `/health` | Responde `ok` quando o servidor está de pé |

## Rodar no seu computador

Precisa do [Bun](https://bun.sh).

```sh
bun run start
```

Depois abra http://localhost:3000.

## Usar no Kodi

Configurações > Add-ons > Instalar do repositório > Clientes PVR > **PVR IPTV Simple Client** > Configurar > Geral. Em "URL da lista M3U", cole:

```
https://tela-livre-production.up.railway.app/lista.m3u
```

## Sobre os canais

Só entram canais que as emissoras transmitem de graça pela internet, a partir das listas públicas acima. Canais pagos ficam de fora; para eles, use a sua assinatura IPTV em **Ajustes > Lista IPTV**.

## Pluto TV, Samsung TV Plus e Plex no Kodi (SlyGuy)

Os add-ons do [SlyGuy](https://github.com/matthuisman/slyguy.addons) só rodam dentro do Kodi, então não entram na lista web. Para usar no Kodi:

1. Baixe o `repository.slyguy.zip` (site oficial k.slyguy.xyz).
2. No Kodi: Configurações > Sistema > Add-ons > ative **Fontes desconhecidas**.
3. Add-ons > Instalar de arquivo zip > escolha o `repository.slyguy.zip`.
4. Add-ons > Instalar do repositório > **SlyGuy Repository** > Add-ons de vídeo > instale Pluto TV, Samsung TV Plus ou Plex Live.
