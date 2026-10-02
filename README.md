# Visor C4 · Advanced Repayment Example

Aplicación web (Vite + React + TypeScript) que **lee un `workspace.dsl` de Structurizr y renderiza los diagramas C4 directamente en el navegador** — sin exportar PNG ni depender de herramientas externas.

Este proyecto se distribuye bajo licencia [MIT](./LICENSE) y está preparado para
uso local o self-hosted. La integración de Sign in with ChatGPT está destinada
al flujo de aplicaciones open source descrito en la documentación de OpenAI.

> Este repo es la **herramienta visual**. El modelo (`workspace.dsl`) vive en un proyecto aparte: `../example-model`.

## Requisitos

- Node.js 20+ y pnpm
- El proyecto del modelo en `../example-model` (o define `MODEL_DIR`)

## Uso

```bash
pnpm install
pnpm dev      # http://localhost:5173
```

Build de producción:

```bash
pnpm build    # genera dist/
pnpm preview  # sirve dist/ localmente
```

## Cómo lee el DSL

1. `scripts/sync-model.mjs` copia `workspace.dsl` del proyecto del modelo a `public/model/workspace.dsl` (corre en `predev` / `prebuild`).
2. La app lo descarga, lo **parsea** (`src/dsl/parse.ts`) y genera el diagrama Mermaid de cada vista (`src/dsl/mermaid.ts`), que se renderiza como SVG (`src/diagram/Mermaid.tsx`).

Ruta del modelo: `MODEL_DIR` → `../example-model`.

```bash
MODEL_DIR=/ruta/al/modelo pnpm dev
```

### Chat IA con Sign in with ChatGPT

El chat puede usar el plan de ChatGPT mediante el flujo oficial **Sign in with ChatGPT**. Esta integración funciona con el servidor Node local (`pnpm start`), no con `pnpm dev`/Pages estático, porque los tokens OAuth deben permanecer en el backend.

1. Solicita/crea el cliente dinámico siguiendo la [documentación oficial de OpenAI](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).
2. Define un identificador estable por instalación y arranca el servidor:

```bash
export OPENAI_SIWC_HOST_ID=urn:uuid:REEMPLAZAR-CON-UN-UUID
export OPENAI_SIWC_AGENT_NAME="C4 Architecture Viewer"
pnpm build
pnpm start
```

3. Abre `http://127.0.0.1:4173`, abre el asistente y pulsa **Continuar con ChatGPT**. El callback por defecto es `http://127.0.0.1:4173/auth/chatgpt/callback`; se puede cambiar con `OPENAI_SIWC_REDIRECT_URI`.

El servidor valida `state`, PKCE, nonce, firma/issuer/audience del ID token y el permiso `chatgpt.tokens.use.direct`. Los access/refresh tokens nunca llegan al navegador ni se guardan en el repositorio. La clave de API de OpenCode sigue disponible como alternativa.

> Structurizr no publica un paquete npm para renderizar un `.dsl` directamente: su render oficial es la app Java (Lite / on-premises, vía Docker). Este visor lo hace en el cliente con el parser propio.

### Cargar un DSL

La app arranca **vacía**. Tienes dos formas de cargar un modelo:

- **Cargar DSL** (barra superior): selecciona cualquier `.dsl` y se renderiza al instante, todo en el navegador.
- **Abrir modelo DEMO**: carga el `workspace.dsl` del proyecto (`public/model/`).

Lo que cargues se guarda en `localStorage`, así que al volver a abrir la app se restaura automáticamente. El botón ✕ en la barra superior quita el modelo y vuelve al estado vacío.

### Enlaces directos

Cada vista se refleja en la URL: `?view=L2_Advanced_Repayment`.

## Cobertura del DSL

Soporta `workspace`, `model` con `person` / `softwareSystem` / `container` / `component`, `group`, relaciones (incluidas las asignadas), `tags`, `properties` y las vistas `systemContext`, `container`, `component` y `dynamic` con `include` / `exclude` / `title`. Aplica los estilos del bloque `styles` (por tag: color, fondo, stroke y forma).

### Arquitectura por capas

El visor genera automáticamente una vista L2 por capas a partir de los `group`, `tags`, sistemas padre y relaciones del DSL. La clasificación se puede controlar explícitamente desde cualquier elemento:

```dsl
properties {
    "architecture.layer" "contract"
}
```

Valores disponibles: `channels`, `contract`, `domain`, `integration`, `core` y `platform`. También se admite un tag como `Layer:Core`. Sin override, el visor infiere la capa usando convenciones como `Business (SD)`, `System (SYS)`, `API`, `Core`, `External` y `Legacy`.

El índice ofrece dos representaciones del mismo modelo:

- **Arquitectura por capas:** grafo Mermaid con la composición visual compacta, estilos declarados en el DSL, nombres de `group`, descripciones completas y acciones reales de las relaciones (`invoke:sync`, `put message`, `subscribe to`, etc.). Las APIs con componentes de contrato dentro de sistemas externos o core se expanden para mostrar cada destino real en lugar de proyectar todas las llamadas sobre el contenedor padre. Los componentes de API de Transact muestran literalmente su propiedad `endpoint`/`endpoints`. Las propiedades explícitas `action` y `relationship.action` tienen prioridad; solo si faltan se muestra literalmente la descripción de la relación.
- **Arquitectura por bandas:** SVG de presentación que consolida por el último segmento de `group` (o el sistema padre) y ordena consumidores o canales antes de `Process (PROC)`, `Business (SD)` y `System (SYS)`. Los consumidores se dibujan como bandas completas. Dentro de SD y SYS, las APIs rectangulares ocupan la fila superior, los micros hexagonales relacionados se ubican debajo y hasta dos tópicos se colocan en sus costados; los excedentes generan filas adicionales. Los grupos `Service Domain - …` se representan como elementos auxiliares compactos al costado de la banda con la que realmente se relacionan, sin convertirlos en una capa adicional. Los tópicos usan forma recortada y paleta ámbar; los `dead-letter`, paleta roja. Muestra descripciones completas y reserva espacio propio para eventos.
- Cualquier elemento con el tag `New` muestra un badge amarillo **New** en la esquina superior derecha de su caja, sin cambiar su forma ni agregar iconos.

Utilidad para inspeccionar la conversión:

```bash
pnpm dump ../example-model/workspace.dsl /tmp/mmd
```

## Atajos de teclado

| Tecla | Acción |
| --- | --- |
| `←` `→` / `↑` `↓` | Vista anterior / siguiente |
| `+` `-` | Zoom |
| `0` | Ajustar a pantalla |
| `f` | Modo enfoque (oculta paneles) |
| `Mayús` + `f` | Pantalla completa del canvas |
| `/` | Buscar |

### Navegación del canvas

- **Rueda del ratón:** zoom continuo bajo el cursor.
- **Dos dedos en el trackpad:** desplaza el lienzo; pellizcar controla el zoom.
- **Arrastrar:** desplaza el lienzo en cualquier dirección.
- **Pellizcar con dos dedos:** zoom y desplazamiento táctil.
- **Doble clic:** acerca; `Mayús` + doble clic aleja.
- **Ajustar / `0`:** recupera el diagrama completo si se pierde el encuadre.

## Estructura

```
.
├─ index.html
├─ scripts/
│  ├─ sync-model.mjs        # copia workspace.dsl
│  └─ dump-mermaid.ts       # utilidad: DSL -> .mmd
├─ src/
│  ├─ App.tsx               # layout, navegación, ficha de vista
│  ├─ dsl/parse.ts          # parser del DSL de Structurizr
│  ├─ dsl/mermaid.ts        # DSL -> Mermaid (vistas, estilos, grupos)
│  ├─ diagram/Mermaid.tsx   # render SVG + estados
│  ├─ usePanZoom.ts         # zoom/pan del canvas
│  └─ App.css / index.css
└─ public/model/workspace.dsl
```
