// Conversão do request-target em um caminho de arquivo DENTRO do --root.
//
// Esta é a defesa contra directory traversal (ex.: GET /../../etc/passwd).
// A ideia é não tentar "adivinhar" padrões perigosos na string, e sim:
//   1. decodificar o percent-encoding (%2e%2e vira "..");
//   2. deixar o próprio sistema de paths resolver os ".." (path.join);
//   3. conferir se o caminho FINAL ainda está dentro do diretório raiz.
// Assim qualquer variação (../, %2e%2e/, ..%2f, a/../../, \ no Windows...)
// cai na mesma verificação, porque ela olha o resultado e não o texto original.

const path = require('path');

// rootDir precisa ser um caminho absoluto e real (o server.js resolve isso
// uma única vez, na inicialização).
// Retorna { filePath } em caso de sucesso ou { status } (400 ou 403) em caso de erro.
function resolveSafePath(rootDir, target) {
  // Só aceitamos o formato "/caminho" (origin-form).
  if (!target.startsWith('/')) {
    return { status: 400 };
  }

  // A query string (?a=1) não faz parte do nome do arquivo.
  const rawPath = target.split('?')[0];

  // Passo 1: percent-decoding. "/arquivo%20teste.txt" -> "/arquivo teste.txt"
  // e "/%2e%2e/%2e%2e/etc" -> "/../../etc". Sequências inválidas (ex.: "%zz")
  // fazem decodeURIComponent lançar erro -> requisição malformada.
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return { status: 400 };
  }

  // Byte nulo em nome de arquivo nunca é legítimo.
  if (decodedPath.includes('\0')) {
    return { status: 400 };
  }

  // Passo 2: path.join junta e NORMALIZA, resolvendo os "..".
  // Ex.: join('/srv/www', '/../../etc/passwd') -> '/etc/passwd'
  const filePath = path.join(rootDir, decodedPath);

  // Passo 3: o resultado precisa ser o próprio root ou estar abaixo dele.
  // Comparamos com rootDir + separador para que "/srv/www-secreto" não seja
  // aceito só por começar com "/srv/www".
  if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) {
    return { status: 403 };
  }

  return { filePath };
}

module.exports = { resolveSafePath };
