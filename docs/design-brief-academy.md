# Brief de identidad visual (OrysLabs Academy) para propuestas de UI de OrysLabsMural

## Qué es OrysLabsMural

Pizarra colaborativa autohospedada (clon didáctico de Mural) para dictar clases de la Academy. ~25 alumnos, clase arranca fines de agosto 2026. Sin fines comerciales.

Alcance día 1: login, panel de profe (crear/listar/asignar/congelar/borrar boards), canvas colaborativo en tiempo real con presencia, persistencia, exportar. Stack: Excalidraw + Yjs + Next.js + PostgreSQL/Drizzle, Docker Compose + Caddy.

**Necesita:** propuestas visuales para navbar/shell, panel de profe (dashboard de boards), estados del canvas (activo/congelado/solo-lectura), y presencia de usuarios — no el canvas de Excalidraw en sí (ese trae su propio look), sino todo el chrome alrededor.

## Identidad a seguir: OrysLabs Academy ("Minimal"), no el brandbook maestro

Oryslabs tiene dos sistemas visuales activos y son distintos entre sí (no variantes del mismo). Este proyecto usa el de **Academy**, porque Mural es una herramienta educativa para el mismo público que ya usa AiHub/Academy — coherencia de marca para el alumno.

Fuente completa: `AiHub/docs/design_handoff_minimal/README.md` (repo AiHub) — es el handoff real que ya está en producción en `aihub.oryslabs.com`. Fidelidad alta, tokens abajo son la fuente de verdad copiada de ahí.

### Principio de forma
- **Esquinas afiladas**: `border-radius` 0–3px en todo (inputs, tarjetas, botones, chips).
- **Sin sombras.** Jerarquía por bordes (`outline-variant`) y superficies, nunca por elevación/blur.
- Grids/listas separadas por líneas de 1px, no tarjetas flotantes.
- Hover = cambio de fondo a `surface-container`, sin elevación.

### Tipografía
- **Space Grotesk** (500/600/700) — títulos, UI display. Es la que da personalidad.
- **Inter** (400/500/600) — cuerpo, texto de interfaz.
- **JetBrains Mono** (400/500/600) — micro-etiquetas, metadata, kickers, timestamps, conteos. Mayúsculas con `letter-spacing: 0.1–0.16em`, nunca mayúsculas en Inter para texto largo.

### Color — LIGHT (modo protagonista, usar como default)
| Token | Hex | Uso |
|---|---|---|
| `primary` (chartreuse puro) | `#a3e635` | Solo bloques sólidos pequeños / fondos — logo, punto de acento, franjas |
| `primary-dim` | `#84cc16` | Hover del acento sólido |
| `primary-container` | `#e6f3c9` | Fondo suave de acento (badges, estado activo) |
| `primary-text` (**nunca uses el chartreuse puro como texto**) | `#4d7c0f` | Enlaces, kickers, números de acento |
| `surface` | `#f6f7f3` | Fondo de página |
| `surface-container` | `#eef0e6` | Tarjetas, inputs, hover |
| `on-surface` | `#12141f` | Texto principal (índigo casi negro) |
| `on-surface-variant` | `#5a6150` | Texto secundario |
| `outline` | `#12141f` | Bordes fuertes (tinta) |
| `outline-variant` | `#dcded1` | Bordes/divisores sutiles (la mayoría) |

### Color — DARK (fiel a Oryslabs: índigo + chartreuse)
| Token | Hex | Uso |
|---|---|---|
| `primary` / `primary-text` | `#a3e635` | Acento — en dark SÍ funciona como texto |
| `primary-dim` | `#84cc16` | Hover |
| `primary-container` | `#1f2a12` | Fondo suave de acento |
| `surface` | `#0c0e1f` | Índigo profundo — fondo de página |
| `surface-container` | `#14173a` | Tarjetas, inputs, hover |
| `on-surface` | `#eaf5e4` | Texto principal |
| `on-surface-variant` | `#9aa48f` | Texto secundario |
| `outline` | `#eaf5e4` | Bordes fuertes |
| `outline-variant` | `#242a52` | Bordes/divisores sutiles |

**Regla de contraste crítica**: en light, chartreuse puro (`#a3e635`) solo va en sólidos/fondos, nunca como color de texto (usar `#4d7c0f`, que sí cumple AA). En dark sí se puede usar el chartreuse puro también como texto.

### Consideración específica para Mural (no estaba en el handoff de AiHub, es una extensión razonable a proponerle al agente)
- El **canvas de Excalidraw** trae su propio fondo (blanco/gris claro por defecto) — no forzar los tokens de Academy dentro del canvas mismo, solo en el chrome (navbar, sidebar de herramientas del profe, modales, tarjetas de boards).
- Estados del board (activo / congelado / solo-lectura) necesitan tratamiento visual claro y distinto — candidato natural: usar los colores semánticos ya definidos en el ecosistema (ok/warn/alert del brandbook maestro, no del handoff Academy, que no define semánticos propios) o resolverlo con `primary-container` + iconografía, a criterio del agente.
- Presencia de usuarios (cursores/avatares de alumnos en tiempo real) es un patrón nuevo que ni el brandbook ni el handoff de Academy cubren — pedirle a Claude Design una propuesta ahí usando el acento chartreuse para "usuario activo".

## Referencias para el agente
1. Este documento.
2. `AiHub/docs/design_handoff_minimal/README.md` (repo AiHub) — referencia con más detalle de layout de ejemplo; es de un hub de artículos, no de un panel de profe, así que sirve para el tono/forma, no para el layout literal.
3. `AiHub/docs/design_handoff_minimal/AI Hub Minimal.dc.html` (repo AiHub) — prototipo visual navegable del sistema Minimal, útil para ver los tokens aplicados en la práctica.
