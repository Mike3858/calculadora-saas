# 1. Imagem Base: Começamos com um ambiente Node.js moderno e leve.
FROM node:20-alpine

# 2. Diretório de Trabalho: Criamos uma pasta /app dentro do contêiner para organizar tudo.
WORKDIR /app

# 3. Cache de Dependências: Copiamos primeiro os ficheiros de dependências.
#    Isso acelera futuras construções, pois o Docker não reinstala tudo se nada mudou aqui.
COPY package*.json ./

# 4. Instalação: Instalamos apenas as dependências de produção para uma imagem final mais leve e segura.
RUN npm install --production

# 5. Código Fonte: Copiamos o resto dos seus ficheiros (server.js, index.html, etc.) para dentro do contêiner.
COPY . .

# 6. Exposição da Porta: Informamos ao Docker que a aplicação dentro do contêiner usa a porta 3000.
EXPOSE 3000

# 7. Comando de Início: Este é o comando que executa quando o contêiner liga, iniciando seu servidor.
CMD [ "node", "server.js" ]