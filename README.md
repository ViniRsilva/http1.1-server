# Trabalho 1 — Servidor HTTP/1.1 sobre sockets TCP

Servidor HTTP/1.1 escrito em Node.js **diretamente sobre sockets TCP** (módulo `net`).
O parsing das requisições e a montagem das respostas HTTP são feitos pelo próprio
código do grupo: nada de `http`, `https`, Express ou qualquer biblioteca HTTP.

## Requisitos

- **Node.js 18 ou superior** (testado com o Node 24). Não há dependências externas
  e não é preciso rodar `npm install`.

## Execução

```bash
node server.js --port 8080 --root ./www
```

Ao iniciar, o servidor mostra os endereços IP da máquina, para que seja acessado de
outros computadores (ex.: `http://192.168.0.10:8080/`).

> No Windows, talvez seja preciso liberar a porta no firewall na primeira execução.

## Argumentos

| Argumento | Obrigatório | Descrição |
|---|---|---|
| `--port <n>` | sim | Porta TCP onde o servidor escuta. Deve estar entre 1025 e 65535. |
| `--root <dir>` | sim | Diretório com os arquivos servidos. Nenhum arquivo fora dele é servido. |

O servidor escuta em `0.0.0.0` (todas as interfaces), e não só em `127.0.0.1`,
para poder ser acessado por outras máquinas da rede.

Configurações fixas no código:

| Constante | Arquivo | Valor |
|---|---|---|
| `SERVER_NAME` (header `Server`) | `src/response.js` | `GrupoXX-LabRedes`: **trocar pelo nome do grupo** |
| `IDLE_TIMEOUT_MS` | `server.js` | `5000` (5 s) |
| `MAX_HEADER_BYTES` | `server.js` | `65536` |

## Estrutura

```text
server.js            TCP, buffer por conexão, fluxo de cada requisição, keep-alive, timeout
src/httpParser.js    parseRequest: request line + headers
src/response.js      errorResponse e serializeResponse: monta os bytes da resposta HTTP
src/pathSecurity.js  resolveSafePath: URL -> caminho do arquivo + proteção contra traversal
src/fileHandler.js   readFileFromDisk (leitura assíncrona) e getContentType
www/                 site de teste (index.html, style.css, script.js, imagem.png, dados.json...)
tests/run-tests.js   testes automáticos (npm test)
tests/raw.js         envia bytes "crus" (testes de 400 e traversal)
tests/c1c2.js        cliente que reproduz os cenários C1 e C2 da Parte 2
docs/                material de estudo (EXPLICACAO.md, PERGUNTAS_APRESENTACAO.md)
```

## Arquitetura

```text
net.createServer     -> aceita a conexão TCP e entrega um socket por cliente
buffer do socket     -> acumula os bytes até achar "\r\n\r\n" (framing do HTTP)
parseRequest         -> request line + headers  ->  { method, target, version, headers }
handleRequest        -> 405? -> resolveSafePath (400/403) -> readFileFromDisk (404/200)
serializeResponse    -> "HTTP/1.1 200 OK\r\n" + headers + "\r\n" + corpo (sem corpo no HEAD)
socket.write / end   -> bytes voltam pelo TCP (end = responde e fecha)
```

## Concorrência

Foi adotado **I/O não bloqueante orientado a eventos**, que é o modelo nativo do Node.js.

- Não existe uma thread por conexão. Cada cliente tem o seu próprio socket (e o seu
  próprio buffer), e os eventos de todos os sockets são tratados pelo **Event Loop**.
- Toda operação que espera algo de fora (rede, disco) é assíncrona: a leitura de
  arquivos usa `fs.promises`. Enquanto um arquivo é lido, o Event Loop continua
  atendendo os outros clientes.
- Um cliente lento (que manda a requisição aos poucos ou para no meio) só ocupa o
  buffer dele e não bloqueia ninguém.

Justificativa: o servidor passa quase todo o tempo **esperando I/O**, e não calculando.
Para esse tipo de carga, um único Event Loop atende muitas conexões sem o custo de
criar threads e sem os problemas de sincronização entre threads.

## Testes

### Testes automáticos

```bash
npm test               # ou: node tests/run-tests.js
node tests/run-tests.js --log   # mostra também o log do servidor
```

Sobem o servidor na porta 18081 e verificam: 200, HEAD, 400, 403, 404, 405,
Content-Type, Content-Length, arquivo binário, percent-encoding, requisições
fragmentadas (inclusive byte a byte), várias requisições no mesmo pacote,
keep-alive, `Connection: close`, timeout, clientes simultâneos e cliente que derruba
a conexão.

### Testes manuais com curl

Troque `IP` pelo endereço do servidor. No **PowerShell** use `curl.exe` (no Windows
PowerShell, `curl` sozinho é um apelido de outro comando).

```bash
# 200 OK
curl -v http://IP:8080/index.html

# HEAD: mesmos headers do GET, sem corpo
curl -I http://IP:8080/index.html

# 404 Not Found
curl -v http://IP:8080/nao-existe.html

# 405 Method Not Allowed (com Allow: GET, HEAD)
curl -v -X POST http://IP:8080/index.html

# Percent-encoding (%20 = espaço): 200 OK
curl -v "http://IP:8080/arquivo%20teste.txt"

# Connection: close: a resposta traz "Connection: close" e o servidor fecha a conexão
curl -v -H "Connection: close" http://IP:8080/index.html

# Keep-alive: várias URLs no mesmo comando reutilizam a MESMA conexão.
# No -v aparece "Reusing existing ... connection". Um -o por URL (no Windows use NUL em vez de /dev/null).
curl -v http://IP:8080/index.html http://IP:8080/style.css http://IP:8080/imagem.png -o /dev/null -o /dev/null -o /dev/null
```

### 400 Bad Request

O curl sempre gera HTTP válido, então usamos o `tests/raw.js`, que envia os bytes
exatamente como escritos (`\r\n` no texto vira CR LF de verdade):

```bash
# request line sem a versão
node tests/raw.js IP 8080 "GET /index.html\r\n\r\n"

# header sem ":"
node tests/raw.js IP 8080 "GET /index.html HTTP/1.1\r\nHeaderSemDoisPontos\r\n\r\n"
```

Truque com curl: um método com espaço gera uma request line com 4 partes:

```bash
curl -v -X "GET /x" http://IP:8080/index.html   # envia "GET /x /index.html HTTP/1.1"
```

Em Linux também dá para usar netcat: `printf 'GET /\r\n\r\n' | nc IP 8080`.

### 403 Forbidden: directory traversal

**Cuidado:** por padrão o curl (e o navegador) **resolve os `..` antes de enviar**.
`curl http://IP:8080/../../etc/passwd` vira `GET /etc/passwd` e o servidor responde
404, porque a tentativa de traversal nem chega até ele. Até `%2e%2e` é normalizado
pelo curl. Por isso usamos `--path-as-is`, que envia o caminho exatamente como
escrito:

```bash
# 1. ".." simples
curl -v --path-as-is http://IP:8080/../../etc/passwd

# 2. exemplo do enunciado
curl -v --path-as-is http://IP:8080/../../Windows/System32/drivers/etc/hosts

# 3. percent-encoded: %2e%2e = ".."
curl -v --path-as-is "http://IP:8080/%2e%2e/%2e%2e/etc/passwd"

# 4. barra codificada: %2f = "/"
curl -v "http://IP:8080/..%2f..%2f..%2fetc%2fpasswd"

# 5. entrando em uma pasta e saindo dela
curl -v --path-as-is http://IP:8080/imagens/../../../etc/passwd
```

As mesmas tentativas com `tests/raw.js`, sem depender do comportamento do curl:

```bash
node tests/raw.js IP 8080 "GET /../../etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
node tests/raw.js IP 8080 "GET /%2e%2e/%2e%2e/etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
node tests/raw.js IP 8080 "GET /..%2f..%2fetc%2fpasswd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
```

O servidor também registra no log a requisição exatamente como chegou (`requisição:
GET /%2e%2e/...`), o que comprova que a tentativa chegou sem ser normalizada.

### Atendimento simultâneo

Abra o navegador em duas máquinas ao mesmo tempo (ou rode o curl em duas máquinas).
O log mostra conexões de IPs diferentes abertas e sendo atendidas intercaladas:

```text
[03:29:15.805] [192.168.0.21:51234] conexão aberta
[03:29:15.806] [192.168.0.35:49811] conexão aberta
[03:29:15.807] [192.168.0.21:51234] requisição: GET /index.html HTTP/1.1
[03:29:15.807] [192.168.0.35:49811] requisição: GET /index.html HTTP/1.1
...
```

Para deixar uma conexão "parada" e mostrar que ela não bloqueia as outras, envie uma
requisição incompleta e, enquanto isso, acesse o servidor de outra máquina:

```bash
node -e "require('net').connect(8080,'IP').write('GET / HTTP/1.1\r\nHo')"
```

### Cenários C1 e C2 (Parte 2)

Com o Wireshark capturando (`tcp.port == 8080`), rode **na máquina cliente**:

```bash
node tests/c1c2.js c1 IP 8080 /index.html   # 10 conexões, uma por requisição (Connection: close)
node tests/c1c2.js c2 IP 8080 /index.html   # 1 conexão persistente para as 10 requisições
```

O script imprime a porta local de cada requisição: em C1 a porta muda a cada vez
(uma conexão TCP nova), e em C2 ela é sempre a mesma.

Antes de medir, registre o RTT: `ping IP`.

No Wireshark, contar os handshakes com o filtro
`tcp.port == 8080 && tcp.flags.syn == 1 && tcp.flags.ack == 0`
e usar *Statistics → Conversations* (ou *Capture File Properties*) para pacotes, bytes
e tempo total.

## Decisões de implementação

Pontos que o enunciado não define, resolvidos da forma mais simples:

- **Diretório → `index.html`:** `GET /` (ou qualquer diretório) serve o `index.html` de dentro dele.
- **Query string é ignorada:** `/index.html?x=1` serve `/index.html`.
- **Percent-encoding é decodificado uma única vez:** `%252e` vira o texto `%2e` (não `.`), então não serve para traversal.
- **400 fecha a conexão:** depois de uma requisição malformada não dá para saber onde começa a próxima no fluxo de bytes.
- **Corpo de requisição:** se vier `Content-Length` (ex.: num POST), os bytes do corpo são lidos e descartados, para não serem confundidos com a próxima requisição. `Transfer-Encoding` não é suportado: o servidor responde e fecha a conexão.
- **HTTP/1.0:** aceito; o servidor fecha a conexão depois da resposta (o padrão do 1.0 é não persistir).
- **Headers maiores que 64 KB:** 400 e a conexão é fechada.
- **500 Internal Server Error:** usado só se a leitura de um arquivo falhar por um motivo inesperado. Arquivo sem permissão de leitura gera 403.
- **Content-Type:** tipos de texto incluem `charset=utf-8` (ex.: `text/html; charset=utf-8`), para o navegador mostrar os acentos corretamente.
- **Uma escrita por resposta:** headers e corpo são juntados em um único `Buffer` antes do `socket.write`, o que deixa a captura no Wireshark mais fácil de ler.
- **Links simbólicos:** o `--root` é resolvido com `realpath`. Links simbólicos criados *dentro* do `www/` pelo dono do servidor não são verificados.
- **Linhas terminadas só com `\n`:** não são aceitas como fim dos headers; o servidor espera `\r\n\r\n` (como pede o enunciado) e, se isso não chegar, a conexão cai no timeout.
