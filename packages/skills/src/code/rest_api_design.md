# REST API Design

## Resource Naming
- Use nouns, not verbs: `/users` not `/getUsers`
- Use plural: `/orders` not `/order`
- Hierarchical relationships: `/users/{id}/orders`

## HTTP Methods
| Method | Action | Idempotent |
|--------|--------|------------|
| GET | Read | Yes |
| POST | Create | No |
| PUT | Full update | Yes |
| PATCH | Partial update | No* |
| DELETE | Remove | Yes |

## Status Codes
- 200 OK — standard response
- 201 Created — resource created
- 204 No Content — success, empty body
- 400 Bad Request — client error
- 401 Unauthorized — auth required
- 403 Forbidden — no permission
- 404 Not Found — resource missing
- 409 Conflict — state conflict
- 422 Unprocessable Entity — validation failed
- 429 Too Many Requests — rate limited
- 500 Internal Server Error — server failure

## Bun-Specific
- Use `Bun.serve()` with route handlers
- Validate inputs with Zod before processing
- Return `Response.json()` for JSON APIs
- Handle CORS in `Bun.serve()` options
