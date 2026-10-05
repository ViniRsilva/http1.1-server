// Cliente auxiliar para reproduzir os cenários de medição da Parte 2.
// NÃO faz parte do servidor; serve só para gerar o tráfego capturado no Wireshark.
//
//   C1: 10 requisições, cada uma em uma conexão TCP nova (Connection: close)
//   C2: 10 requisições em uma única conexão TCP persistente
//
// Uso:
//   node tests/c1c2.js c1 <host> <porta> [caminho]
//   node tests/c1c2.js c2 <host> <porta> [caminho]
//
// Exemplo: node tests/c1c2.js c1 192.168.0.10 8080 /index.html

const net = require('net');

const TOTAL_REQUESTS = 10;

const [scenario, host, portText, resource = '/index.html'] = process.argv.slice(2);
const port = Number(portText);
if (!['c1', 'c2'].includes(scenario) || !host || !port) {
  console.error('Uso: node tests/c1c2.js <c1|c2> <host> <porta> [caminho]');
  process.exit(1);
}

function buildRequest(close) {
  return (
    `GET ${resource} HTTP/1.1\r\n` +
    `Host: ${host}:${port}\r\n` +
    (close ? 'Connection: close\r\n' : '') +
    '\r\n'
  );
}

// Espera chegar UMA resposta completa no socket: headers até "\r\n\r\n" e
// depois Content-Length bytes de corpo. Devolve a status line.
function readOneResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const head = buffer.subarray(0, headerEnd).toString('latin1');
      const match = head.match(/content-length:\s*(\d+)/i);
      const bodyLength = match ? Number(match[1]) : 0;
      if (buffer.length < headerEnd + 4 + bodyLength) return;

      socket.off('data', onData);
      socket.off('error', reject);
      resolve(head.split('\r\n')[0]);
    }

    socket.on('data', onData);
    socket.once('error', reject);
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitForClose(socket) {
  return new Promise((resolve) => socket.once('close', resolve));
}

// C1: abre conexão, pede com Connection: close, espera o servidor fechar.
async function runC1() {
  for (let i = 1; i <= TOTAL_REQUESTS; i++) {
    const socket = await connect();
    const localPort = socket.localPort; // depois do close o Node não informa mais a porta
    const closed = waitForClose(socket);
    socket.write(buildRequest(true));
    const statusLine = await readOneResponse(socket);
    await closed;
    console.log(`#${i} conexão nova (porta local ${localPort}) -> ${statusLine}`);
  }
}

// C2: uma única conexão; a próxima requisição só é enviada depois que a
// resposta anterior chegou inteira (requisições sequenciais, sem pipelining).
async function runC2() {
  const socket = await connect();
  for (let i = 1; i <= TOTAL_REQUESTS; i++) {
    socket.write(buildRequest(false));
    const statusLine = await readOneResponse(socket);
    console.log(`#${i} mesma conexão (porta local ${socket.localPort}) -> ${statusLine}`);
  }
  const closed = waitForClose(socket);
  socket.end(); // cliente encerra a conexão depois da 10ª resposta
  await closed;
}

async function main() {
  console.log(`Cenário ${scenario.toUpperCase()}: ${TOTAL_REQUESTS}x GET ${resource} em ${host}:${port}`);
  const start = process.hrtime.bigint();
  await (scenario === 'c1' ? runC1() : runC2());
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`Tempo total medido pelo cliente: ${elapsedMs.toFixed(2)} ms`);
}

main().catch((err) => {
  console.error(`Erro: ${err.message}`);
  process.exit(1);
});
