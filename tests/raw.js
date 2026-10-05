// Envia bytes "crus" para o servidor e imprime a resposta exatamente como chegou.
//
// Serve para testes que o curl não consegue fazer porque ele sempre gera HTTP
// válido e normaliza URLs (400, traversal sem normalização, requisições
// agrupadas, etc.). Funciona igual no Windows e no Linux, sem precisar de netcat.
//
// Uso:
//   node tests/raw.js <host> <porta> "<requisição>"
//
// As sequências \r e \n escritas no texto viram os bytes CR e LF de verdade.
// Exemplos:
//   node tests/raw.js 127.0.0.1 8080 "GET /index.html\r\n\r\n"
//   node tests/raw.js 127.0.0.1 8080 "GET / HTTP/1.1\r\nHeaderSemDoisPontos\r\n\r\n"
//   node tests/raw.js 127.0.0.1 8080 "GET /../../etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"

const net = require('net');

const [host, port, text] = process.argv.slice(2);
if (!host || !port || text === undefined) {
  console.error('Uso: node tests/raw.js <host> <porta> "<requisição com \\r\\n>"');
  process.exit(1);
}

const request = text.replace(/\\r/g, '\r').replace(/\\n/g, '\n');

const socket = net.connect(Number(port), host, () => {
  socket.write(request);
});

socket.on('data', (chunk) => process.stdout.write(chunk));

// Se o servidor mantiver a conexão aberta (keep-alive), encerramos nós mesmos
// depois de 2 s sem novos dados.
socket.setTimeout(2000, () => socket.end());

socket.on('close', () => console.log('\n--- conexão encerrada ---'));
socket.on('error', (err) => console.error(`Erro: ${err.message}`));
