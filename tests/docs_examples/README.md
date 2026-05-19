# docs_examples — автотесты code-snippets из документации

Каждый файл отражает одну страницу `dagstack/config-docs` и дословно
воспроизводит Python… — то есть TypeScript-snippet'ы между маркерами
`// --- snippet start ---` / `// --- snippet end ---`, затем ассертирует
ожидания из комментариев в snippet'е.

## Почему отдельная директория

Снипеты из docs иногда конфликтуют со стайл-гайдом ядра:

- `import` внутри функции (docs показывает user-flow, не top-level).
- Повторная декларация `DatabaseConfig` в разных тестах (snippet в docs
  начинается с пустого файла).
- Локальные переменные, не используемые после snippet'а.

Чтобы не ослаблять правила для всего `tests/`, `tests/docs_examples/**`
получает per-directory overrides в `eslint.config.js` и
`tsconfig.test.json` (unchanged — уже включает `tests/**/*`).

## Покрываемые страницы

| Тест                               | Страница docs                            |
| ---------------------------------- | ---------------------------------------- |
| `intro.test.ts`                    | `site/docs/intro.mdx`                    |
| `concepts_sources.test.ts`         | `site/docs/concepts/sources.mdx`         |
| `concepts_layers.test.ts`          | `site/docs/concepts/layers.mdx`          |
| `guides_declaring_section.test.ts` | `site/docs/guides/declaring-section.mdx` |
| `guides_testing.test.ts`           | `site/docs/guides/testing.mdx`           |
| `reference_errors.test.ts`         | `site/docs/reference/errors.mdx`         |

## Правила для авторов

1. **Snippet внутри `// --- snippet start / end ---`** — копируется дословно
   (только лишние пустые строки и `console.log` могут быть удалены).
2. **Assert'ы — после `snippet end`** и ссылаются на переменные snippet'а.
3. **Drift docs ↔ реализация** — если snippet не соответствует реальному
   API, оставляй `NB:` комментарий + assert на реальное поведение.
   После merge такой drift должен быть зафиксирован задачей в tracker'е.
4. **Изолированные тесты** — каждый `it(...)` создаёт свой tmp-каталог
   через `mkdtemp`, не шарит state.
