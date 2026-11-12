import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "coverage/", "node_modules/", ".dados-locais/", ".dados-e2e/"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "error",
      // Variáveis com prefixo _ são descartes intencionais (ex.: desestruturação para omitir chave).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { varsIgnorePattern: "^_", argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Esses arquivos imprimem no terminal por definição: jobs, scripts de dev,
    // CLIs (cli-*.ts) e o seed.
    files: ["dev/**", "src/jobs/**", "**/cli-*.ts", "seed/**"],
    rules: { "no-console": "off" },
  },
  {
    // Plugins do Fastify são async por convenção (o registro espera a Promise), mesmo sem await.
    // Nos testes, fakes de interfaces que devolvem Promise seguem o mesmo raciocínio.
    files: ["src/routes/**", "tests/**"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
  {
    // Nos testes, res.json() e os mocks devolvem any; tipar cada resposta não agrega.
    // Os no-unsafe-* continuam ativos em src/, dev/ e seed/.
    files: ["tests/**"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    // O próprio eslint.config.js não está no tsconfig.
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
