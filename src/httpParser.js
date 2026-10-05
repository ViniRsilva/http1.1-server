// Parser HTTP manual.
//
// Recebe o texto da seção de cabeçalho de UMA requisição (tudo antes do
// "\r\n\r\n") e devolve um objeto com método, alvo, versão e headers.
// Quem separa uma requisição da outra dentro do fluxo TCP é o server.js;
// aqui só interpretamos uma requisição já isolada.

function parseRequest(headerText) {
  // O terminador de linha do HTTP é CRLF ("\r\n").
  const lines = headerText.split('\r\n');

  // Request line: "METHOD request-target HTTP/version" — exatamente 3 partes
  // separadas por um espaço.
  const requestLine = lines[0];
  const parts = requestLine.split(' ');
  if (parts.length !== 3 || parts.includes('')) {
    return { error: `request line inválida: "${requestLine}"` };
  }

  const [method, target, version] = parts;

  if (!/^[A-Za-z]+$/.test(method)) {
    return { error: `método inválido: "${method}"` };
  }
  if (!/^HTTP\/1\.[01]$/.test(version)) {
    return { error: `versão inválida: "${version}"` };
  }

  // Headers: cada linha é "Nome: valor". Uma linha sem ":" torna a
  // requisição malformada (400).
  const headers = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon === -1) {
      return { error: `header sem ":": "${line}"` };
    }

    const name = line.slice(0, colon);
    // A RFC 9112 não permite espaço no nome nem entre o nome e o ":".
    if (name === '' || /\s/.test(name)) {
      return { error: `nome de header inválido: "${line}"` };
    }

    // Nomes de header não diferenciam maiúsculas/minúsculas, então guardamos
    // em minúsculo para facilitar a busca (ex.: headers['connection']).
    const key = name.toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[key] = key in headers ? `${headers[key]}, ${value}` : value;
  }

  // GET e HEAD normalmente não têm corpo, mas um cliente pode mandar, por
  // exemplo, um POST com corpo. Precisamos saber quantos bytes ele ocupa para
  // descartá-los e não confundi-los com o início da próxima requisição.
  let bodyLength = 0;
  if (headers['content-length'] !== undefined) {
    if (!/^\d+$/.test(headers['content-length'])) {
      return { error: `Content-Length inválido: "${headers['content-length']}"` };
    }
    bodyLength = Number(headers['content-length']);
  }

  return { method, target, version, headers, bodyLength };
}

module.exports = { parseRequest };
