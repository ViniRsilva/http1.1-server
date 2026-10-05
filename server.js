// Trabalho 1 — Servidor HTTP/1.1 sobre sockets TCP
//
// Uso: node server.js --port 8080 --root ./www
//
// Caminho de uma requisição neste arquivo:
//   TCP (net) -> buffer do socket -> parseRequest -> handleRequest
//   -> serializeResponse -> socket.write -> TCP

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseRequest } = require('./src/httpParser');
const { STATUS_TEXT, errorResponse, serializeResponse } = require('./src/response');
const { resolveSafePath } = require('./src/pathSecurity');
const { getContentType, readFileFromDisk } = require('./src/fileHandler');

// Tempo máximo que uma conexão pode ficar sem tráfego antes de ser fechada.
const IDLE_TIMEOUT_MS = 5000;

// Se o cliente mandar mais que isso sem terminar os headers, desistimos (400).
// Evita que um cliente encha a memória do servidor.
const MAX_HEADER_BYTES = 64 * 1024;

function log(client, message) {
  const time = new Date().toISOString().slice(11, 23);
  console.log(`[${time}] [${client}] ${message}`);
}

// ---------------------------------------------------------------------------
// Argumentos de linha de comando
// ---------------------------------------------------------------------------

function exitWithUsage(message) {
  console.error(`Erro: ${message}`);
  console.error('Uso: node server.js --port <porta> --root <diretório>');
  console.error('Exemplo: node server.js --port 8080 --root ./www');
  process.exit(1);
}

function parseArgs(argv) {
  const portIndex = argv.indexOf('--port');
  const rootIndex = argv.indexOf('--root');
  if (portIndex === -1 || rootIndex === -1) {
    exitWithUsage('os argumentos --port e --root são obrigatórios.');
  }

  const portText = argv[portIndex + 1];
  const rootText = argv[rootIndex + 1];

  if (!/^\d+$/.test(portText || '')) {
    exitWithUsage(`porta inválida: "${portText}".`);
  }
  const port = Number(portText);
  if (port <= 1024 || port > 65535) {
    exitWithUsage('a porta deve estar entre 1025 e 65535.');
  }

  if (!rootText || rootText.startsWith('--')) {
    exitWithUsage('informe o diretório depois de --root.');
  }

  // Usamos as versões síncronas só aqui, na inicialização, antes de aceitar
  // qualquer conexão — então não bloqueiam nenhum cliente.
  // realpath transforma "./www" no caminho absoluto real (ex.: /home/.../www),
  // que é a referência usada na proteção contra directory traversal.
  let rootDir;
  try {
    rootDir = fs.realpathSync(path.resolve(rootText));
  } catch {
    exitWithUsage(`diretório raiz não encontrado: "${rootText}".`);
  }
  if (!fs.statSync(rootDir).isDirectory()) {
    exitWithUsage(`"${rootText}" não é um diretório.`);
  }

  return { port, rootDir };
}

// ---------------------------------------------------------------------------
// Tratamento de UMA requisição já interpretada pelo parser
// ---------------------------------------------------------------------------

// Decide a resposta { status, headers, body } para a requisição.
// GET e HEAD passam exatamente pelo mesmo caminho; a diferença (enviar ou não
// o corpo) só acontece na hora de serializar a resposta.
async function handleRequest(request, rootDir) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(405, { 'Allow': 'GET, HEAD' });
  }

  const resolved = resolveSafePath(rootDir, request.target);
  if (resolved.status) {
    return errorResponse(resolved.status); // 400 ou 403
  }

  const file = await readFileFromDisk(resolved.filePath);
  if (file.status !== 200) {
    if (file.error) {
      console.error(`Erro ao ler ${resolved.filePath}:`, file.error.message);
    }
    return errorResponse(file.status);
  }

  return {
    status: 200,
    headers: { 'Content-Type': getContentType(file.filePath) },
    body: file.content,
  };
}

// Em HTTP/1.1 a conexão é persistente por padrão. Só fechamos quando:
//  - o cliente pede com "Connection: close";
//  - o cliente fala HTTP/1.0 (onde o padrão é fechar);
//  - a requisição usa Transfer-Encoding, que não implementamos: sem saber
//    onde o corpo termina, não dá para achar o início da próxima requisição.
function shouldCloseConnection(request) {
  const connection = (request.headers['connection'] || '').toLowerCase();
  const tokens = connection.split(',').map((token) => token.trim());
  return (
    tokens.includes('close') ||
    request.version === 'HTTP/1.0' ||
    request.headers['transfer-encoding'] !== undefined
  );
}

// ---------------------------------------------------------------------------
// Uma conexão TCP (um socket por cliente)
// ---------------------------------------------------------------------------

function handleConnection(socket, rootDir) {
  const client = `${socket.remoteAddress}:${socket.remotePort}`;

  // Buffer de recebimento PRÓPRIO deste socket.
  // O TCP entrega um fluxo de bytes, não mensagens: um evento 'data' pode trazer
  // meia requisição, uma requisição inteira, ou uma requisição e o começo da
  // próxima. Por isso acumulamos tudo aqui e só processamos quando houver uma
  // requisição completa. Cada conexão tem o seu, para que bytes de clientes
  // diferentes nunca se misturem.
  let buffer = Buffer.alloc(0);

  let busy = false;    // true enquanto processBuffer está rodando
  let closing = false; // true depois que decidimos encerrar a conexão
  let requestCount = 0;

  log(client, 'conexão aberta');

  // Timeout de inatividade: se nenhum byte for lido ou escrito neste socket por
  // IDLE_TIMEOUT_MS, o Node emite 'timeout'. Qualquer tráfego reinicia a contagem.
  socket.setTimeout(IDLE_TIMEOUT_MS);

  socket.on('data', (chunk) => {
    if (closing) return;
    buffer = Buffer.concat([buffer, chunk]); // buffer existente + novos bytes
    processBuffer().catch((err) => {
      log(client, `erro inesperado: ${err.message}`);
      socket.destroy();
    });
  });

  socket.on('timeout', () => {
    log(client, `timeout: ${IDLE_TIMEOUT_MS} ms sem atividade, encerrando conexão`);
    closing = true;
    socket.end(); // envia FIN (encerramento TCP normal)
  });

  // Erros como ECONNRESET (cliente derrubou a conexão) afetam só este socket.
  // Ter este listener impede que o erro derrube o servidor inteiro.
  socket.on('error', (err) => {
    log(client, `erro no socket: ${err.code || err.message}`);
  });

  socket.on('close', () => {
    log(client, `conexão encerrada (${requestCount} requisição(ões) nesta conexão)`);
  });

  // Extrai do buffer e responde todas as requisições completas, EM ORDEM.
  // A flag "busy" garante que só um laço rode por vez neste socket: se chegarem
  // bytes enquanto esperamos a leitura de um arquivo, eles só são acrescentados
  // ao buffer, e o laço que já está rodando os encontra na próxima volta. Assim as
  // respostas nunca saem fora de ordem.
  async function processBuffer() {
    if (busy) return;
    busy = true;

    while (!closing) {
      // "\r\n\r\n" = fim da linha do último header + linha vazia.
      // É o único jeito de saber que a seção de headers terminou.
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (buffer.length > MAX_HEADER_BYTES) {
          sendBadRequestAndClose('headers grandes demais');
        }
        break; // requisição incompleta: espera mais bytes chegarem
      }

      const headerText = buffer.subarray(0, headerEnd).toString('latin1');
      const request = parseRequest(headerText);
      if (request.error) {
        sendBadRequestAndClose(request.error);
        break;
      }

      // Tamanho total = headers + "\r\n\r\n" + corpo (se houver Content-Length).
      // Se o corpo ainda não chegou inteiro, esperamos o próximo 'data'.
      const requestLength = headerEnd + 4 + request.bodyLength;
      if (buffer.length < requestLength) break;

      // Remove esta requisição do buffer. O que sobrar (se sobrar) já é o começo
      // da próxima requisição e fica guardado para a próxima volta do laço.
      buffer = buffer.subarray(requestLength);
      requestCount++;

      await respond(request);
    }

    busy = false;
  }

  async function respond(request) {
    log(client, `requisição: ${request.method} ${request.target} ${request.version}`);

    const response = await handleRequest(request, rootDir);
    const close = shouldCloseConnection(request);
    const bytes = serializeResponse(response, {
      sendBody: request.method !== 'HEAD', // HEAD: mesmos headers, sem corpo
      closeConnection: close,
    });

    // O cliente pode ter desconectado enquanto líamos o arquivo.
    if (!socket.writable) return;

    const status = `${response.status} ${STATUS_TEXT[response.status]}`;
    const sentBody = request.method === 'HEAD' ? 'HEAD, corpo não enviado' : `${response.body.length} bytes de corpo`;
    log(client, `resposta: ${status} (${sentBody})${close ? ' + Connection: close' : ''}`);

    if (close) {
      // end(dados) escreve a resposta INTEIRA e só depois envia o FIN.
      // Assim a conexão nunca é encerrada antes de a resposta ser enviada.
      closing = true;
      socket.end(bytes);
    } else {
      // Conexão persistente: responde e mantém o socket aberto esperando a
      // próxima requisição (ou o timeout).
      socket.write(bytes);
    }
  }

  // Depois de uma requisição malformada não sabemos onde ela termina no fluxo
  // de bytes, então não dá para continuar lendo a conexão: respondemos 400 e fechamos.
  function sendBadRequestAndClose(reason) {
    log(client, `requisição malformada (${reason}) -> 400 Bad Request + Connection: close`);
    closing = true;
    socket.end(serializeResponse(errorResponse(400), { sendBody: true, closeConnection: true }));
  }
}

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------

function printAddresses(port) {
  console.log(`Acesse em http://localhost:${port}/ ou, de outra máquina, em:`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`  http://${address.address}:${port}/`);
      }
    }
  }
}

function main() {
  const { port, rootDir } = parseArgs(process.argv.slice(2));

  // O "server" só aguarda conexões. Para cada cliente que conecta (depois do
  // three-way handshake do TCP) o Node chama este callback com um "socket"
  // novo, que representa aquela conexão específica.
  const server = net.createServer((socket) => handleConnection(socket, rootDir));

  server.on('error', (err) => {
    console.error(`Erro no servidor: ${err.message}`);
    process.exit(1);
  });

  // 0.0.0.0 = todas as interfaces de rede, para que outras máquinas consigam
  // conectar (127.0.0.1 aceitaria apenas conexões da própria máquina).
  server.listen(port, '0.0.0.0', () => {
    console.log(`Servidor ouvindo em 0.0.0.0:${port}, servindo ${rootDir}`);
    printAddresses(port);
  });
}

main();
