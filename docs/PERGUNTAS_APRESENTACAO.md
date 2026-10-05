# Perguntas e respostas para a apresentação

Respostas curtas, ligadas ao nosso código. Para os detalhes, ver `docs/EXPLICACAO.md`.

---

### 1. Por que usamos `net`?

Porque o enunciado exige usar a API de sockets TCP diretamente. O `net` é a interface
do Node com os sockets do sistema operacional (`socket`, `bind`, `listen`, `accept`,
`recv`, `send`). Ele só transporta **bytes**: aceita conexões e entrega o que chega.
Todo o HTTP (parsing e resposta) é código nosso. Em `server.js`: `net.createServer`
em `main()`.

### 2. Por que não usamos o módulo `http`?

Porque o `http` **implementa HTTP do lado servidor**: ele faria o parsing da
requisição, montaria os headers, cuidaria do keep-alive, etc. O enunciado proíbe
isso. O objetivo é o grupo implementar essa camada: o parsing está em
`src/httpParser.js` (`parseRequest`) e a resposta em `src/response.js`
(`serializeResponse`).

### 3. O que é um socket?

É a "ponta" de uma conexão de rede, usada pelo programa para enviar e receber
bytes. Uma conexão TCP é identificada por IP e porta do cliente + IP e porta do
servidor. No nosso código, cada `socket` recebido em `handleConnection(socket,
rootDir)` representa **uma conexão com um cliente**.

### 4. O que `listen()` faz?

`server.listen(port, '0.0.0.0')` associa o servidor à porta (bind) e o coloca no
estado de escuta: o SO passa a aceitar handshakes TCP nessa porta e a entregar as
novas conexões ao Node. Usamos `0.0.0.0` para escutar em todas as interfaces, e não
só no loopback (`127.0.0.1`); senão outras máquinas não conseguiriam conectar.

### 5. O que acontece quando um cliente conecta?

O SO faz o three-way handshake (SYN, SYN/ACK, ACK). Depois disso o Node chama o
callback do `net.createServer`, que chama `handleConnection(socket, rootDir)`. Lá
criamos o buffer daquela conexão, configuramos o timeout (`socket.setTimeout`),
registramos os eventos `data`, `timeout`, `error` e `close`, e logamos `conexão
aberta`.

### 6. O TCP entrega uma requisição inteira?

Não. O TCP entrega um **fluxo de bytes** ordenado, sem marcar onde as mensagens
começam ou terminam. Um evento `data` pode ter meia requisição, uma inteira, ou uma
e o começo da próxima. Nosso teste `Requisição enviada 1 byte por vez`
(`tests/run-tests.js`) mostra que o servidor funciona mesmo recebendo um byte por vez.

### 7. Por que existe um buffer por conexão?

Para acumular os bytes até ter uma requisição completa e guardar as sobras para a
próxima. Ele é **por conexão** (a variável `buffer` criada dentro de
`handleConnection`) para que os bytes de clientes diferentes nunca se misturem: o
pedaço de requisição do cliente A não pode ser juntado com os bytes do cliente B.

### 8. O que significa `\r\n\r\n`?

`\r\n` (CRLF) é o fim de linha do HTTP. A seção de headers termina com uma linha
vazia. Então o `\r\n` que termina o último header, seguido do `\r\n` da linha vazia,
forma `\r\n\r\n`. Em `processBuffer` fazemos `buffer.indexOf('\r\n\r\n')`: enquanto
não aparece, a requisição está incompleta e esperamos mais bytes.

### 9. Como identificamos GET?

`parseRequest` separa a primeira linha (request line) por espaços:
`"GET /index.html HTTP/1.1"` → `method = 'GET'`, `target = '/index.html'`,
`version = 'HTTP/1.1'`. Depois, em `handleRequest`, se `method` não for `GET` nem
`HEAD`, respondemos 405 com `Allow: GET, HEAD`.

### 10. Como HEAD funciona?

O HEAD passa exatamente pelo mesmo caminho do GET em `handleRequest` (inclusive lê o
arquivo). A única diferença é em `respond`: `serializeResponse(response, { sendBody:
request.method !== 'HEAD' })`. Os headers são idênticos, inclusive o
`Content-Length`, que mostra o tamanho que o corpo teria. Só os bytes do corpo não
são enviados.

### 11. Como calculamos Content-Length?

Em `serializeResponse`: `'Content-Length': response.body.length`. O corpo é sempre um
`Buffer` (o arquivo lido com `fs.promises.readFile`, ou a página de erro convertida
com `Buffer.from(html, 'utf8')`), então `.length` é o tamanho em **bytes**. Não
usamos o tamanho da string porque um caractere como `ã` ocupa 2 bytes em UTF-8.

### 12. Como Content-Type é determinado?

Pela extensão do arquivo, em `getContentType` (`src/fileHandler.js`): uma tabela
`MIME_TYPES` (`.html` → `text/html`, `.png` → `image/png`, `.pdf` →
`application/pdf`...). Extensão desconhecida → `application/octet-stream`.

### 13. Como impedimos directory traversal?

Em `resolveSafePath` (`src/pathSecurity.js`):

1. decodificamos o percent-encoding (`decodeURIComponent`);
2. juntamos com o root usando `path.join`, que **normaliza** e resolve os `..`;
3. conferimos se o caminho final é o root ou começa com `rootDir + path.sep`. Se não
   for → 403.

Não procuramos `"../"` no texto: verificamos **onde o caminho realmente vai parar**.
Assim qualquer forma de escrever "subir de diretório" é pega.

### 14. O que acontece com `%2e%2e`?

`%2e` é o código do caractere `.`. O passo de decodificação transforma
`/%2e%2e/%2e%2e/etc/passwd` em `/../../etc/passwd` **antes** da verificação. Depois o
`path.join` resolve para fora do root e a checagem devolve 403. Se verificássemos
antes de decodificar, o ataque passaria. Atenção na demonstração: o curl normaliza
até o `%2e%2e`, então é preciso usar `curl --path-as-is` ou o `tests/raw.js`.

### 15. Como o servidor atende dois clientes?

Cada cliente tem o seu socket e o seu buffer (`handleConnection` roda uma vez por
conexão). O Event Loop entrega os eventos de cada socket ao callback correspondente.
Como nada no tratamento bloqueia (a leitura de arquivo é `await
fs.promises.readFile`), enquanto um espera o disco, o outro é atendido. O log mostra
as linhas dos dois IPs intercaladas.

### 16. O Node cria uma thread para cada conexão?

Não. O nosso JavaScript roda em **uma única thread**, e todos os sockets são
atendidos pelo Event Loop. (Internamente o Node usa algumas threads auxiliares para
operações de disco, mas não uma por conexão, e o nosso código nunca roda em paralelo
consigo mesmo.)

### 17. O que é Event Loop?

É o laço do Node que fica esperando eventos (dados chegando num socket, leitura de
arquivo terminada, timeout...) e, para cada um, executa o callback registrado. Um
callback por vez, até o fim. Se cada callback for rápido e as esperas forem
assíncronas (`await`), um único laço atende muitas conexões.

### 18. O que aconteceria se fizéssemos processamento síncrono pesado?

A única thread JavaScript ficaria presa nele, e o Event Loop não conseguiria
chamar nenhum outro callback: **todos os clientes parariam**, até os que já
tivessem dados prontos. Por exemplo, trocar `fs.promises.readFile` por
`fs.readFileSync` num arquivo grande faria todos esperarem a leitura daquele
arquivo. Por isso só usamos funções síncronas em `parseArgs`, antes de aceitar
conexões.

### 19. O que é conexão HTTP persistente?

É reaproveitar a **mesma conexão TCP** para várias requisições/respostas, em vez de
abrir uma conexão nova a cada requisição. É o padrão do HTTP/1.1. No nosso código,
depois de responder, `respond` usa `socket.write` (não fecha), e o laço de
`processBuffer` continua tratando as próximas requisições que chegarem no mesmo
buffer.

### 20. Por que ela melhora desempenho?

Porque evita, a cada requisição:

- o three-way handshake (3 pacotes e 1 RTT de espera antes de enviar a requisição);
- o encerramento (FIN/ACK nos dois sentidos, normalmente 4 pacotes);
- recomeçar o controle de congestionamento do TCP (*slow start*) do zero.

Menos pacotes, menos bytes e menos tempo. É isso que a comparação C1 × C2 mede.

### 21. Qual a relação disso com RTT?

Cada conexão nova custa pelo menos **1 RTT extra** (o handshake) antes de a
requisição poder ser enviada. Uma requisição em conexão nova leva ~2 RTT (handshake
+ requisição/resposta); numa conexão já aberta, ~1 RTT. Em C1, com 10 conexões, são
~10 RTTs a mais que em C2 (cerca de 9 a mais, já que C2 também faz um handshake).
Quanto maior o RTT (ex.: servidor distante, Wi-Fi ruim, rede móvel), maior a
diferença em tempo absoluto. Em localhost o RTT é quase zero, por isso o trabalho
mede entre máquinas diferentes.

### 22. O que é o TCP three-way handshake?

É a abertura de uma conexão TCP:

1. cliente → servidor: **SYN** (quero conectar, meu número de sequência inicial é X);
2. servidor → cliente: **SYN/ACK** (aceito, o meu é Y, confirmo X+1);
3. cliente → servidor: **ACK** (confirmo Y+1).

Só depois disso o cliente envia a requisição HTTP. No nosso código o handshake é
feito pelo SO; o Node só chama `handleConnection` quando ele termina.

### 23. Por que C1 terá mais handshakes que C2?

Em C1 cada requisição usa `Connection: close`: o servidor responde e fecha
(`socket.end(bytes)` em `respond`), então a próxima requisição precisa de uma
conexão nova = um handshake novo. São **10 handshakes** (e 10 encerramentos). Em C2
as 10 requisições usam o mesmo socket: **1 handshake** e 1 encerramento.
`tests/c1c2.js` mostra isso pela porta local: em C1 ela muda a cada requisição, em
C2 é sempre a mesma.

### 24. O que `Connection: close` faz?

É o cliente avisando "depois desta resposta, feche a conexão". Em
`shouldCloseConnection` detectamos o header. O servidor responde normalmente,
inclui `Connection: close` na resposta e chama `socket.end(bytes)`, que **envia a
resposta inteira e só depois o FIN**. Bytes que chegarem depois disso são
ignorados (`closing = true`).

### 25. Por que existe timeout?

Porque com conexões persistentes um cliente pode deixar a conexão aberta sem usar,
ocupando um socket e memória do servidor indefinidamente. Com
`socket.setTimeout(IDLE_TIMEOUT_MS)` (5 s), se não houver tráfego nenhum nesse
período, o evento `'timeout'` dispara e fechamos com `socket.end()`. Qualquer byte
recebido ou enviado reinicia a contagem.

---

## Perguntas extras que podem aparecer

**Por que a conexão é fechada depois de um 400?**
Porque, se a requisição está malformada, não dá para confiar em onde ela termina no
fluxo de bytes, e continuar poderia interpretar lixo como a próxima requisição.
`sendBadRequestAndClose` responde e fecha.

**E se chegarem duas requisições juntas? As respostas podem sair fora de ordem?**
Não. A flag `busy` em `processBuffer` garante que só um laço processa o buffer daquele
socket, e cada requisição só é tratada depois de a anterior ter sido respondida
(`await respond(request)`).

**O que acontece se o cliente cair no meio (RST)?**
O socket emite `'error'` (ex.: `ECONNRESET`), que é tratado no listener de `error`
de `handleConnection` (só loga), e depois `'close'`. Se ainda estávamos lendo o
arquivo, `respond` verifica `socket.writable` e não tenta escrever. Os outros
clientes não são afetados.

**Por que `toString('latin1')` nos headers?**
Porque o latin1 converte cada byte em exatamente um caractere, sem nunca falhar. Os
headers HTTP são ASCII; o `%` encoding é que carrega caracteres especiais no
caminho, e ele é decodificado depois, com `decodeURIComponent`.

**Por que `/x/../index.html` retorna 200 e não 403?**
Porque o destino final continua dentro do `www`. A regra não é "proibir `..`", é
"proibir sair do root".

**Por que o curl normal não serve para testar traversal?**
O curl (e o navegador) resolvem os `..` no cliente antes de enviar, então o servidor
recebe só `/etc/passwd` e responde 404, porque o ataque nem chega até ele. Com
`--path-as-is` o curl envia o caminho exatamente como escrito.
