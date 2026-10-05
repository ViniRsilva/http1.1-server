// Leitura dos arquivos servidos e escolha do Content-Type.

const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
};

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return MIME_TYPES[extension] || 'application/octet-stream';
}

// Lê o arquivo de forma ASSÍNCRONA (fs.promises). Enquanto o sistema
// operacional lê o disco, o Event Loop fica livre para atender outros sockets.
//
// Retorna { status: 200, filePath, content } ou { status: 404 | 403 | 500 }.
async function readFileFromDisk(filePath) {
  try {
    let stats = await fs.promises.stat(filePath);

    // Pedido de diretório (ex.: "GET /") serve o index.html de dentro dele.
    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stats = await fs.promises.stat(filePath);
    }
    if (!stats.isFile()) {
      return { status: 404 };
    }

    // readFile devolve um Buffer: funciona igual para texto e para binários
    // (imagens, PDF), sem nenhuma conversão de caracteres.
    const content = await fs.promises.readFile(filePath);
    return { status: 200, filePath, content };
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      return { status: 404 };
    }
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      return { status: 403 };
    }
    return { status: 500, error: err };
  }
}

module.exports = { getContentType, readFileFromDisk };
