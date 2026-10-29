# Como executar a suíte de Rules localmente

Este é um pacote isolado de teste, não um backend implantável. A suíte usa somente o Firestore Emulator local e o projeto identificador `demo-randstad-rules-test`; não acessa o projeto real `devo-randstad`, não publica nada e não altera Rules hospedadas. As Rules incluídas são parciais, em rascunho e com negação por padrão para o que não está explicitamente permitido. **Não implante este arquivo.**

## Requisitos

- Node.js 20 ou superior e npm.
- Java 21 (JRE suficiente; necessário pelo Firestore Emulator).
- Conexão à internet apenas para baixar dependências e o Emulator na primeira execução.

## Linux/macOS

Extraia esta pasta e abra um terminal nela (`public-intake-backend-prototype`). Em seguida:

```sh
npm install
npm run check:isolation
npm run test:rules:emulator
```

O último comando verifica os guardrails, inicia somente o Emulator do Firestore em `127.0.0.1:8182`, executa a suíte e encerra o Emulator. Não rode `firebase deploy`.

## Windows PowerShell

Instale Node.js 20+ e Java 21; extraia a pasta, abra o PowerShell dentro dela e rode:

```powershell
npm install
npm run check:isolation
npm run test:rules:emulator
```

## Resultado esperado e falhas

A suíte contém três grupos: claims inacessíveis a clientes, leitura das submissões permitida somente ao perfil gestor, e negação de escritas/clientes e documentos alheios. Os testes usam identidades e documentos sintéticos. Sucesso da suíte valida somente este rascunho no Emulator; não valida atomicidade/concorrência do backend, integração Cloudflare, hospedagem, custos, Rules de produção ou formulário.

Se o Emulator reportar que a porta `8182` está ocupada, encerre o processo local que a utiliza ou ajuste a porta **em ambos** `firebase.server-intake.emulator.json` e `tests/firestore.server-intake.rules.test.js`, mantendo o host em loopback `127.0.0.1`. Se surgir aviso de memória, aumente a memória disponível ou use outra máquina. Não mude para o projeto real e não execute deploy para contornar falhas.
