---
name: cierre-de-integracion
description: Procedimiento para mergear a main un backlog de piezas de trabajo ya cerradas (migraciones, fixes, features) que se acumularon sin integrar. Se invoca cuando CLAUDE.md §1 regla 13 dispara el checkpoint (más de 2 piezas cerradas y sin mergear al mismo tiempo), o cuando el titular pide explícitamente poner al día el estado de las ramas contra main.
---

# Cierre de integración

> Este documento es el procedimiento. El disparador (cuándo invocarlo) vive en
> `CLAUDE.md` §1 regla 13 — no se duplica acá. Esto describe el CÓMO, paso a paso, tal
> como se ejecutó en la práctica en la sesión del 15/16 de septiembre de 2026, que
> encontró cada uno de estos pasos por necesidad real, no por diseño previo.

## Por qué existe

Esa sesión acumuló siete piezas grandes de trabajo (PR1 de auth, dos migraciones de
R44, el fix de un bug de integridad, una guarda de negocio nueva, un bump de versión de
motor, un fix de CI, y un backend genérico con su fusión) — todas cerradas, revisadas,
verificadas, **pero sin mergear a `main`** durante horas. Reconstruir qué tenía cada
rama, qué drift había respecto de lo aprobado, y en qué orden mergear sin perder ni
mezclar nada de más, costó una sesión entera dedicada solo a eso. Este procedimiento es
el resultado de esa reconstrucción, para que la próxima vez no haga falta repetirla
desde cero.

## Los 10 pasos

### 1. Inventario completo de ramas

`git branch -a` (locales y remotas). Para cada rama que no sea `main`:
`git log main..<rama> --oneline` (qué commits trae de más) y
`git diff --stat main...<rama>` (qué archivos toca en total). No asumir por el nombre
de la rama qué contiene — leer el log real. Una rama de "documentación" puede traer
migraciones de esquema si se apiló sin declarar la base (`CLAUDE.md` §1 regla 11).

### 2. Verificación de drift byte a byte contra cualquier aprobación anterior

Si una pieza ya fue aprobada en algún momento previo (una migración revisada "ayer", un
PR con su propio ciclo de review), confirmar que el estado actual de esa rama para cada
archivo tocado es **byte a byte idéntico** a como quedó en el momento de la aprobación
(`git diff <commit-aprobado> <tip-actual> -- <archivo>`, vacío = sin drift). Nunca
asumir que "no se tocó nada más" — mostrar el diff, aunque sea vacío, antes de seguir.
Si hay cualquier diferencia, por mínima que sea, mostrarla explícita antes de continuar.

### 3. Detectar companion code y trabajo suelto no listado

Antes de aislar una pieza, buscar:
- Archivos que se romperían si la pieza se aplica sola (fixtures compartidos que
  dependen de una migración, un helper de test que otro archivo asume presente).
- Working tree sucio (`git status --short`) — cualquier cosa modificada o sin trackear
  que no sea parte de la tarea en curso.
- `git stash list` **siempre**, aunque no se lo esté buscando a propósito — un stash
  olvidado de horas antes puede tener contenido que se creía perdido o commiteado.

Si aparece algo no listado explícitamente por quien pidió el cierre, mostrarlo y
preguntar si se incluye — no decidirlo por cuenta propia ni descartarlo en silencio.

### 4. Aislar sobre `main` actual

Crear la rama nueva **desde `main`**, nunca desde otra rama de trabajo (`CLAUDE.md` §1
regla 11). Cherry-pick de los commits reales de la pieza. Si un archivo ya existe en
`main` con contenido distinto al que asumía el commit original, resolver el conflicto a
mano — nunca forzar un lado completo sin leer el otro. Verificar en cada resolución que
no queden referencias colgadas a contenido que dependía de una pieza distinta, todavía
no mergeada (una sección de documento que cita otra sección que no está, un import a un
archivo que no existe en este árbol).

### 5. Si toca esquema o RLS: reset de Postgres local desde cero antes de aplicar

`docker compose stop postgres && docker compose rm -f postgres && docker volume rm
<volumen>` seguido de `pnpm db:up && pnpm db:migrate && pnpm db:setup`. Nunca confiar en
que la base local ya está "en el estado correcto" porque se migró en algún momento
anterior de la sesión — otra pieza puede haber agregado migraciones que esta pieza no
debería ver, o viceversa. Verificar con `pnpm db:migrate -- --estado` que lo aplicado
coincide exacto con lo que esta rama espera.

### 6. Verificación en vivo

Correr las mutaciones de todos los ejes que correspondan a la pieza (cada policy nueva,
cada regla de autoría, cada invariante). Si la pieza introduce o depende de un
mecanismo de seguridad nuevo (una columna que corta acceso, una capacidad nueva),
verificar con una prueba puntual que el corte funciona de verdad — no alcanza con que
el grant exista (`CLAUDE.md` §1.8: sin prueba real, la regla no cuenta como control).
Si el rechazo no da el código de error que se esperaba, no asumir que la prueba está
mal — verificar la cadena real (qué función llama a qué, qué policy evalúa qué) antes
de ajustar la aserción.

### 7. Suite completa contra el baseline vigente

Releer el número de rojos preexistentes de `HANDOFF.md` (la entrada más reciente que lo
mencione), **nunca de memoria de lo que se viene repitiendo en la sesión**. Si otra
pieza ya mergeada cambió ese número (por ejemplo, cerró uno de los rojos
preexistentes), el nuevo baseline es ese, no el de antes (`CLAUDE.md` §1 regla 10). Si
la suite da un número inesperado, sospechar primero de un problema de entorno (base de
datos en un estado que no corresponde a esta rama, un proceso de test anterior sin
terminar) antes de asumir una regresión real — confirmar con un reset limpio si hace
falta.

### 8. Mostrar el diff completo y esperar autorización explícita

`git diff --stat` primero, para que quien autoriza vea de un vistazo qué archivos
entran. Si lo pide, el diff completo (no solo `--stat`) a un archivo de texto para
revisión offline. **No mergear todavía** — la autorización de merge se pide en este
paso, explícita, no se asume por haber llegado hasta acá (`CLAUDE.md` §1 regla 10: la
aprobación de contenido y la autorización de merge van juntas, pero las dos son
explícitas).

### 9. Mergear y verificar con hash

Una vez autorizado: mergear a `main`. Confirmar el resultado con
`git diff --stat <main-antes> main` (después del merge) — no alcanza con que el
comando no haya dado error. El diff post-merge tiene que coincidir exactamente con el
que se mostró en el paso 8.

### 10. Limpieza final

Para cada rama candidata a borrar: verificar por **contenido completo**, no solo por
ancestría (`git merge-base --is-ancestor` puede dar negativo aunque el contenido ya
esté todo en `main`, si se aisló por cherry-pick en vez de merge literal — comparar con
`git diff <rama> main` y confirmar que las líneas que aparecen como "distintas" son
texto ya superado a propósito, no algo único perdido). Borrar solo las confirmadas sin
nada único. Actualizar el baseline en `HANDOFF.md` si cambió. Pushear `main` a
`origin`. Confirmar `git rev-parse main` == `git rev-parse origin/main` — hash contra
hash, no "el push no dio error".
