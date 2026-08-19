import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Server components cannot serialize event handlers; passing one crashes the whole route at render time.
const DOM_EVENT_HANDLERS = new Set([
  "onChange",
  "onClick",
  "onSubmit",
  "onInput",
  "onBlur",
  "onFocus",
  "onKeyDown",
  "onKeyUp",
  "onKeyPress",
  "onMouseDown",
  "onMouseUp",
  "onMouseEnter",
  "onMouseLeave",
  "onSelect",
  "onToggle",
  "onScroll",
  "onDrop",
  "onDragStart",
  "onDragOver",
]);

const serverComponentSafety = {
  rules: {
    "no-event-handlers-in-server-components": {
      meta: {
        type: "problem",
        docs: { description: "Disallow on* event handler props in files that are not Client Components." },
        messages: {
          handler:
            '`{{name}}` is an event handler and cannot be used in a Server Component. Move this element into a file with the "use client" directive.',
        },
        schema: [],
      },
      create(context) {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const isClientComponent = sourceCode.ast.body.some(
          (statement) =>
            statement.type === "ExpressionStatement" &&
            statement.expression.type === "Literal" &&
            statement.expression.value === "use client",
        );

        if (isClientComponent) return {};

        return {
          JSXAttribute(node) {
            const name = node.name?.type === "JSXIdentifier" ? node.name.name : null;
            if (!name || !/^on[A-Z]/.test(name)) return;
            if (node.value?.type !== "JSXExpressionContainer") return;

            const expression = node.value.expression;
            const isInlineFunction =
              expression.type === "ArrowFunctionExpression" || expression.type === "FunctionExpression";

            // `onFloor={5}`-style data props are legitimate, so only flag real handlers.
            if (!isInlineFunction && !DOM_EVENT_HANDLERS.has(name)) return;

            context.report({ node, messageId: "handler", data: { name } });
          },
        };
      },
    },
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.tsx"],
    plugins: { "server-component-safety": serverComponentSafety },
    rules: { "server-component-safety/no-event-handlers-in-server-components": "error" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
