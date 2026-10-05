// Mostra que o JavaScript foi carregado e faz mais uma requisição (dados.json).
const status = document.getElementById('status');
status.textContent = 'script.js carregado com sucesso!';
status.className = 'ok';

fetch('dados.json')
  .then((response) => response.json())
  .then((dados) => {
    const lista = document.getElementById('lista');
    for (const item of dados.recursos) {
      const li = document.createElement('li');
      li.textContent = item;
      lista.appendChild(li);
    }
  })
  .catch((err) => {
    status.textContent = 'Erro ao carregar dados.json: ' + err;
  });
