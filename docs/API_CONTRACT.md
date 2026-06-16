# API Contract — hivecode-free backend

Este documento define el contrato que el **backend del operador** debe
implementar para que `hivecode` (cliente TUI/CLI) pueda consumir modelos
NVIDIA NIM a través de Firebase Auth.

## 1. Topología

```
┌────────────────┐      ┌──────────────────────┐      ┌──────────────────┐
│ hivecode       │      │ Backend del operador │      │ NVIDIA NIM       │
│ (TUI/CLI)      │ ───► │ (tu API)             │ ───► │ (integrate.api.  │
│                │      │                      │      │  nvidia.com)     │
└────────────────┘      └──────────────────────┘      └──────────────────┘
       ▲                          │
       │                          │ valida con
       │                          ▼
       │                  ┌──────────────────┐
       │                  │ Firebase Auth    │
       │                  │ (Admin SDK)      │
       │                  └──────────────────┘
       │
       │ abre navegador en callback de login
       │
       ▼
┌────────────────┐
│ Usuario (TUI)  │ ────► abre https://api.tu-dominio.com/auth/cli?state=XXX
│                │ ◄──── recibe token del callback, lo pega en TUI
└────────────────┘
```

## 2. Endpoints que tu API debe exponer

### 2.1 `GET /auth/cli?state=<random>&redirect_uri=http://127.0.0.1:8923/callback`

**Descripción**: URL que el usuario abre en su navegador para iniciar el flujo
de auth. El backend debe:

1. Renderizar una página con el SDK de Firebase Auth (Google + email/password).
2. Tras login exitoso, generar un **hivecode_token** firmado por el backend
   (JWT, expira en 30 días, contiene `firebaseUid` + `email`).
3. Redirigir al usuario a:
   ```
   http://127.0.0.1:8923/callback?token=<hivecode_token>&state=<state>
   ```
4. `state` debe validarse para evitar CSRF (el cliente lo genera random y lo
   guarda localmente; tu backend lo recibe y debe verificarlo cuando el
   callback regrese).

**Página web mínima** (HTML estático o SPA):

```html
<!DOCTYPE html>
<html>
<head><title>hivecode · auth</title></head>
<body>
  <h1>Inicia sesión con Firebase</h1>
  <div id="firebaseui-auth-container"></div>
  <script src="https://www.gstatic.com/firebasejs/10.x.x/firebase-app.js"></script>
  <script src="https://www.gstatic.com/firebasejs/10.x.x/firebase-auth.js"></script>
  <script src="https://www.gstatic.com/firebasejs/10.x.x/firebaseui.js"></script>
  <script>
    // Tu config de Firebase
    const firebaseConfig = { /* ... */ };
    firebase.initializeApp(firebaseConfig);
    const ui = new firebaseui.auth.AuthUI(firebase.auth());
    ui.start('#firebaseui-auth-container', {
      signInOptions: [
        firebase.auth.GoogleAuthProvider.PROVIDER_ID,
        firebase.auth.EmailAuthProvider.PROVIDER_ID,
      ],
      callbacks: {
        signInSuccessWithAuthResult: async (authResult) => {
          const idToken = await authResult.user.getIdToken();
          const params = new URLSearchParams(location.search);
          const state = params.get('state');
          // Llama a tu backend para que genere el hivecode_token
          const res = await fetch('/api/auth/exchange', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({firebaseIdToken: idToken, state}),
          });
          const {hivecodeToken} = await res.json();
          // Redirige al callback local
          location.href = `http://127.0.0.1:8923/callback?token=${hivecodeToken}&state=${state}`;
          return false; // evita redirect automático de FirebaseUI
        },
      },
    });
  </script>
</body>
</html>
```

### 2.2 `POST /api/auth/exchange`

**Body**:
```json
{
  "firebaseIdToken": "eyJhbGciOiJSUzI1NiIs...",
  "state": "abc123"
}
```

**Response 200**:
```json
{
  "hivecodeToken": "eyJhbGciOiJIUzI1NiIs...",
  "firebaseUid": "X9d2K8...",
  "email": "user@example.com",
  "expiresAt": 1717430400
}
```

**Response 401** (Firebase ID token inválido):
```json
{ "error": "invalid_firebase_token" }
```

**Response 400** (state inválido):
```json
{ "error": "invalid_state" }
```

**Implementación sugerida** (Node.js / TypeScript):

```ts
import { initializeApp, cert, getApps } from "firebase-admin/app"
import { getAuth } from "firebase-admin/auth"

const adminApp = getApps()[0] || initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
  }),
})

app.post("/api/auth/exchange", async (req, res) => {
  const { firebaseIdToken, state } = req.body

  // 1. Validar state (CSRF protection)
  if (!state || !stateCache.has(state)) {
    return res.status(400).json({ error: "invalid_state" })
  }
  stateCache.delete(state)

  // 2. Verificar Firebase ID token
  let decoded: FirebaseAuth.DecodedIdToken
  try {
    decoded = await getAuth(adminApp).verifyIdToken(firebaseIdToken)
  } catch {
    return res.status(401).json({ error: "invalid_firebase_token" })
  }

  // 3. Generar hivecode_token (JWT propio, 30 días)
  const hivecodeToken = await sign(
    {
      sub: decoded.uid,
      email: decoded.email,
      iat: Math.floor(Date.now() / 1000),
    },
    process.env.HIVECODE_JWT_SECRET!,
    { expiresIn: "30d" }
  )

  return res.json({
    hivecodeToken,
    firebaseUid: decoded.uid,
    email: decoded.email,
    expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
  })
})
```

### 2.3 `POST /v1/chat/completions` (OpenAI-compatible, PROXY a NVIDIA)

**Descripción**: Este es el endpoint que hivecode llama cuando usa el provider
`hivecode-free`. Debe ser **idéntico al spec de OpenAI** (`/v1/chat/completions`)
pero internamente llama a NVIDIA con tu `NVIDIA_API_KEY` server-side.

**Headers requeridos**:
```
Authorization: Bearer <hivecode_token>
Content-Type: application/json
```

**Body**: idéntico a OpenAI / NVIDIA NIM:
```json
{
  "model": "moonshotai/kimi-k2.6",
  "messages": [{"role": "user", "content": "..."}],
  "temperature": 0.7,
  "max_tokens": 4096,
  "stream": false
}
```

**Validación que tu backend debe hacer**:

1. **Auth**: `verify(hivecodeToken, JWT_SECRET)` — si falla, 401.
2. **Cap check**: lee `usage_records` (o equivalente) para `(firebaseUid, today)`.
   Si excede el cap → 429 con:
   ```json
   {
     "error": "free_tier_cap_exceeded",
     "used": 12345,
     "cap": 50000,
     "resetsAt": "2026-06-04T00:00:00Z"
   }
   ```
3. **Allowlist de modelos**: solo permite los 7 modelos del free tier (rechaza
   cualquier otro `model` con 400 `model_not_in_free_tier`).
4. **Llamada upstream** a NVIDIA con `NVIDIA_API_KEY`:
   ```ts
   const upstream = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
     method: "POST",
     headers: {
       "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`,
       "Content-Type": "application/json",
     },
     body: JSON.stringify({ ...body, model: stripProviderPrefix(body.model) }),
   })
   ```
5. **Contabiliza tokens** en tu BD:
   ```sql
   INSERT INTO usage_records (user_id, provider, model, input_tokens, output_tokens, created_at)
   VALUES (?, 'hivecode-free', ?, ?, ?, unixepoch())
   ```
6. **Devuelve la respuesta** de NVIDIA al cliente sin modificarla.

### 2.4 `GET /v1/models` (opcional, para listar modelos disponibles)

```json
{
  "object": "list",
  "data": [
    {"id": "moonshotai/kimi-k2.6", "object": "model", "owned_by": "moonshotai"},
    {"id": "qwen/qwen3-coder-480b-a35b-instruct", "object": "model", "owned_by": "qwen"},
    ...
  ]
}
```

## 3. Variables de entorno que tu backend necesita

```bash
# Firebase Admin SDK (para verificar ID tokens)
FIREBASE_PROJECT_ID=tu-proyecto
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxx@tu-proyecto.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# JWT signing para hivecode_token
HIVECODE_JWT_SECRET=<random-256-bit-secret>

# NVIDIA NIM (server-side)
NVIDIA_API_KEY=nvapi-XXXX
```

## 4. CORS

Tu backend debe permitir CORS desde:
- El dashboard web que use Firebase Auth.
- El cliente hivecode NO hace CORS (es server-to-server vía fetch desde Node).

## 5. Rate limits sugeridos

| Capa | Límite |
|---|---|
| `/auth/exchange` | 10 req/min por IP (evita brute force de state) |
| `/v1/chat/completions` | 60 req/min por `firebaseUid` (evita abuse) |
| Cap diario free | 50,000 tokens/día por `firebaseUid` (configurable) |

## 6. Diagrama de secuencia completo

```
Usuario            hivecode (TUI)         API operador         Firebase         NVIDIA
  │                      │                     │                  │               │
  │ /auth                │                     │                  │               │
  ├─────────────────────►│                     │                  │               │
  │                      │ genera state="X"    │                  │               │
  │                      │ levanta http://127.0.0.1:8923           │               │
  │                      │ abre browser ────────┼──────────────────►               │
  │                      │ GET /auth/cli?state=X                    │               │
  │                      │                     │◄─────────────────┤               │
  │                      │                     │                  │               │
  │ ◄─── browser ────────┤                     │ FirebaseUI login │               │
  │      login Google    │                     │                  │               │
  │                      │                     │ idToken + state=X                │
  │                      │                     │ POST /api/auth/exchange           │
  │                      │                     │ verifyIdToken() ─►│               │
  │                      │                     │◄─────────────────┤               │
  │                      │                     │ sign hivecodeToken                │
  │                      │                     │ (30d, contiene firebaseUid)        │
  │                      │ ◄───────────────────┤                  │               │
  │                      │ 302 → 127.0.0.1:8923/callback?token=...               │
  │ ◄─── browser ────────┤                     │                  │               │
  │      redirect        │                     │                  │               │
  │                      │ ◄─ POST /v1/chat/completions            │               │
  │                      │    Authorization: Bearer <hivecode>     │               │
  │                      │                     │ verify JWT        │               │
  │                      │                     │ cap check OK      │               │
  │                      │                     │ llama NVIDIA ────────────────────►
  │                      │                     │ ◄─────────────────────────────────┤
  │                      │                     │ record usage                     │
  │                      │ ◄─── response ──────┤                  │               │
  │ ◄─── muestra ────────┤                     │                  │               │
  │      resultado       │                     │                  │               │
  │                      │ guarda en Bun.secrets ("hive-cli-auth")                │
  │                      │                     │                  │               │
```

## 7. Lo que hivecode hace (cliente) — TL;DR

1. Usuario teclea `/auth` (o `hivecode login`).
2. hivecode genera un `state` random, levanta un HTTP server en `127.0.0.1:8923`.
3. Abre el navegador en `https://api.tu-dominio.com/auth/cli?state=XXX`.
4. Usuario hace login con Google/email en tu web.
5. Tu web redirige a `http://127.0.0.1:8923/callback?token=YYY&state=XXX`.
6. hivecode captura el token, lo guarda en `Bun.secrets` bajo el key
   `hive-cli-auth`, mata el server local, listo.
7. A partir de ahí, cada llamada a `hivecode-free` lleva
   `Authorization: Bearer <token>` a tu API.
