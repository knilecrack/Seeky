# Importing ESM Packages in Seeky (CJS runtime)

Seeky runs as a CommonJS VS Code extension runtime. If a dependency is ESM-only, load it with dynamic import inside an async function.

## Preferred pattern

```ts
// Use a type-only import so TypeScript knows the shape.
import type { SomeApi } from 'some-esm-package';

let cachedApi: SomeApi | undefined;

export async function getSomeApi(): Promise<SomeApi> {
  if (cachedApi) return cachedApi;

  // Dynamic import works from CJS and keeps startup fast.
  const mod = await import('some-esm-package');
  cachedApi = mod.default ?? mod.someNamedExport;
  return cachedApi;
}
```

## Notes

- Prefer loading once and caching the module/object.
- Use `import type` for types only.
- Keep dynamic import close to where the package is actually needed.
- Keep extension entry/runtime as CJS for broad VS Code compatibility.
