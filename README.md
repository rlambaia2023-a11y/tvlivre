# Tela Livre: HRC & DV

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

## Armazenamento (Railway Bucket)

A última lista testada fica guardada no bucket **tela-livre-dados** do Railway (`canais.json` e `lista.m3u`). Quando o servidor reinicia, ele carrega a lista do bucket na hora, e a TV nunca abre vazia. As variáveis `S3_*` do serviço apontam para o bucket.

## Quando um canal falha

1. A TV tenta o link direto, depois pelo servidor, depois os links reserva do mesmo canal.
2. O servidor tenta de novo se identificando como VLC ou Kodi, que muitas emissoras exigem.
3. Se nada abrir, a TV mostra o motivo e pula para o próximo canal em 5 segundos.
4. O servidor reconfere aquele canal na hora e, se estiver fora do ar mesmo, tira da lista para todo mundo.

## Endereços do servidor

| Endereço | O que devolve |
|---|---|
| `/` | A TV |
| `/lista.m3u` | Lista para o Kodi (PVR IPTV Simple Client), VLC e outros players |
| `/canais` | Lista em JSON, usada pela própria TV |
| `/check?u=<link>` | Testa um link de transmissão |
| `/falhou?id=<canal>` | A TV avisa que o canal não abriu; o servidor reconfere |
| `/epg` | Guia "Agora / A seguir" dos canais do Pluto TV (próximos 3 programas de cada canal) |
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

## Guardião do Pluto TV

- Os links do Pluto trazem uma chave que vence em poucas horas. O servidor busca links novos a cada hora (`pluto_renovado` nos logs).
- Canal Pluto nunca sai da lista por falha. Se a fonte do Pluto cair, os canais de antes continuam.
- Cada canal Pluto tem um link reserva pelo `jmp2.uk/plu-<id>.m3u8`, que abre a sessão do Pluto na hora e não depende de chave.
- Quando um canal Pluto não abre na TV, o servidor renova a lista do Pluto na hora em vez de apagar o canal.
- `.github/workflows/guardiao.yml` confere a TV a cada hora (servidor, lista e canais Pluto). Se algo estiver fora, pede uma atualização e o GitHub manda um e-mail.

## Gerador próprio do Pluto TV

- Mesmo método do projeto NasiLemakk/Pluto-TV-Playlists. O servidor pede uma sessão nova em `boot.pluto.tv` se apresentando como um aparelho no Brasil (cabeçalho `X-Forwarded-For` com o IP de `PLUTO_IP_BR`). Depois monta os links com a chave do dia. O log registra o evento `pluto_gerado`, com o país que o Pluto reconheceu.
- A lista gerada se junta às listas do OwnerPlugins e do BuddyChewChew/pluto (`pluto_br.m3u`, refeita a cada 6 horas). Se uma falhar, as outras seguram.
- Para cada canal, o gerador monta também o endereço alternativo `ipv4.pluto.tv/api/tn/...` com qualidade fixa em 720p (método do BuddyChewChew), que trava menos com internet fraca.
- Os pedidos do relay ao Pluto e ao jmp2.uk também levam o cabeçalho do Brasil.
- A organização github.com/pluto-tv (Pluto-tv) tem só bibliotecas internas antigas, sem listas de canais, e por isso não foi usada.

## Estabilidade do player e do servidor (padrão de streaming)

- O player guarda até 30 s de vídeo de folga (até 60 s quando sobra memória) e fica um pouco atrás do "ao vivo", o que evita travadas. A qualidade se ajusta sozinha à internet e ao tamanho da tela, e o player tenta de novo várias vezes antes de desistir.
- Se a rede cair no meio de um canal, o player retoma do ponto onde parou. Se o vídeo der erro de imagem, ele se recupera até duas vezes sem trocar de link.
- Um vigia confere o vídeo a cada 2,5 s. Com 10 s parado, tenta destravar. Com 25 s parado, passa para o próximo link do canal.
- Quando a página se atualiza durante uma troca de canal, ela volta direto no canal escolhido.
- No Railway, o serviço não entra em modo de espera, reinicia sozinho se cair (política ALWAYS), passa pela checagem `/health` a cada publicação e mantém a versão antiga no ar por 20 s durante a troca de versão.

## Recursos de uso (inspirados em apps de streaming)

Ideias tiradas da análise do app YouCine (v1.17.6) e reescritas do zero aqui. Do app só veio a ideia de como usar; nenhum código, link ou fonte de vídeo dele entrou no Tela Livre.

- **Favoritos**: botão amarelo (ou F no teclado) num canal da grade ou durante o canal. Aparece o filtro "★ Favoritos".
- **Continuar assistindo e Recentes**: o botão "Continuar" leva ao último canal visto, e o filtro "Recentes" guarda os 12 últimos.
- **Canal anterior**: botão vermelho (ou P) volta ao canal que estava passando antes.
- **Lista de canais por cima do vídeo**: ← (ou verde / L) durante o canal. Mostra o que está passando agora nos canais do Pluto.
- **Opções do canal**: → (ou azul / O). Qualidade máxima (a TV continua descendo sozinha se a internet piorar), áudio e legenda quando o canal tiver, favorito e bloqueio.
- **Bloqueio parental**: senha de 4 números em Ajustes. Com senha, canais de conteúdo adulto ficam trancados e qualquer outro canal pode ser trancado pelo menu de opções. A senha fica guardada só nesta TV.
- **Guia Agora / A seguir**: o servidor busca a grade do Pluto TV a cada 30 minutos (`guia_atualizado` nos logs). Aparece no cartão do canal, na barra do player e na lista.
