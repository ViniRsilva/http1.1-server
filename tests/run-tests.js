// Testes automáticos do servidor.
//
// Sobe o servidor em uma porta de teste, envia bytes "crus" por sockets TCP
// (sem curl, para controlar exatamente o que é enviado e como é fragmentado)
// e confere as respostas.
//
// Uso: node tests/run-tests.js      (ou: npm test)

const net = require('net');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const PORT = 18081;
const ROOT = path.join(__dirname, '..', 'www');

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Abre uma conexão, envia os pedaços (com uma pausa entre eles) e coleta tudo
// o que chegar até o servidor fechar a conexão ou passar idleMs sem dados.
function exchange(chunks, { pauseMs = 0, idleMs = 400 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, '127.0.0.1');
    let received = Buffer.alloc(0);
    let closedByServer = false;

    socket.on('connect', async () => {
      for (const chunk of chunks) {
        socket.write(chunk);
        if (pauseMs) await sleep(pauseMs);
      }
      socket.setTimeout(idleMs, () => socket.destroy());
    });
    socket.on('data', (data) => { received = Buffer.concat([received, data]); });
    socket.on('end', () => { closedByServer = true; });
    socket.on('close', () => resolve({ data: received, closedByServer }));
    socket.on('error', reject);
  });
}

// Separa as respostas que chegaram no mesmo fluxo de bytes.
// methods[i] indica se a i-ésima resposta é de um HEAD (sem corpo).
function parseResponses(data, methods) {
  const responses = [];
  let offset = 0;
  for (const method of methods) {
    const headerEnd = data.indexOf('\r\n\r\n', offset);
    assert.notStrictEqual(headerEnd, -1, 'resposta incompleta');
    const lines = data.subarray(offset, headerEnd).toString('latin1').split('\r\n');
    const headers = {};
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':');
      headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    const bodyLength = method === 'HEAD' ? 0 : Number(headers['content-length']);
    const body = data.subarray(headerEnd + 4, headerEnd + 4 + bodyLength);
    offset = headerEnd + 4 + bodyLength;
    responses.push({ status: Number(lines[0].split(' ')[1]), statusLine: lines[0], headers, body });
  }
  assert.strictEqual(offset, data.length, 'sobraram bytes inesperados depois das respostas');
  return responses;
}

const get = (target, extra = '') => `GET ${target} HTTP/1.1\r\nHost: teste\r\n${extra}\r\n`;
const readWww = (name) => fs.readFileSync(path.join(ROOT, name));

// ---------------------------------------------------------------------------
// Casos de teste
// ---------------------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('GET /index.html -> 200 com headers obrigatórios e corpo correto', async () => {
  const { data } = await exchange([get('/index.html')]);
  const [r] = parseResponses(data, ['GET']);
  assert.strictEqual(r.statusLine, 'HTTP/1.1 200 OK');
  assert.strictEqual(r.headers['content-type'], 'text/html; charset=utf-8');
  assert.strictEqual(Number(r.headers['content-length']), readWww('index.html').length);
  assert.match(r.headers['date'], /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
  assert.ok(r.headers['server']);
  assert.deepStrictEqual(r.body, readWww('index.html'));
});

test('GET / serve o index.html', async () => {
  const [r] = parseResponses((await exchange([get('/')])).data, ['GET']);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, readWww('index.html'));
});

test('HEAD tem exatamente os headers do GET e nenhum byte de corpo', async () => {
  const [g] = parseResponses((await exchange([get('/imagem.png')])).data, ['GET']);
  const { data } = await exchange([`HEAD /imagem.png HTTP/1.1\r\nHost: teste\r\n\r\n`]);
  const [h] = parseResponses(data, ['HEAD']); // parseResponses falha se sobrar corpo
  delete g.headers.date;
  delete h.headers.date;
  assert.deepStrictEqual(h.headers, g.headers);
  assert.strictEqual(Number(h.headers['content-length']), readWww('imagem.png').length);
});

test('Arquivo binário (PNG) chega byte a byte idêntico, com image/png', async () => {
  const [r] = parseResponses((await exchange([get('/imagem.png')])).data, ['GET']);
  assert.strictEqual(r.headers['content-type'], 'image/png');
  assert.deepStrictEqual(r.body, readWww('imagem.png'));
});

test('Content-Type: css, js, json e extensão desconhecida', async () => {
  const cases = {
    '/style.css': 'text/css; charset=utf-8',
    '/script.js': 'text/javascript; charset=utf-8',
    '/dados.json': 'application/json',
    '/arquivo.dat': 'application/octet-stream',
  };
  for (const [target, type] of Object.entries(cases)) {
    const [r] = parseResponses((await exchange([get(target)])).data, ['GET']);
    assert.strictEqual(r.headers['content-type'], type, target);
  }
});

test('Percent-encoding: /arquivo%20teste.txt -> 200', async () => {
  const [r] = parseResponses((await exchange([get('/arquivo%20teste.txt')])).data, ['GET']);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, readWww('arquivo teste.txt'));
});

test('404 para arquivo inexistente, com Content-Length correto', async () => {
  const [r] = parseResponses((await exchange([get('/nao-existe.html')])).data, ['GET']);
  assert.strictEqual(r.statusLine, 'HTTP/1.1 404 Not Found');
  assert.strictEqual(Number(r.headers['content-length']), r.body.length);
});

test('HEAD de recurso inexistente -> 404 sem corpo', async () => {
  const { data } = await exchange([`HEAD /nao-existe HTTP/1.1\r\nHost: teste\r\n\r\n`]);
  const [r] = parseResponses(data, ['HEAD']);
  assert.strictEqual(r.status, 404);
  assert.ok(Number(r.headers['content-length']) > 0);
});

test('405 + Allow para POST/PUT/DELETE; o corpo do POST é descartado e a conexão continua', async () => {
  const post = 'POST /index.html HTTP/1.1\r\nHost: teste\r\nContent-Length: 5\r\n\r\nabcde';
  const put = 'PUT /index.html HTTP/1.1\r\nHost: teste\r\n\r\n';
  const del = 'DELETE /index.html HTTP/1.1\r\nHost: teste\r\n\r\n';
  const { data } = await exchange([post + put + del + get('/style.css')]);
  const responses = parseResponses(data, ['POST', 'PUT', 'DELETE', 'GET']);
  for (const r of responses.slice(0, 3)) {
    assert.strictEqual(r.statusLine, 'HTTP/1.1 405 Method Not Allowed');
    assert.strictEqual(r.headers['allow'], 'GET, HEAD');
  }
  assert.strictEqual(responses[3].status, 200);
});

test('400 para requisições malformadas, e a conexão é fechada', async () => {
  const malformed = [
    'GET /index.html\r\n\r\n',                        // faltou a versão
    'GET /index.html HTTP/1.1 extra\r\n\r\n',         // partes demais
    'GET  /index.html HTTP/1.1\r\n\r\n',              // espaço duplo
    'GET /index.html HTTP/9.9\r\n\r\n',               // versão inválida
    'GET /index.html HTTP/1.1\r\nSemDoisPontos\r\n\r\n', // header sem ':'
    'GET /index.html HTTP/1.1\r\nHost : x\r\n\r\n',   // espaço antes do ':'
    'GET /%zz HTTP/1.1\r\nHost: x\r\n\r\n',           // percent-encoding inválido
    'GET index.html HTTP/1.1\r\nHost: x\r\n\r\n',     // alvo sem '/'
    'GET / HTTP/1.1\r\nContent-Length: abc\r\n\r\n',  // Content-Length inválido
  ];
  for (const raw of malformed) {
    const { data, closedByServer } = await exchange([raw]);
    const [r] = parseResponses(data, ['GET']);
    assert.strictEqual(r.statusLine, 'HTTP/1.1 400 Bad Request', JSON.stringify(raw));
    if (r.headers['connection'] === 'close') assert.ok(closedByServer);
  }
});

test('403 para tentativas de directory traversal (inclusive percent-encoded)', async () => {
  const attacks = [
    '/../../etc/passwd',
    '/../../Windows/System32/drivers/etc/hosts',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/%2E%2E/%2E%2E/etc/passwd',
    '/..%2f..%2f..%2fetc%2fpasswd',
    '/imagens/../../../etc/passwd',
    '/../www-secreto/x',
    '/..',
  ];
  for (const target of attacks) {
    const [r] = parseResponses((await exchange([get(target)])).data, ['GET']);
    assert.strictEqual(r.statusLine, 'HTTP/1.1 403 Forbidden', target);
  }
});

test('".." que continua dentro do root é permitido (/x/../index.html -> 200)', async () => {
  const [r] = parseResponses((await exchange([get('/x/../index.html')])).data, ['GET']);
  assert.strictEqual(r.status, 200);
});

test('Requisição fragmentada em dois pedaços (GET /index.ht | ml ...)', async () => {
  const { data } = await exchange(['GET /index.ht', 'ml HTTP/1.1\r\nHost: teste\r\n\r\n'], { pauseMs: 100 });
  const [r] = parseResponses(data, ['GET']);
  assert.strictEqual(r.status, 200);
});

test('Requisição enviada 1 byte por vez', async () => {
  const raw = get('/style.css');
  const { data } = await exchange(raw.split(''), { pauseMs: 2 });
  const [r] = parseResponses(data, ['GET']);
  assert.deepStrictEqual(r.body, readWww('style.css'));
});

test('"\\r\\n\\r\\n" dividido entre dois pacotes', async () => {
  const { data } = await exchange(['GET /style.css HTTP/1.1\r\nHost: x\r\n\r', '\n'], { pauseMs: 100 });
  assert.strictEqual(parseResponses(data, ['GET'])[0].status, 200);
});

test('Várias requisições no mesmo pacote TCP -> respostas na ordem certa', async () => {
  const raw = get('/index.html') + `HEAD /imagem.png HTTP/1.1\r\nHost: x\r\n\r\n` + get('/nao-existe') + get('/style.css');
  const { data, closedByServer } = await exchange([raw]);
  const r = parseResponses(data, ['GET', 'HEAD', 'GET', 'GET']);
  assert.deepStrictEqual(r.map((x) => x.status), [200, 200, 404, 200]);
  assert.deepStrictEqual(r[0].body, readWww('index.html'));
  assert.deepStrictEqual(r[3].body, readWww('style.css'));
  assert.strictEqual(closedByServer, false, 'keep-alive: o servidor não deveria fechar');
});

test('Requisição completa + começo da próxima no mesmo pacote', async () => {
  const second = get('/style.css');
  const { data } = await exchange([get('/script.js') + second.slice(0, 10), second.slice(10)], { pauseMs: 100 });
  const r = parseResponses(data, ['GET', 'GET']);
  assert.deepStrictEqual(r[0].body, readWww('script.js'));
  assert.deepStrictEqual(r[1].body, readWww('style.css'));
});

test('Keep-alive: 10 requisições sequenciais na mesma conexão', async () => {
  const chunks = Array.from({ length: 10 }, () => get('/index.html'));
  const { data, closedByServer } = await exchange(chunks, { pauseMs: 50 });
  const r = parseResponses(data, Array(10).fill('GET'));
  assert.ok(r.every((x) => x.status === 200 && !x.headers['connection']));
  assert.strictEqual(closedByServer, false);
});

test('Connection: close -> resposta com Connection: close e o servidor fecha', async () => {
  const { data, closedByServer } = await exchange([get('/index.html', 'Connection: close\r\n')], { idleMs: 2000 });
  const [r] = parseResponses(data, ['GET']);
  assert.strictEqual(r.headers['connection'], 'close');
  assert.deepStrictEqual(r.body, readWww('index.html'));
  assert.strictEqual(closedByServer, true);
});

test('Connection: close no meio do pipeline: o que vem depois é ignorado', async () => {
  const raw = get('/style.css') + get('/script.js', 'Connection: close\r\n') + get('/index.html');
  const { data, closedByServer } = await exchange([raw], { idleMs: 2000 });
  const r = parseResponses(data, ['GET', 'GET']);
  assert.strictEqual(r[1].headers['connection'], 'close');
  assert.strictEqual(closedByServer, true);
});

test('HTTP/1.0 -> servidor fecha depois da resposta', async () => {
  const { data, closedByServer } = await exchange(['GET /style.css HTTP/1.0\r\n\r\n'], { idleMs: 2000 });
  assert.strictEqual(parseResponses(data, ['GET'])[0].headers['connection'], 'close');
  assert.strictEqual(closedByServer, true);
});

test('Timeout: conexão ociosa é fechada pelo servidor após ~5 s', async () => {
  const start = Date.now();
  const { data, closedByServer } = await exchange([get('/style.css')], { idleMs: 8000 });
  const elapsed = Date.now() - start;
  assert.strictEqual(parseResponses(data, ['GET'])[0].status, 200);
  assert.strictEqual(closedByServer, true);
  assert.ok(elapsed >= 4900 && elapsed < 6500, `fechou em ${elapsed} ms`);
});

test('Concorrência: cliente lento (requisição pela metade) não bloqueia outro cliente', async () => {
  const slow = net.connect(PORT, '127.0.0.1');
  await new Promise((resolve) => slow.on('connect', resolve));
  slow.write('GET /index.html HTTP/1.1\r\nHo'); // fica parado no meio dos headers

  const start = Date.now();
  const [r] = parseResponses((await exchange([get('/imagem.png')], { idleMs: 200 })).data, ['GET']);
  assert.strictEqual(r.status, 200);
  assert.ok(Date.now() - start < 1000, 'o segundo cliente demorou demais');

  // O cliente lento termina a requisição e também é atendido.
  const slowReply = new Promise((resolve) => slow.once('data', resolve));
  slow.write('st: x\r\nConnection: close\r\n\r\n');
  assert.match((await slowReply).toString('latin1'), /^HTTP\/1\.1 200 OK/);
  slow.destroy();
});

test('Concorrência: 20 clientes simultâneos', async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () => exchange([get('/imagem.png')]))
  );
  for (const { data } of results) {
    assert.deepStrictEqual(parseResponses(data, ['GET'])[0].body, readWww('imagem.png'));
  }
});

test('Cliente que derruba a conexão não derruba o servidor', async () => {
  const socket = net.connect(PORT, '127.0.0.1');
  await new Promise((resolve) => socket.on('connect', resolve));
  socket.write(get('/imagem.png'));
  socket.resetAndDestroy(); // envia RST
  await sleep(200);
  const [r] = parseResponses((await exchange([get('/index.html')])).data, ['GET']);
  assert.strictEqual(r.status, 200);
});

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', String(PORT), '--root', ROOT]);
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  await sleep(500);

  let failures = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok    ${name}`);
    } catch (err) {
      failures++;
      console.log(`  FALHA ${name}\n        ${err.message}`);
    }
  }

  const alive = server.exitCode === null;
  server.kill();
  console.log(`\n${tests.length - failures}/${tests.length} testes passaram; servidor ${alive ? 'continuou rodando' : 'MORREU'} durante os testes.`);
  if (process.argv.includes('--log')) console.log('\n--- log do servidor ---\n' + serverLog);
  process.exit(failures || !alive ? 1 : 0);
}

main();
