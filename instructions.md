# Trabalho 1 — Servidor HTTP/1.1 sobre sockets TCP

## 1. Contexto

Este projeto é um trabalho acadêmico da disciplina de Laboratório de Redes de Computadores.

O objetivo é implementar um servidor HTTP/1.1 diretamente sobre sockets TCP, sem utilizar frameworks ou bibliotecas que implementem HTTP do lado servidor.

O foco acadêmico do trabalho é compreender:

- sockets TCP;
- comunicação cliente-servidor;
- HTTP/1.1;
- parsing manual de mensagens HTTP;
- TCP como fluxo de bytes;
- conexões persistentes;
- concorrência;
- impacto do RTT;
- custo de abertura e fechamento de conexões TCP;
- observação do comportamento através do Wireshark.

O código será posteriormente estudado e apresentado pelos integrantes ao professor. Portanto, a prioridade NÃO é criar a solução mais sofisticada possível.

A prioridade é:

1. corretude;
2. aderência ao enunciado;
3. simplicidade;
4. legibilidade;
5. facilidade de explicação.

Evite abstrações desnecessárias, arquiteturas excessivamente complexas e soluções "mágicas".

---

# 2. Stack definida

Utilizar:

- Node.js;
- JavaScript;
- módulos nativos do Node.js;
- módulo `net` para TCP;
- APIs nativas para arquivos, paths, datas etc.;
- I/O assíncrono sempre que apropriado.

Não utilizar TypeScript.

Não utilizar frameworks.

O servidor TCP deve ser criado utilizando:

```js
const net = require('net');
```

O módulo `net` será a interface entre nossa aplicação e os sockets TCP fornecidos pelo sistema operacional.

---

# 3. PROIBIÇÕES IMPORTANTES

NÃO utilizar:

- Express;
- Fastify;
- Koa;
- NestJS;
- `http.createServer`;
- módulo `http` para implementar o servidor;
- `https`;
- qualquer biblioteca que faça parsing HTTP;
- qualquer biblioteca que gere automaticamente respostas HTTP;
- qualquer framework web.

O objetivo é que o grupo implemente manualmente a camada HTTP.

O Node.js pode cuidar do TCP através do módulo `net`.

O Node NÃO deve cuidar do HTTP por nós.

A separação conceitual deve ser:

```text
Nosso código HTTP
        ↓
Node.js net
        ↓
Socket TCP
        ↓
Sistema operacional
        ↓
TCP/IP
```

---

# 4. Modelo de concorrência

Utilizar o modelo natural do Node.js:

**I/O não bloqueante orientado a eventos através do Event Loop.**

Não criar uma thread para cada conexão.

Cada cliente conectado terá seu próprio socket TCP, mas os callbacks JavaScript serão processados pelo Event Loop.

Exemplo conceitual:

```text
Cliente A → Socket A ─┐
Cliente B → Socket B ─┼→ Event Loop → JavaScript
Cliente C → Socket C ─┘
```

Uma conexão lenta não pode impedir que outras conexões sejam atendidas.

Por isso:

- evitar operações síncronas demoradas;
- utilizar leitura assíncrona de arquivos;
- não realizar processamento pesado dentro dos callbacks;
- não utilizar loops de espera;
- não bloquear deliberadamente a thread principal.

Essa decisão será posteriormente justificada no relatório como estratégia de concorrência.

---

# 5. Inicialização do servidor

O servidor deve receber, no mínimo:

```bash
node server.js --port 8080 --root ./www
```

Os argumentos obrigatórios são:

- `--port`: porta TCP utilizada;
- `--root`: diretório raiz dos arquivos servidos.

A porta deve ser superior a 1024.

O servidor deve escutar em:

```text
0.0.0.0
```

e NÃO somente em:

```text
127.0.0.1
```

Isso é necessário porque outras máquinas da rede deverão acessar o servidor.

Exemplo conceitual:

```js
server.listen(port, '0.0.0.0');
```

Validar os argumentos de entrada e apresentar uma mensagem clara caso estejam ausentes ou inválidos.

---

# 6. TCP e recebimento dos dados

Utilizar `net.createServer()` para criar o servidor TCP.

Cada conexão deve fornecer um socket próprio.

Os dados recebidos através do evento:

```js
socket.on('data', ...)
```

chegam como bytes representados por um `Buffer`.

IMPORTANTE:

TCP é um fluxo de bytes.

NÃO assumir que cada evento `data` corresponde exatamente a uma requisição HTTP.

Pode ocorrer:

```text
data 1:
GET /index.ht

data 2:
ml HTTP/1.1\r\nHost: ...
```

Também pode ocorrer:

```text
data 1:

GET /a HTTP/1.1
...
\r\n\r\n
GET /b HTTP/1.1
...
```

Ou seja, um único bloco recebido pode conter:

- parte de uma requisição;
- exatamente uma requisição;
- uma requisição inteira e parte da próxima;
- potencialmente múltiplas requisições.

---

# 7. Buffer por conexão

Cada socket deve possuir seu próprio buffer de recebimento.

Exemplo conceitual:

```text
Socket A
bufferA

Socket B
bufferB

Socket C
bufferC
```

Quando novos bytes chegarem:

```text
buffer existente + novos bytes
```

O código deve procurar o marcador de término dos headers HTTP:

```text
\r\n\r\n
```

Enquanto esse marcador não existir, continuar acumulando bytes.

Quando existir:

1. separar a requisição completa;
2. remover seus bytes do buffer;
3. processar a requisição;
4. preservar quaisquer bytes restantes;
5. verificar se o restante já contém outra requisição completa.

Isso é especialmente importante para conexões persistentes.

Não implementar o parser assumindo:

```js
cada socket.on('data') === uma request
```

Isso estaria conceitualmente errado.

---

# 8. Parsing manual HTTP

O parser HTTP deve ser implementado pelo projeto.

Interpretar manualmente:

### Request line

Formato:

```text
METHOD request-target HTTP/version
```

Exemplo:

```text
GET /index.html HTTP/1.1
```

Extrair:

```text
method = GET
target = /index.html
version = HTTP/1.1
```

### Headers

Interpretar linhas como:

```text
Host: 192.168.1.10:8080
Connection: keep-alive
User-Agent: curl/...
```

Separar corretamente:

```text
nome: valor
```

Um header sem `:` deve fazer a requisição ser considerada malformada.

O terminador de linha HTTP deve ser:

```text
\r\n
```

O final da seção de headers deve ser:

```text
\r\n\r\n
```

---

# 9. Percent-encoding

O caminho solicitado deve suportar percent-encoding.

Exemplo:

```text
/arquivo%20teste.txt
```

deve representar:

```text
/arquivo teste.txt
```

Isso também é extremamente importante para as verificações de segurança.

Não confiar apenas no caminho original antes da decodificação.

---

# 10. Métodos HTTP obrigatórios

Implementar:

## GET

Deve retornar:

- status line;
- headers;
- corpo do recurso.

## HEAD

Deve gerar exatamente os headers que o GET correspondente geraria, porém sem enviar o corpo.

Exemplo:

GET:

```http
HTTP/1.1 200 OK
Content-Length: 100
Content-Type: text/html
...

[100 bytes de body]
```

HEAD:

```http
HTTP/1.1 200 OK
Content-Length: 100
Content-Type: text/html
...
```

Nenhum body deve ser enviado.

O `Content-Length` do HEAD continua sendo o tamanho que o body teria caso fosse um GET.

## Outros métodos

Qualquer método diferente de GET e HEAD deve retornar:

```text
405 Method Not Allowed
```

e incluir:

```text
Allow: GET, HEAD
```

---

# 11. Status HTTP obrigatórios

Implementar corretamente:

```text
200 OK
400 Bad Request
403 Forbidden
404 Not Found
405 Method Not Allowed
```

### 200

Recurso encontrado e requisição válida.

### 400

Requisição HTTP malformada.

Exemplos:

- request line inválida;
- header sem `:`;
- estrutura inválida.

### 403

Tentativa de acessar algo fora do diretório raiz.

### 404

Arquivo solicitado não existe.

### 405

Método diferente de GET ou HEAD.

---

# 12. Headers obrigatórios nas respostas

Toda resposta deve possuir:

```text
HTTP/1.1 <status>
Content-Length: ...
Content-Type: ...
Date: ...
Server: ...
```

Outros headers necessários podem ser adicionados conforme o comportamento de conexão.

## Content-Length

Deve representar o tamanho correto do body em BYTES.

Também deve estar correto:

- nas respostas de erro;
- nas respostas HEAD.

Não utilizar simplesmente o número de caracteres da string quando isso puder diferir do número de bytes.

## Content-Type

Determinar a partir da extensão.

Suportar no mínimo:

```text
.html → text/html
.css
.js
.json
.txt
.png
.jpg
.pdf
```

Utilizar MIME types apropriados.

Extensões desconhecidas:

```text
application/octet-stream
```

## Date

Utilizar IMF-fixdate em GMT, conforme HTTP.

Exemplo:

```text
Date: Sun, 04 Oct 2026 02:30:00 GMT
```

Utilizar uma API nativa de data caso ela produza corretamente o formato esperado.

## Server

Adicionar um identificador do grupo.

Centralizar esse identificador em uma constante facilmente editável.

Exemplo conceitual:

```js
const SERVER_NAME = 'GrupoXX';
```

---

# 13. Arquivos

O servidor deve servir arquivos existentes dentro do diretório configurado por:

```text
--root
```

Exemplo:

```bash
node server.js --port 8080 --root ./www
```

Para:

```text
GET /index.html
```

o servidor procurará algo equivalente a:

```text
./www/index.html
```

Criar uma pequena pasta `www/` para testes.

Ela deve possuir pelo menos:

- `index.html`;
- CSS;
- JavaScript simples;
- uma imagem ou outro recurso.

O `index.html` deve referenciar pelo menos um recurso adicional para permitir o teste do navegador realizando múltiplas requisições.

---

# 14. Segurança — Directory Traversal

Este requisito é crítico.

O servidor JAMAIS pode servir um arquivo localizado fora do diretório `--root`.

Ataques como:

```text
GET /../../arquivo
```

devem retornar:

```text
403 Forbidden
```

Também proteger contra variações utilizando percent-encoding.

Exemplo conceitual:

```text
/%2e%2e/%2e%2e/...
```

O caminho deve ser:

1. interpretado;
2. percent-decoded;
3. normalizado/resolvido de maneira segura;
4. validado contra o diretório raiz real.

Não utilizar apenas uma verificação ingênua de substring como:

```js
path.includes('../')
```

porque isso pode ser contornado.

Criar uma função clara e isolada para resolver e validar o caminho.

Precisaremos posteriormente demonstrar três tentativas diferentes de traversal, sendo pelo menos uma utilizando percent-encoding.

---

# 15. Conexões persistentes HTTP/1.1

HTTP/1.1 utiliza conexões persistentes por padrão.

Portanto, depois de responder uma requisição, NÃO fechar automaticamente o socket.

Exemplo:

```text
TCP connection

GET /index.html
← 200 OK

GET /style.css
← 200 OK

GET /imagem.png
← 200 OK
```

Tudo pode acontecer utilizando a mesma conexão TCP.

---

# 16. Connection: close

Se o cliente enviar:

```text
Connection: close
```

o servidor deve:

1. processar normalmente a requisição;
2. incluir o mesmo header na resposta:

```text
Connection: close
```

3. enviar completamente a resposta;
4. encerrar a conexão TCP.

Não encerrar antes de garantir que a resposta foi enviada corretamente.

---

# 17. Timeout de conexão ociosa

Implementar timeout para conexão TCP ociosa.

Utilizar inicialmente:

```text
5 segundos
```

Caso nenhuma nova atividade relevante ocorra durante esse período, encerrar a conexão.

O código deve deixar o valor configurável através de uma constante.

Exemplo:

```js
const IDLE_TIMEOUT_MS = 5000;
```

---

# 18. Múltiplas requisições na mesma conexão

Uma única conexão deve conseguir processar:

```text
Request 1
Request 2
Request 3
...
```

Isso precisa funcionar mesmo quando diferentes requests chegarem agrupados dentro dos mesmos dados TCP.

O buffer de cada conexão deve preservar corretamente os bytes que pertencem à próxima request.

---

# 19. Concorrência

O servidor deve conseguir manter múltiplas conexões TCP simultaneamente.

Exemplo:

```text
PC A ───────────┐
                │
PC B ───────────┼── servidor
                │
PC C ───────────┘
```

Utilizar a arquitetura assíncrona do Node.js.

Não utilizar APIs síncronas de arquivo dentro do processamento das requests se isso puder bloquear o Event Loop.

A implementação deverá permitir demonstrar duas máquinas requisitando o servidor ao mesmo tempo.

Adicionar logs simples que ajudem a demonstrar isso.

Por exemplo, registrar:

- endereço do cliente;
- conexão aberta;
- request recebida;
- recurso solicitado;
- resposta;
- conexão encerrada.

Não criar um sistema complexo de logging.

---

# 20. Erros de socket

Tratar de maneira simples e segura:

```text
socket error
connection reset
timeout
cliente desconectando
erro durante leitura de arquivo
```

Um problema em uma conexão não deve derrubar o servidor inteiro.

---

# 21. Wireshark e observabilidade

A aplicação deve ser fácil de observar no Wireshark.

Será utilizado filtro semelhante a:

```text
tcp.port == 8080
```

Precisaremos posteriormente identificar:

- SYN;
- SYN/ACK;
- ACK;
- requisição HTTP;
- resposta HTTP;
- encerramento TCP.

Evitar comportamentos desnecessários que dificultem interpretar as capturas.

---

# 22. Testes necessários

Preparar comandos `curl` reproduzíveis para validar pelo menos:

### GET válido

```bash
curl -v http://IP:8080/index.html
```

### HEAD

```bash
curl -I http://IP:8080/index.html
```

### 404

Solicitar recurso inexistente.

### 405

Enviar método não permitido.

Exemplo:

```bash
curl -v -X POST http://IP:8080/index.html
```

### 400

Criar uma requisição deliberadamente malformada.

Como `curl` normalmente gera HTTP válido, explicar uma maneira simples de enviar bytes manualmente para gerar essa condição.

### 403

Realizar tentativas de directory traversal.

Criar pelo menos três exemplos distintos, incluindo pelo menos um percent-encoded.

CUIDADO: ferramentas como `curl` podem normalizar URLs. Documentar como executar o teste preservando o path necessário para que o servidor realmente receba a tentativa de traversal.

---

# 23. Teste de persistência

Precisaremos comparar:

## C1

10 requisições sequenciais utilizando uma nova conexão TCP para cada requisição.

Utilizar:

```text
Connection: close
```

## C2

10 requisições sequenciais utilizando uma única conexão TCP persistente.

O objetivo posterior será comparar no Wireshark:

- quantidade de handshakes TCP completos;
- número total de pacotes;
- quantidade total de bytes;
- tempo total.

Não é necessário automatizar toda a análise do Wireshark dentro do servidor.

Porém, se for criado um pequeno script cliente auxiliar para reproduzir exatamente C1 e C2, mantenha-o separado do servidor, extremamente simples e documentado.

O servidor continua sendo a entrega principal.

---

# 24. Estrutura desejada do projeto

Preferir uma estrutura pequena.

Algo semelhante a:

```text
projeto/
│
├── server.js
├── src/
│   ├── httpParser.js
│   ├── response.js
│   ├── fileHandler.js
│   └── pathSecurity.js
│
├── www/
│   ├── index.html
│   ├── style.css
│   └── ...
│
├── tests/
│   └── ...
│
└── README.md
```

Essa estrutura é apenas uma orientação.

Se quatro módulos forem desnecessários, simplifique.

NÃO transformar o trabalho em uma arquitetura empresarial.

Não utilizar:

- dependency injection;
- repositories;
- services sem necessidade;
- controllers artificiais;
- factories desnecessárias;
- design patterns apenas por estética.

Queremos conseguir abrir o projeto e seguir facilmente:

```text
TCP
 ↓
buffer
 ↓
parser
 ↓
request
 ↓
arquivo
 ↓
response
 ↓
TCP
```

---

# 25. Comentários no código

Adicionar comentários apenas onde eles ajudam a explicar conceitos importantes.

Principalmente:

- por que existe um buffer por socket;
- por que procuramos `\r\n\r\n`;
- por que não podemos assumir uma request por evento `data`;
- como directory traversal é impedido;
- diferença entre GET e HEAD;
- quando o socket permanece aberto;
- quando o socket é encerrado;
- funcionamento do timeout.

Evitar comentários óbvios como:

```js
// cria uma variável
const port = 8080;
```

---

# 26. README

Criar README explicando:

## Requisitos

Versão necessária do Node.js.

## Execução

Exemplo:

```bash
node server.js --port 8080 --root ./www
```

## Argumentos

Explicar `--port` e `--root`.

## Arquitetura

Explicação curta:

```text
net → TCP
buffer → framing HTTP
parser → request
filesystem → recurso
response builder → HTTP
socket → resposta
```

## Concorrência

Explicar que foi adotado:

```text
I/O não bloqueante orientado a eventos
```

através do modelo do Node.js.

## Testes

Colocar comandos para reproduzir:

- 200;
- HEAD;
- 400;
- 403;
- 404;
- 405;
- Connection close;
- keep-alive;
- traversal.

---

# 27. Requisitos para facilitar o estudo posterior

Este requisito é extremamente importante.

Depois da implementação, criar:

```text
docs/EXPLICACAO.md
```

Esse documento deve ensinar o projeto para alguém que conhece JavaScript/Node, mas ainda está aprendendo Redes.

Explicar, na ordem:

## 1. O que é o servidor TCP

Explicar:

```js
const net = require('net');
```

`net.createServer`, socket e `listen`.

## 2. Server vs Socket

Explicar claramente:

```text
server = fica aguardando conexões

socket = representa uma conexão específica com um cliente
```

## 3. Buffer

Explicar que TCP entrega fluxo de bytes e não mensagens HTTP prontas.

Mostrar exemplo de uma request dividida em dois eventos `data`.

## 4. Parser HTTP

Pegar uma request real:

```text
GET /index.html HTTP/1.1
Host: ...
Connection: keep-alive
```

e demonstrar como nosso código interpreta cada parte.

## 5. Resposta HTTP

Mostrar como:

```text
HTTP/1.1 200 OK
...
```

é construída manualmente.

## 6. GET vs HEAD

Explicar a diferença.

## 7. Arquivos

Explicar como URL vira caminho dentro de `www`.

## 8. Segurança

Explicar passo a passo como o código impede directory traversal.

## 9. Concorrência

Explicar:

```text
Socket A ─┐
Socket B ─┼→ Event Loop
Socket C ─┘
```

Explicar que não existe uma thread JavaScript dedicada para cada socket.

Explicar concorrência vs paralelismo.

Explicar por que operações síncronas demoradas poderiam bloquear os outros clientes.

## 10. Keep-alive

Explicar por que HTTP/1.1 mantém a conexão aberta e como nosso código suporta várias requests dentro do mesmo socket.

## 11. Connection close

Explicar como o cliente solicita o encerramento.

## 12. Timeout

Explicar o motivo do timeout.

## 13. Fluxo completo

Finalizar com um exemplo:

```text
Chrome
  ↓
TCP handshake
  ↓
socket criado
  ↓
bytes chegam
  ↓
buffer
  ↓
\r\n\r\n encontrado
  ↓
parser HTTP
  ↓
GET /index.html
  ↓
validação do path
  ↓
leitura do arquivo
  ↓
HTTP/1.1 200 OK
  ↓
socket.write
  ↓
TCP
  ↓
Chrome
```

---

# 28. Perguntas para apresentação

Criar também:

```text
docs/PERGUNTAS_APRESENTACAO.md
```

Preparar perguntas e respostas sobre o próprio projeto.

No mínimo:

1. Por que usamos `net`?
2. Por que não usamos o módulo `http`?
3. O que é um socket?
4. O que `listen()` faz?
5. O que acontece quando um cliente conecta?
6. O TCP entrega uma requisição inteira?
7. Por que existe um buffer por conexão?
8. O que significa `\r\n\r\n`?
9. Como identificamos GET?
10. Como HEAD funciona?
11. Como calculamos Content-Length?
12. Como Content-Type é determinado?
13. Como impedimos directory traversal?
14. O que acontece com `%2e%2e`?
15. Como o servidor atende dois clientes?
16. O Node cria uma thread para cada conexão?
17. O que é Event Loop?
18. O que aconteceria se fizéssemos processamento síncrono pesado?
19. O que é conexão HTTP persistente?
20. Por que ela melhora desempenho?
21. Qual a relação disso com RTT?
22. O que é o TCP three-way handshake?
23. Por que C1 terá mais handshakes que C2?
24. O que `Connection: close` faz?
25. Por que existe timeout?

As respostas devem ser relacionadas especificamente à implementação criada, mencionando funções/arquivos reais quando apropriado.

---

# 29. Qualidade do código

Antes de considerar a implementação pronta:

- revisar possíveis race conditions lógicas;
- revisar manipulação dos buffers;
- revisar requests concatenadas;
- revisar requests fragmentadas;
- revisar Content-Length;
- revisar HEAD;
- revisar Connection: close;
- revisar timeout;
- revisar segurança de paths;
- revisar arquivos binários;
- revisar erros de socket;
- revisar arquivos inexistentes;
- testar múltiplos clientes.

Não mascarar bugs através de try/catch gigantes.

Erros devem ser tratados próximos do local apropriado.

---

# 30. NÃO inventar requisitos

A implementação deve seguir os requisitos descritos neste documento.

Caso alguma decisão não esteja definida aqui:

1. escolher a solução mais simples;
2. documentar a decisão;
3. não adicionar funcionalidades HTTP desnecessárias.

Não tentar implementar toda a RFC HTTP/1.1.

Este é um trabalho acadêmico limitado aos requisitos especificados.

---

# 31. Processo de implementação solicitado

Não gere tudo de forma desorganizada.

Implemente incrementalmente nesta ordem:

### Etapa 1 — TCP
Servidor TCP mínimo usando `net`.

### Etapa 2 — Buffer
Recepção e acumulação correta dos bytes.

### Etapa 3 — Parser
Request line + headers.

### Etapa 4 — Resposta HTTP mínima
Conseguir responder manualmente um HTTP válido.

### Etapa 5 — GET
Servir arquivos.

### Etapa 6 — HEAD

### Etapa 7 — Status de erro
400, 403, 404 e 405.

### Etapa 8 — Content-Type e headers obrigatórios

### Etapa 9 — Segurança
Directory traversal + percent-encoding.

### Etapa 10 — Persistência
Múltiplas requests por socket.

### Etapa 11 — Connection: close

### Etapa 12 — Timeout

### Etapa 13 — Concorrência
Validar múltiplos clientes.

### Etapa 14 — Testes

### Etapa 15 — README e documentação de estudo.

A cada etapa, manter o servidor executável e testável.

---

# 32. Critério final

A solução estará pronta quando pudermos demonstrar claramente:

```text
Navegador
   ↓
TCP
   ↓
nosso socket
   ↓
nosso parser HTTP
   ↓
nosso tratamento
   ↓
nossa resposta HTTP
   ↓
TCP
   ↓
Navegador
```

sem qualquer framework ou implementação pronta de servidor HTTP.

O código precisa ser suficientemente simples para que um estudante consiga estudar cada parte e explicar ao professor como os bytes recebidos através de TCP se transformam em uma requisição HTTP e como a resposta percorre o caminho inverso.