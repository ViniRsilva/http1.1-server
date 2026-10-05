# Como o servidor funciona: explicação passo a passo

Este documento ensina o projeto para quem já sabe JavaScript/Node, mas está
aprendendo Redes. A ordem segue o caminho dos bytes: do TCP até a resposta.

Arquivos citados:

| Arquivo | O que tem |
|---|---|
| `server.js` | `main`, `handleConnection`, `processBuffer`, `respond`, `handleRequest`, `shouldCloseConnection` |
| `src/httpParser.js` | `parseRequest` |
| `src/response.js` | `SERVER_NAME`, `STATUS_TEXT`, `errorResponse`, `serializeResponse` |
| `src/pathSecurity.js` | `resolveSafePath` |
| `src/fileHandler.js` | `readFileFromDisk`, `getContentType` |

---

## 1. O que é o servidor TCP

```js
const net = require('net');
```

O módulo `net` é a interface do Node com os **sockets TCP** do sistema operacional.
Ele faz, por baixo dos panos, as chamadas que o enunciado cita: `socket`, `bind`,
`listen`, `accept`, `recv` e `send`. Ele **não sabe nada de HTTP**: só entrega e
recebe bytes. Todo o HTTP fica por nossa conta.

Em `main()` (`server.js`):

```js
const server = net.createServer((socket) => handleConnection(socket, rootDir));
server.listen(port, '0.0.0.0', ...);
```

- `net.createServer(callback)` cria o servidor. O callback é chamado **uma vez para
  cada cliente que conecta**.
- `listen(port, '0.0.0.0')` corresponde ao `bind` + `listen`: reserva a porta e
  avisa o sistema operacional que aceitamos conexões nela.
  - `0.0.0.0` = "todas as interfaces de rede". Se fosse `127.0.0.1` (loopback), só a
    própria máquina conseguiria conectar, e o trabalho exige acesso de outras máquinas.
- Quando um cliente conecta, o SO faz o **three-way handshake** (SYN → SYN/ACK →
  ACK). Só depois disso o Node chama nosso callback com o `socket` pronto (é o
  `accept`).

## 2. Server vs Socket

```text
server = fica aguardando conexões (um só, na porta 8080)
socket = representa UMA conexão específica com UM cliente
```

Se três navegadores conectam, existe **1 server** e **3 sockets**. Cada socket é
identificado pela dupla (IP:porta do cliente, IP:porta do servidor). Por isso o log
mostra o cliente como `192.168.0.21:51234`: a porta do cliente diferencia duas
conexões vindas da mesma máquina.

Tudo o que é "por conexão" (buffer, flags, contador de requisições) é criado dentro
de `handleConnection(socket, rootDir)`, que roda uma vez por socket.

## 3. Buffer

O TCP entrega um **fluxo de bytes**, não mensagens. Ele garante que os bytes chegam
**na ordem e sem perdas**, mas não preserva "onde uma requisição começa e termina".
Então um evento `socket.on('data')` pode trazer:

- um pedaço de uma requisição;
- exatamente uma requisição;
- uma requisição inteira e o começo da próxima;
- várias requisições.

Exemplo real de uma requisição dividida em dois eventos `data`:

```text
data 1:  "GET /index.ht"
data 2:  "ml HTTP/1.1\r\nHost: 192.168.0.10:8080\r\n\r\n"
```

Se tratássemos cada `data` como uma requisição, o primeiro pedaço seria uma
requisição inválida (400) e o segundo também. Por isso cada socket tem o seu buffer:

```js
let buffer = Buffer.alloc(0);

socket.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);   // buffer existente + novos bytes
  processBuffer();
});
```

O buffer é **por socket** para que os bytes do cliente A nunca se misturem com os do
cliente B.

`processBuffer()` faz o *framing*, ou seja, descobre onde termina cada requisição:

1. procura `"\r\n\r\n"` no buffer (`buffer.indexOf('\r\n\r\n')`);
2. se não achou → a requisição ainda está incompleta → `break` e espera o próximo `data`;
3. se achou → tudo antes disso é a seção de headers → `parseRequest(...)`;
4. remove essa requisição do buffer: `buffer = buffer.subarray(requestLength)`;
5. **o que sobrar é preservado**: pode ser o começo (ou o todo) da próxima requisição;
6. volta ao passo 1 (é um `while`), porque o resto pode já conter outra requisição completa.

Por que `"\r\n\r\n"`? Em HTTP cada linha termina com `\r\n` (CRLF), e a seção de
headers termina com uma **linha vazia**. A última linha de header termina com
`\r\n`, e a linha vazia é só `\r\n`, então juntas formam `\r\n\r\n`. É a única
forma de saber que os headers acabaram.

Em uma requisição GET normal não existe corpo. Se o cliente mandar um corpo (ex.:
um POST com `Content-Length: 5`), `processBuffer` também espera esses 5 bytes e os
descarta (`requestLength = headerEnd + 4 + request.bodyLength`). Senão eles seriam
confundidos com o início da próxima requisição.

## 4. Parser HTTP

Pegando uma requisição real que o navegador envia:

```text
GET /index.html HTTP/1.1\r\n
Host: 192.168.0.10:8080\r\n
Connection: keep-alive\r\n
User-Agent: Mozilla/5.0 ...\r\n
\r\n
```

`processBuffer` passa para `parseRequest` (`src/httpParser.js`) o texto **antes** do
`\r\n\r\n`. O parser faz:

1. `headerText.split('\r\n')` → um array de linhas.
2. **Request line** = `lines[0]` = `"GET /index.html HTTP/1.1"`.
   `split(' ')` → `["GET", "/index.html", "HTTP/1.1"]`.
   - precisa ter exatamente 3 partes não vazias, senão → erro (400);
   - método só com letras;
   - versão `HTTP/1.0` ou `HTTP/1.1`.
3. **Headers** = as demais linhas. Para cada uma:
   - procura o primeiro `:`. **Sem `:` → erro (400)**;
   - nome = antes do `:` (sem espaços), valor = depois do `:` sem espaços nas pontas;
   - o nome é guardado em minúsculo, porque headers não diferenciam maiúsculas
     (`Connection` e `connection` são o mesmo header).
4. Se houver `Content-Length`, valida que é um número e o devolve como `bodyLength`.

Resultado:

```js
{
  method: 'GET',
  target: '/index.html',
  version: 'HTTP/1.1',
  headers: { host: '192.168.0.10:8080', connection: 'keep-alive', 'user-agent': 'Mozilla/5.0 ...' },
  bodyLength: 0,
}
```

Se algo estiver errado, o parser devolve `{ error: 'motivo' }` e `processBuffer`
chama `sendBadRequestAndClose`, que responde 400 e fecha a conexão (depois de uma
requisição malformada não dá para saber onde a próxima começa).

O texto dos headers é convertido com `toString('latin1')`, que transforma cada byte
em exatamente um caractere, sem nunca "quebrar" bytes estranhos.

## 5. Resposta HTTP

A resposta é montada à mão em `serializeResponse` (`src/response.js`):

```text
HTTP/1.1 200 OK\r\n                          <- status line
Date: Sun, 04 Oct 2026 02:30:00 GMT\r\n
Server: GrupoXX-LabRedes\r\n
Content-Type: text/html; charset=utf-8\r\n
Content-Length: 1284\r\n
\r\n                                         <- linha vazia: fim dos headers
<!DOCTYPE html>...                           <- corpo (1284 bytes)
```

- **Status line**: `HTTP/1.1 ${status} ${STATUS_TEXT[status]}`.
- **Date**: `new Date().toUTCString()` já produz o formato IMF-fixdate em GMT
  exigido pela RFC 9110.
- **Server**: a constante `SERVER_NAME`.
- **Content-Type**: vem de `getContentType` (pela extensão do arquivo).
- **Content-Length**: `response.body.length`. O corpo é sempre um `Buffer`, então
  `.length` é o número de **bytes**. Isso importa: `"ã"` é **1 caractere** mas
  **2 bytes** em UTF-8. Se usássemos o tamanho da string, o Content-Length das
  páginas com acento ficaria errado. As páginas de erro também são convertidas em
  `Buffer` (`Buffer.from(html, 'utf8')`) por esse motivo.
- **Connection: close**: só quando vamos fechar a conexão.

Os headers e o corpo são juntados em um único `Buffer` e enviados com um único
`socket.write` (ou `socket.end`).

Respostas de erro (400, 403, 404, 405, 500) são criadas por `errorResponse(status)`,
com uma pequena página HTML como corpo. O 405 recebe o header extra
`Allow: GET, HEAD`.

## 6. GET vs HEAD

- **GET** → status line + headers + **corpo**.
- **HEAD** → status line + **exatamente os mesmos headers** do GET, **sem corpo**.

No nosso código, GET e HEAD passam pelo **mesmo caminho** (`handleRequest` lê o
arquivo nos dois casos). A diferença está só em `respond`:

```js
serializeResponse(response, { sendBody: request.method !== 'HEAD', ... })
```

Como o `Content-Length` é calculado a partir do corpo **antes** de decidir se ele vai
ser enviado, no HEAD ele continua mostrando o tamanho que o corpo teria. Assim é
impossível o HEAD e o GET ficarem com headers diferentes.

Qualquer outro método (POST, PUT, DELETE...) → `405 Method Not Allowed` com
`Allow: GET, HEAD`.

## 7. Arquivos

Com `--root ./www`, o `server.js` transforma `./www` no caminho absoluto real (ex.:
`C:\Users\aluno\trabalho\www`) uma única vez, na inicialização (`parseArgs`).

Para `GET /css/style.css`:

1. `resolveSafePath(rootDir, '/css/style.css')` → `C:\Users\aluno\trabalho\www\css\style.css`
2. `readFileFromDisk(caminho)`:
   - `fs.promises.stat` → se for diretório, usa o `index.html` dele (`GET /` → `www/index.html`);
   - `fs.promises.readFile` → devolve um `Buffer` com o conteúdo;
   - arquivo não existe (`ENOENT`) → 404.
3. `getContentType` olha a extensão (`.css` → `text/css; charset=utf-8`; extensão
   desconhecida → `application/octet-stream`).

O arquivo é lido como `Buffer` (bytes), então imagens e PDFs são enviados
exatamente como estão no disco, sem nenhuma conversão de texto.

A leitura é **assíncrona** (`await fs.promises...`): enquanto o disco trabalha, o
Event Loop atende outros clientes (ver seção 9).

## 8. Segurança: directory traversal

O ataque: pedir um arquivo **fora** do `www`, usando `..` (diretório pai):

```text
GET /../../Windows/System32/drivers/etc/hosts
```

Se juntássemos isso ingenuamente com o root, sairíamos de `www`. A defesa está em
`resolveSafePath` (`src/pathSecurity.js`), passo a passo:

1. **O alvo precisa começar com `/`**, senão → 400.
2. **Remove a query string**: `/index.html?x=1` → `/index.html`.
3. **Percent-decoding** com `decodeURIComponent`:
   - `/arquivo%20teste.txt` → `/arquivo teste.txt`
   - `/%2e%2e/%2e%2e/etc/passwd` → `/../../etc/passwd` ← o ataque "escondido" aparece aqui
   - `/..%2f..%2fetc` → `/../../etc`
   - sequência inválida (`%zz`) → 400.

   Isso tem que ser feito **antes** da verificação. Se verificássemos o texto
   original, `%2e%2e` passaria despercebido.
4. **`path.join(rootDir, decodedPath)`** junta e **normaliza** o caminho,
   resolvendo os `..` como o sistema operacional faria:
   ```text
   join('/srv/www', '/../../etc/passwd')  →  '/etc/passwd'
   join('/srv/www', '/img/../index.html') →  '/srv/www/index.html'
   ```
5. **Verificação final**: o resultado precisa ser o próprio `rootDir` ou começar
   com `rootDir + separador`:
   ```js
   if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) → 403
   ```
   O separador é necessário porque, sem ele, `/srv/www-secreto` "começaria com"
   `/srv/www` e seria aceito.

Por que isso é melhor que `path.includes('../')`? Porque não tentamos adivinhar
todas as formas de escrever "subir de diretório" (`../`, `..\`, `%2e%2e/`, `..%2f`,
`%2E%2E`...). Nós deixamos o `path.join` **calcular onde o caminho realmente vai
parar** e checamos **o destino**. Qualquer variação que saia do root falha na mesma
verificação. E um `..` que continua dentro do root (`/img/../index.html`) é
permitido, porque não é perigoso.

Detalhe: decodificamos uma vez só. `%252e` vira o texto `%2e`, que é um nome de
arquivo literal, e não `.`. Então a codificação dupla não serve para atacar.

## 9. Concorrência

```text
Socket A ─┐
Socket B ─┼→ Event Loop → nossos callbacks (uma coisa de cada vez)
Socket C ─┘
```

O Node executa o nosso JavaScript em **uma única thread**. **Não existe uma thread
por socket.** Mesmo assim, ele atende vários clientes ao mesmo tempo, porque:

- o SO cuida dos sockets e avisa o Node quando chega algo ("socket B tem dados");
- o Event Loop chama o callback correspondente (`socket.on('data')` do socket B);
- o callback roda rapidinho e **devolve o controle**. Quando precisa esperar algo
  (ler um arquivo), usa `await`: a espera acontece fora da thread JavaScript, e
  enquanto isso o Event Loop atende os eventos dos outros sockets.

**Concorrência vs paralelismo:**

- *Concorrência* = várias tarefas **em andamento** ao mesmo tempo, intercaladas
  (enquanto a leitura do arquivo de A está pendente, atendemos B).
- *Paralelismo* = várias tarefas **executando** literalmente no mesmo instante, em
  núcleos diferentes.

Nosso servidor é **concorrente**: o JavaScript roda um callback por vez. (O disco e
a placa de rede trabalham em paralelo, no SO.) Como o servidor passa quase todo o
tempo esperando a rede e o disco, isso é suficiente.

**Por que evitar operações síncronas demoradas?** Se usássemos
`fs.readFileSync` dentro de uma requisição, ou um laço pesado de processamento, a
única thread JavaScript ficaria presa ali, e **todos** os outros clientes
esperariam, mesmo que já tivessem dados prontos. Por isso:

- arquivos são lidos com `fs.promises` (`readFileFromDisk`);
- as únicas chamadas síncronas (`fs.realpathSync`, `fs.statSync`) estão em
  `parseArgs`, na inicialização, **antes** de aceitar conexões.

Um cliente lento (ex.: manda metade da requisição e para) também não atrapalha: o
buffer dele só fica esperando; não há nenhum laço "parado" esperando por ele.

**Ordem das respostas na mesma conexão:** se chegam duas requisições juntas no mesmo
socket, a segunda só é tratada depois de a primeira ser respondida. A flag `busy` em
`processBuffer` garante isso: se chegarem bytes enquanto esperamos a leitura de um
arquivo, eles só entram no buffer, e o laço que já está rodando os processa na
próxima volta.

## 10. Keep-alive (conexão persistente)

Abrir uma conexão TCP custa um handshake (SYN, SYN/ACK, ACK) = **1 RTT** antes de
poder mandar a requisição, e fechar custa mais pacotes (FIN/ACK). Uma página com
HTML + CSS + JS + imagem precisaria de 4 conexões se cada requisição usasse uma nova.

No HTTP/1.1 a conexão é **persistente por padrão**: depois de responder, o servidor
**não fecha** o socket e espera a próxima requisição. Em `respond`:

```js
if (close) { closing = true; socket.end(bytes); }
else       { socket.write(bytes); }       // mantém o socket aberto
```

Como o buffer guarda o que sobrou e `processBuffer` é um laço, a mesma conexão
atende quantas requisições vierem:

```text
TCP connection (um handshake só)
  GET /index.html  ← 200 OK
  GET /style.css   ← 200 OK
  GET /imagem.png  ← 200 OK
```

O teste C2 (`tests/c1c2.js c2`) mostra isso: as 10 requisições usam a mesma porta
local, ou seja, a mesma conexão TCP.

## 11. Connection: close

O cliente pede o encerramento enviando o header `Connection: close`.
`shouldCloseConnection(request)` detecta isso (e também fecha para HTTP/1.0). Então
o servidor:

1. processa a requisição normalmente;
2. coloca `Connection: close` na resposta (`serializeResponse` com `closeConnection: true`);
3. chama `socket.end(bytes)`: o Node **escreve a resposta inteira e só depois** envia
   o FIN. Por isso a conexão nunca é fechada antes de a resposta sair;
4. marca `closing = true`, e qualquer byte que chegar depois disso é ignorado.

No Wireshark, depois da resposta aparece o FIN do servidor, seguido do FIN do
cliente.

O cenário C1 (`tests/c1c2.js c1`) usa isso: 10 requisições = 10 conexões = 10
handshakes.

## 12. Timeout

Com conexões persistentes, um cliente pode abrir uma conexão e simplesmente não usar
mais (um navegador numa aba esquecida, por exemplo). Cada conexão aberta ocupa um
socket e memória no servidor. Então fechamos as ociosas:

```js
socket.setTimeout(IDLE_TIMEOUT_MS);   // 5000 ms
socket.on('timeout', () => { closing = true; socket.end(); });
```

`setTimeout` do socket conta o tempo **sem tráfego**: qualquer byte lido ou escrito
reinicia a contagem. Se passar 5 s sem nada, o Node emite `'timeout'` e nós
encerramos normalmente (`end()` → FIN). No log aparece
`timeout: 5000 ms sem atividade, encerrando conexão`.

## 13. Fluxo completo

```text
Chrome digita http://192.168.0.10:8080/index.html
  ↓
TCP handshake (SYN → SYN/ACK → ACK)
  ↓
socket criado            net.createServer → handleConnection(socket)   [log: conexão aberta]
  ↓
bytes chegam             socket.on('data') → buffer = Buffer.concat([buffer, chunk])
  ↓
buffer                   processBuffer()
  ↓
\r\n\r\n encontrado      buffer.indexOf('\r\n\r\n')
  ↓
parser HTTP              parseRequest(headerText)
  ↓
GET /index.html          { method: 'GET', target: '/index.html', ... }  [log: requisição]
  ↓
método permitido?        handleRequest → senão 405
  ↓
validação do path        resolveSafePath → 400 / 403 ou caminho seguro
  ↓
leitura do arquivo       await readFileFromDisk → 404 ou Buffer com o conteúdo
  ↓
HTTP/1.1 200 OK          serializeResponse (status line + headers + corpo)
  ↓
socket.write             respond() → write (keep-alive) ou end (close)  [log: resposta]
  ↓
TCP                      o SO divide em segmentos, envia e o cliente confirma com ACK
  ↓
Chrome                   renderiza, vê <link href="style.css"> e <img src="imagem.png">
                         e pede esses recursos reaproveitando a conexão aberta (keep-alive).
                         Obs.: o navegador pode abrir mais algumas conexões em paralelo
                         para baixar recursos ao mesmo tempo; o log mostra quantas.
  ↓
5 s sem requisições      'timeout' → socket.end() → FIN   [log: conexão encerrada]
```
