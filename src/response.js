// Montagem manual das respostas HTTP.

// Identificador do grupo enviado no header "Server". Troque aqui.
const SERVER_NAME = 'GrupoXX-LabRedes';

const STATUS_TEXT = {
  200: 'OK',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  500: 'Internal Server Error',
};

// Resposta de erro com uma pequena página HTML como corpo.
// extraHeaders é usado, por exemplo, para o "Allow" do 405.
function errorResponse(status, extraHeaders = {}) {
  const html =
    '<!DOCTYPE html>\n' +
    `<html><head><meta charset="utf-8"><title>${status} ${STATUS_TEXT[status]}</title></head>\n` +
    `<body><h1>${status} ${STATUS_TEXT[status]}</h1><p>${SERVER_NAME}</p></body></html>\n`;

  return {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders },
    body: Buffer.from(html, 'utf8'),
  };
}

// Transforma { status, headers, body } nos bytes que vão para o socket:
//
//   HTTP/1.1 200 OK\r\n
//   Nome: valor\r\n
//   ...
//   \r\n
//   <corpo>
//
// sendBody = false é usado pelo HEAD: os headers são exatamente os mesmos do
// GET (inclusive o Content-Length, que continua indicando o tamanho que o corpo
// teria), mas os bytes do corpo não são enviados.
function serializeResponse(response, { sendBody, closeConnection }) {
  const headers = {
    // toUTCString() produz o IMF-fixdate exigido pela RFC 9110,
    // ex.: "Sun, 04 Oct 2026 02:30:00 GMT".
    'Date': new Date().toUTCString(),
    'Server': SERVER_NAME,
    ...response.headers,
    // body é um Buffer, então .length é o tamanho em BYTES (não em caracteres).
    'Content-Length': response.body.length,
  };
  if (closeConnection) {
    headers['Connection'] = 'close';
  }

  let head = `HTTP/1.1 ${response.status} ${STATUS_TEXT[response.status]}\r\n`;
  for (const [name, value] of Object.entries(headers)) {
    head += `${name}: ${value}\r\n`;
  }
  head += '\r\n'; // linha vazia: fim dos headers

  const headBytes = Buffer.from(head, 'latin1');
  return sendBody ? Buffer.concat([headBytes, response.body]) : headBytes;
}

module.exports = { SERVER_NAME, STATUS_TEXT, errorResponse, serializeResponse };
