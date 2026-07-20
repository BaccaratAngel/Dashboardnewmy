---
name: OpenAPI / Generated Type Notes
description: Known type issues and patterns for the generated API client hooks.
---

## confidence field
- In openapi.yaml: `type: string` (was incorrectly `number` — fixed).
- Values: "NONE" | "LOW" | "MED" | "HIGH" (string, not numeric 0-1).
- Frontend components must accept `string`, not `number`.

## Generated query hooks (Orval)
- Return `UseQueryResult<T, E> & { queryKey }` — standard TanStack Query shape.
- Access data via `.data`: `const { data } = useGetSnapshot(); // data is GameSnapshot | undefined`
- NOT a direct T return.

## Generated mutation hooks
- Call with: `mutate({ data: payload }, { onSuccess, onError })`.
- Void mutations (logout, undo, reset, kick): `mutate(undefined, ...)` or just `mutate()`.
- Mutation for setWindow: `mutate({ data: { window: 12 } })`.

## Error shape from customFetch
- Throws `ApiError` with `.message` built from the response body's `error` field.
- Frontend can check `(err as ApiError).message` or `(err as ApiError).data?.error`.

**Why:** Orval's generated code wraps useQuery internally; the hook result is UseQueryResult not raw T.
